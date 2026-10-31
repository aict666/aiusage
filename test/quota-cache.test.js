import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectProviders } from "../lib/collect.js";
import { MIN_QUOTA_INTERVAL, QuotaCache } from "../lib/quota-cache.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aiusage-quota-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let stamp = Date.now();
  const options = { directory, now: () => stamp, random: () => 0 };
  return { directory, options, cache: new QuotaCache(options), advance: (ms) => { stamp += ms; } };
}

const result = () => ["pro", [{ label: "5 小时", usedPercent: 25, resetsAt: null }]];

test("local updates and relaunches reuse the same quota without shortening its cooldown", async (t) => {
  const { options, cache, advance } = fixture(t);
  let quotaReads = 0, tokenReads = 0;
  const providers = [["Claude", async () => { quotaReads++; return result(); }, async () => { tokenReads++; }]];
  for (let index = 0; index < 20; index++) {
    await collectProviders(providers, new Date(), null, { quotaCache: index % 2 ? cache : new QuotaCache(options) });
    advance(15_000);
  }
  assert.equal(quotaReads, 1);
  assert.equal(tokenReads, 20);
  advance(MIN_QUOTA_INTERVAL);
  await collectProviders(providers, new Date(), null, { quotaCache: cache });
  assert.equal(quotaReads, 2);
});

test("simultaneous instances share the reservation and never make duplicate requests", async (t) => {
  const { options, cache } = fixture(t);
  let release, reads = 0;
  const pending = cache.get("Claude", async () => { reads++; await new Promise((resolve) => { release = resolve; }); return result(); });
  const other = await new QuotaCache(options).get("Claude", async () => { reads++; return result(); });
  assert.equal(reads, 1);
  assert.equal(other.quota.status, "updating");
  release();
  assert.equal((await pending).windows[0].usedPercent, 25);
});

test("a slow quota endpoint never blocks local live updates or starts overlapping requests", async (t) => {
  const { options } = fixture(t);
  const cache = new QuotaCache({ ...options, background: true });
  t.after(() => cache.stop());
  let release, quotaReads = 0, tokenReads = 0;
  const providers = [["Claude", async () => {
    quotaReads++;
    await new Promise((resolve) => { release = resolve; });
    return result();
  }, async () => { tokenReads++; }]];
  const [pending] = await collectProviders(providers, new Date(), null, { quotaCache: cache });
  assert.equal(pending.quota.status, "updating");
  await collectProviders(providers, new Date(), null, { quotaCache: cache });
  assert.equal(tokenReads, 2);
  assert.equal(quotaReads, 1);
  release();
  await cache.drain();
  const [done] = await collectProviders(providers, new Date(), null, { quotaCache: cache });
  assert.equal(done.plan, "pro");
  assert.equal(quotaReads, 1);
});

function scheduler(options, advance) {
  const timers = new Map();
  let sequence = 0;
  return {
    timers,
    setTimer(callback, wait) {
      const key = ++sequence;
      timers.set(key, { at: options.now() + wait, callback });
      return key;
    },
    clearTimer(key) { timers.delete(key); },
    async elapse(ms) {
      advance(ms);
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= options.now());
      for (const [key, timer] of due) {
        timers.delete(key);
        await timer.callback();
      }
    },
  };
}

test("background quotas keep refreshing for multiple cycles without any further local reads", async (t) => {
  const { options, advance } = fixture(t);
  const clock = scheduler(options, advance);
  const cache = new QuotaCache({ ...options, ...clock, background: true });
  t.after(() => cache.stop());
  let reads = 0;
  const updates = [];
  cache.subscribe((change) => updates.push(change.result));
  await cache.get("Claude", async () => ["pro", [{ label: "5 小时", usedPercent: ++reads, resetsAt: null }]]);
  await cache.drain();
  assert.equal(reads, 1);
  await clock.elapse(MIN_QUOTA_INTERVAL - 1);
  assert.equal(reads, 1);
  await clock.elapse(1);
  assert.equal(reads, 2);
  assert.equal(updates.at(-1).windows[0].usedPercent, 2);
  await clock.elapse(MIN_QUOTA_INTERVAL);
  assert.equal(reads, 3);
  assert.equal(updates.at(-1).windows[0].usedPercent, 3);
  cache.stop();
  assert.equal(clock.timers.size, 0);
  await clock.elapse(MIN_QUOTA_INTERVAL);
  assert.equal(reads, 3);
});

test("the independent quota timer honors persisted throttling and never polls on a clock tick", async (t) => {
  const { options, advance } = fixture(t);
  const clock = scheduler(options, advance);
  const cache = new QuotaCache({ ...options, ...clock, background: true });
  t.after(() => cache.stop());
  let reads = 0;
  const load = async () => {
    reads++;
    if (reads > 1) throw Object.assign(new Error("HTTP 429"), { code: 429, retryAt: options.now() + 3600_000 });
    return result();
  };
  await cache.get("Claude", load);
  await cache.drain();
  await clock.elapse(MIN_QUOTA_INTERVAL);
  assert.equal(reads, 2);
  for (let index = 0; index < 100; index++) {
    await cache.get("Claude", load);
    await clock.elapse(15_000);
  }
  assert.equal(reads, 2);
  await clock.elapse(3600_000 - 100 * 15_000);
  assert.equal(reads, 3);
});

test("429 preserves good values, waits at least 30 minutes, and doubles after another failure", async (t) => {
  const { options, cache, advance } = fixture(t);
  await cache.get("Claude", result);
  advance(MIN_QUOTA_INTERVAL);
  let reads = 0;
  const limited = async () => { reads++; throw Object.assign(new Error("HTTP 429"), { code: 429, retryAt: options.now() }); };
  const first = await cache.get("Claude", limited);
  assert.equal(first.windows[0].usedPercent, 25);
  assert.equal(first.quota.status, "backoff");
  assert.equal(first.quota.cached, true);
  assert.equal(Date.parse(first.quota.next_refresh_at) - options.now(), 30 * 60_000);
  advance(29 * 60_000);
  await new QuotaCache(options).get("Claude", limited);
  assert.equal(reads, 1);
  advance(60_000);
  const second = await cache.get("Claude", limited);
  assert.equal(Date.parse(second.quota.next_refresh_at) - options.now(), 60 * 60_000);
  advance(60 * 60_000);
  const success = await cache.get("Claude", result);
  assert.equal(success.error, null);
  assert.equal(Date.parse(success.quota.next_refresh_at) - options.now(), MIN_QUOTA_INTERVAL);
});

test("Retry-After can extend the entire cooldown beyond the normal backoff cap", async (t) => {
  const { cache, options } = fixture(t);
  const retryAt = options.now() + 24 * 3600_000;
  const value = await cache.get("Claude", async () => { throw Object.assign(new Error("HTTP 429"), { code: 429, retryAt }); });
  assert.equal(Date.parse(value.quota.next_refresh_at), retryAt);
});

test("a rejected login is retried at most once per hour and cannot erase the previous quota", async (t) => {
  const { cache, options, advance } = fixture(t);
  await cache.get("Claude", result);
  advance(MIN_QUOTA_INTERVAL);
  const value = await cache.get("Claude", async () => { throw Object.assign(new Error("登录已过期"), { code: 401 }); });
  assert.equal(value.windows.length, 1);
  assert.equal(Date.parse(value.quota.next_refresh_at) - options.now(), 3600_000);
});

test("offline mode reads saved values but never calls the loader, even when stale or empty", async (t) => {
  const { options, cache, advance } = fixture(t);
  await cache.get("Claude", result);
  advance(86400_000);
  const offline = new QuotaCache({ ...options, offline: true });
  const never = () => assert.fail("offline must not read auth or the network");
  const saved = await offline.get("Claude", never);
  const empty = await offline.get("Codex", never);
  assert.equal(saved.windows[0].usedPercent, 25);
  assert.equal(saved.quota.status, "offline");
  assert.equal(empty.windows.length, 0);
});

test("failed cache I/O prevents network requests rather than bypassing the rate guard", async (t) => {
  const { directory } = fixture(t);
  const path = join(directory, "file");
  writeFileSync(path, "not a directory");
  const cache = new QuotaCache({ directory: path });
  const value = await cache.get("Claude", () => assert.fail("must fail closed"));
  assert.equal(value.quota.status, "cache-error");
});

test("jitter only slows the cadence and cached JSON contains no auth data", async (t) => {
  const { options, directory } = fixture(t);
  const cache = new QuotaCache({ ...options, random: () => 0.5 });
  const value = await cache.get("Claude", result, "secret-token-scope");
  assert.equal(Date.parse(value.quota.next_refresh_at) - options.now(), MIN_QUOTA_INTERVAL + 30_000);
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes("secret"));
  const text = readFileSync(join(directory, files[0]), "utf8");
  assert.ok(!text.includes("secret"));
  assert.throws(() => new QuotaCache({ interval: 599_000 }), /至少 600/);
});
