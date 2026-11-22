import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeResetCredits, codexResetCredits, parseGrokResetCredits, optionalResetCredits } from "../lib/reset-credits.js";
import { ProviderReport, Window, collectProviders } from "../lib/collect.js";
import { QuotaCache } from "../lib/quota-cache.js";
import { render, displayWidth } from "../lib/render.js";

const now = new Date('2026-11-12T00:00:00Z');
const expiry = '2026-12-01T20:15:06.000Z';
test('Claude holds limited-scope and currently unusable cards without counting expired or paused grants', () => {
  const base = { resets_left: 1, ends_at: expiry, usable_now: false };
  const result = claudeResetCredits({ cedar_ember: { grants: [base, { ...base, resets_left: 2 }, { ...base, paused: true }, { ...base, ends_at: '2020-01-01' }] } }, +now);
  assert.equal(result.count, 3);
  assert.equal(result.credits[0].expires_at, expiry);
  assert.equal(claudeResetCredits({ cedar_ember: { ineligible_reason: 'surface', grants: [] } }), null);
});
test('Codex preserves held versus applicable count and strips redemption identifiers', () => {
  const result = codexResetCredits({ available_count: 2, applicable_available_count: 0 }, { credits: [
    { id: 'secret', status: 'available', reset_type: 'codex_rate_limits', expires_at: expiry },
    { status: 'available', reset_type: 'codex_rate_limits' },
    { status: 'redeemed', expires_at: expiry },
    { status: 'available', reset_type: 'other_product', expires_at: expiry },
  ] }, +now);
  assert.equal(result.count, 2);
  assert.equal(result.applicable_count, 0);
  assert.equal(result.credits[1].expires_at, null);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(codexResetCredits(null).count, null);
});
function varint(value) {
  let n = BigInt(value); const out = [];
  do { const byte = Number(n & 127n); n >>= 7n; out.push(byte | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
const field = (n, value) => Buffer.concat([varint(n * 8 + 2), varint(value.length), value]);
const frame = (payload, flag = 0) => { const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1); return Buffer.concat([header, payload]); };
const token = (seconds) => field(10, Buffer.concat([field(10, Buffer.from('redemption-secret')), field(30, Buffer.concat([varint(8), varint(seconds)]))]));
test('Grok protobuf parses individual expiries and rejects failures and truncation', () => {
  const data = frame(Buffer.concat([token(Date.parse(expiry) / 1000), token(Date.parse(expiry) / 1000 + 3600)]));
  const ok = Buffer.concat([data, frame(Buffer.from('grpc-status:0\r\n'), 128)]);
  const result = parseGrokResetCredits(ok, +now);
  assert.equal(result.count, 2);
  assert.equal(result.credits[0].expires_at, expiry);
  assert.ok(!JSON.stringify(result).includes('redemption-secret'));
  assert.equal(parseGrokResetCredits(frame(Buffer.alloc(0))).count, 0);
  assert.throws(() => parseGrokResetCredits(Buffer.concat([data, frame(Buffer.from('grpc-status:16\r\n'), 128)])));
  for (const cut of [0, 3, data.length - 1]) assert.throws(() => parseGrokResetCredits(data.subarray(0, cut)));
});
test('optional detail failures preserve known counts without breaking quotas', async () => {
  const result = await optionalResetCredits(async () => { throw new Error('HTTP 403'); }, codexResetCredits({available_count: 2}));
  assert.equal(result.count, 2);
  assert.equal(result.error, 'HTTP 403');
});
test('reset inventory survives disk cache, ProviderReport and JSON serialization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aiusage-resets-'));
  try {
    const reset = { count: 2, credits: [{count: 2, expires_at: expiry}], error: null };
    const cache = new QuotaCache({directory});
    const [report] = await collectProviders([['Codex', async () => ['pro', [new Window('每周', 42, expiry)], reset], null]], now, null, {quotaCache: cache});
    assert.deepEqual(report.toJSON().reset_credits, reset);
    const offline = new QuotaCache({directory, offline: true});
    assert.deepEqual((await offline.get('Codex', () => {throw Error('must not fetch');})).resetCredits, reset);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test('reset cards display each expiry without overflowing narrow terminals', () => {
  const report = new ProviderReport({ name: 'Codex', plan: 'pro', windows: [new Window('每周', 42, expiry)], resetCredits: {count: 2, applicable_count: 0, credits: [{count: 1, expires_at: expiry}, {count: 1, expires_at: null}]} });
  for (const width of [40, 80, 140]) {
    const output = render([report], { now, color: false, width });
    assert.match(output, /重置卡 2 张/);
    assert.match(output, /当前适用 0 张/);
    assert.match(output, /到期时间未提供/);
    for (const line of output.split('\n')) assert.ok(displayWidth(line) <= width, line);
  }
});
