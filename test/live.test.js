import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { liveQuotaStatus, runLive } from "../lib/live.js";
import { applyQuotaUpdate, ProviderReport } from "../lib/collect.js";
import { MIN_QUOTA_INTERVAL, QuotaCache } from "../lib/quota-cache.js";

function surface() {
  const events = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { columns: 120, rows: 40 });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, paused: true,
    isPaused() { return this.paused; },
    setRawMode(raw) { this.isRaw = raw; },
    resume() { this.paused = false; },
    pause() { this.paused = true; },
  });
  const output = [];
  stdout.write = (text) => { output.push(text); return true; };
  return { events, stdout, stdin, output };
}

test("live refreshes sequentially, and resize/scroll never trigger a data read", async () => {
  const ui = surface();
  let reads = 0, running = 0, maxRunning = 0, repainted = false;
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    if (text.includes("snapshot 1") && !repainted) {
      repainted = true;
      ui.stdout.emit("resize");
      ui.stdin.emit("data", Buffer.from("j"));
      assert.equal(reads, 1);
    }
    if (text.includes("snapshot 3")) ui.stdin.emit("data", Buffer.from("q"));
    return true;
  };
  await runLive({ ...ui, interval: 1,
    read: async () => {
      reads++; running++; maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 4));
      running--;
      return [{ snapshot: reads }];
    },
    renderFrame: ([value]) => `snapshot ${value.snapshot}\n`,
  });
  assert.equal(reads, 3);
  assert.equal(maxRunning, 1);
  assert.ok(ui.output[0].includes("\x1b[?1049h"));
  assert.ok(ui.output.at(-1).includes("\x1b[?25h\x1b[?1049l"));
  assert.equal(ui.stdin.isRaw, false);
  assert.equal(ui.stdin.paused, true);
  assert.equal(ui.stdout.listenerCount("resize"), 0);
  assert.equal(ui.stdin.listenerCount("data"), 0);
  assert.equal(ui.events.listenerCount("SIGINT"), 0);
});

test("short terminals show a scroll indicator and allow reading every row", async () => {
  const ui = surface();
  ui.stdout.rows = 6;
  let scrolled = false;
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    if (text.includes("row 0") && !scrolled) {
      scrolled = true;
      ui.stdin.emit("data", Buffer.from("\x1b[B"));
      ui.stdin.emit("data", Buffer.from("q"));
    }
    return true;
  };
  await runLive({ ...ui, read: async () => [], renderFrame: () => Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n") });
  const viewport = ui.output.find((text) => text.includes("↑↓ 2-5/10"));
  assert.ok(viewport);
  assert.ok(viewport.includes("row 4"));
  assert.ok(!viewport.includes("row 0"));
  assert.ok(viewport.split("\r\n").length < ui.stdout.rows);
});

test("SIGINT aborts an active read and restores the terminal", async () => {
  const ui = surface();
  let aborted = false;
  await runLive({ ...ui,
    read: (_, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve([]); }, { once: true });
      queueMicrotask(() => ui.events.emit("SIGINT"));
    }),
    renderFrame: () => "done",
  });
  assert.equal(aborted, true);
  assert.ok(ui.output.at(-1).includes("\x1b[?25h"));
  assert.equal(ui.events.listenerCount("SIGTERM"), 0);
});

test("an initially idle stdin is released on exit even when isPaused reports false", async () => {
  const ui = surface();
  ui.stdin.paused = false;
  ui.stdin.readableFlowing = null;
  await runLive({ ...ui,
    read: async () => { queueMicrotask(() => ui.events.emit("SIGINT")); return []; },
    renderFrame: () => "done",
  });
  assert.equal(ui.stdin.paused, true);
});

test("completed quota requests repaint immediately without another token read", async () => {
  const ui = surface();
  const changes = new EventEmitter();
  let reads = 0, sent = false, seen = false;
  const guard = setTimeout(() => ui.events.emit("SIGINT"), 500);
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    if (text.includes("usage 25/100") && !sent) {
      sent = true;
      queueMicrotask(() => changes.emit("quota", { name: "Claude", result: { plan: "pro", windows: [{ usedPercent: 40 }], error: null, skipped: false } }));
    }
    if (text.includes("usage 40/100")) { seen = true; ui.stdin.emit("data", Buffer.from("q")); }
    return true;
  };
  try {
    await runLive({ ...ui, interval: 60_000,
      read: async () => { reads++; return [new ProviderReport({ name: "Claude", windows: [{ usedPercent: 25 }], tokens: { today: 100 } })]; },
      subscribe: (listener) => { changes.on("quota", listener); return () => changes.removeListener("quota", listener); },
      applyUpdate: applyQuotaUpdate,
      renderFrame: ([report]) => `usage ${report.windows[0].usedPercent}/${report.tokens.today}\n`,
    });
    assert.equal(seen, true);
    assert.equal(reads, 1);
    assert.equal(changes.listenerCount("quota"), 0);
  } finally { clearTimeout(guard); }
});

test("a late log scan keeps new quota values and its newly collected tokens", async () => {
  const ui = surface();
  const changes = new EventEmitter();
  const frames = [];
  let reads = 0;
  const guard = setTimeout(() => ui.events.emit("SIGINT"), 500);
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    const usage = /usage (\d+\/\d+)/.exec(text)?.[1];
    if (usage) frames.push(usage);
    if (usage === "40/200") ui.stdin.emit("data", Buffer.from("q"));
    return true;
  };
  try {
    await runLive({ ...ui, interval: 1,
      read: async () => {
        const tokens = ++reads * 100;
        const old = [new ProviderReport({ name: "Claude", windows: [{ usedPercent: 25 }], tokens: { today: tokens } })];
        if (reads === 2) {
          await Promise.resolve();
          changes.emit("quota", { name: "Claude", result: { plan: "pro", windows: [{ usedPercent: 40 }], error: null, skipped: false } });
        }
        return old;
      },
      subscribe: (listener) => { changes.on("quota", listener); return () => changes.removeListener("quota", listener); },
      applyUpdate: applyQuotaUpdate,
      renderFrame: ([report]) => `usage ${report.windows[0].usedPercent}/${report.tokens.today}\n`,
    });
    assert.ok(frames.includes("40/100"));
    assert.ok(frames.includes("40/200"));
    assert.ok(!frames.includes("25/200"));
    assert.equal(reads, 2);
  } finally { clearTimeout(guard); }
});

test("the countdown redraws while token collection is idle and does not trigger another read", async () => {
  const ui = surface();
  let stamp = Date.now(), reads = 0, seen = false;
  const next = new Date(stamp + 600_000).toISOString();
  const guard = setTimeout(() => ui.events.emit("SIGINT"), 500);
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    if (text.includes("额度 10:00 后")) stamp += 1000;
    if (text.includes("额度 9:59 后")) { seen = true; ui.stdin.emit("data", Buffer.from("q")); }
    return true;
  };
  try {
    await runLive({ ...ui, interval: 60_000, repaintInterval: 1, now: () => new Date(stamp),
      read: async () => { reads++; return [{ quota: { status: "ok", next_refresh_at: next } }]; },
      renderFrame: () => "usage\n",
    });
    assert.equal(seen, true);
    assert.equal(reads, 1);
  } finally { clearTimeout(guard); }
  assert.equal(liveQuotaStatus([{ quota: { status: "updating" } }], new Date(stamp)), "额度更新中");
  assert.equal(liveQuotaStatus([], new Date(stamp), { offline: true }), "额度离线");
});

test("after fifteen minutes a blocked log scan cannot stop quota polling or snapshot repainting", async () => {
  const ui = surface();
  const directory = mkdtempSync(join(tmpdir(), "aiusage-live-quota-"));
  let stamp = Date.now(), reads = 0, quotaReads = 0, timer = null, seen = false;
  const cache = new QuotaCache({ directory, background: true, now: () => stamp, random: () => 0,
    setTimer: (callback, wait) => { timer = { callback, at: stamp + wait }; return 1; },
    clearTimer: () => { timer = null; },
  });
  const load = async () => ["pro", [{ usedPercent: ++quotaReads }]];
  await cache.get("Claude", load);
  await cache.drain();
  const initial = await cache.get("Claude", load);
  await cache.drain();
  const old = [new ProviderReport({ name: "Claude", ...initial, tokens: { today: 100 } })];
  const guard = setTimeout(() => ui.events.emit("SIGINT"), 500);
  const originalWrite = ui.stdout.write;
  ui.stdout.write = (text) => {
    originalWrite(text);
    if (text.includes("quota 2")) { seen = true; ui.stdin.emit("data", Buffer.from("q")); }
    return true;
  };
  try {
    await runLive({ ...ui, interval: 1,
      read: async (_, signal) => {
        if (++reads === 1) return old;
        const stopped = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        stamp += MIN_QUOTA_INTERVAL + 6 * 60_000;
        assert.ok(timer && timer.at <= stamp);
        await timer.callback();
        await stopped;
        return old;
      },
      subscribe: (listener) => cache.subscribe(listener), applyUpdate: applyQuotaUpdate,
      now: () => new Date(stamp), renderFrame: ([report]) => `quota ${report.windows[0].usedPercent}\n`,
    });
    assert.equal(seen, true);
    assert.equal(quotaReads, 2);
    assert.equal(reads, 2);
  } finally {
    clearTimeout(guard); cache.stop(); await cache.drain(); rmSync(directory, { recursive: true, force: true });
  }
});
