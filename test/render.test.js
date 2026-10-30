import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ProviderReport, Window, claudeUsageTotal } from "../lib/collect.js";
import { version } from "../lib/cli.js";
import { barText, displayWidth, render } from "../lib/render.js";
import { TokenBuckets } from "../lib/time.js";

test("version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, pkg.version);
});

test("usage bars keep one width", () => {
  const low = barText(5);
  const high = barText(84);
  assert.equal(displayWidth(low), displayWidth(high));
  assert.equal(low.startsWith("[#"), true);
  assert.equal(high.includes("%"), false);
});

test("longer token windows include today", () => {
  const now = new Date(2026, 9, 30, 9, 0, 0);
  const buckets = new TokenBuckets(now);
  buckets.add(new Date(now.getTime() - 3600000), 10);
  buckets.add(new Date(now.getTime() - 3 * 86400000), 20);
  buckets.add(new Date(now.getTime() - 10 * 86400000), 30);
  buckets.add(new Date(now.getTime() - 40 * 86400000), 40);
  assert.deepEqual(buckets.totals(), { today: 10, days7: 30, days30: 60 });
});

test("claude total counts cache once", () => {
  assert.equal(
    claudeUsageTotal({
      input_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 100 },
      cache_read_input_tokens: 50,
      output_tokens: 8,
    }),
    160,
  );
});

test("report splits quota and tokens", () => {
  const report = new ProviderReport({
    name: "Claude",
    plan: "pro",
    windows: [new Window("5 小时", 5, "2026-10-30T05:30:00Z"), new Window("7 天", 84, "2026-11-01T19:00:00Z")],
    tokens: { today: 2708431, days7: 1682104220, days30: 1987441009 },
  });
  const text = render([report], { color: false, now: new Date("2026-10-30T01:00:00Z") });
  assert.equal(text.includes("额度"), true);
  assert.equal(text.includes("Token"), true);
  assert.equal(text.includes("2,708,431"), true);
  assert.equal(text.includes("7 天"), true);
  assert.match(text, /7 天\s+\[#+-+\]\s+84%\s+剩余\s+16%\s+重置 /);
  assert.equal(text.includes("│"), false);
  assert.equal(text.indexOf("额度") < text.indexOf("Token"), true);
});
