import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ProviderReport, Window, claudeUsageTotal } from "../lib/collect.js";
import { version } from "../lib/cli.js";
import { barText, displayWidth, formatTokens, render, shortModel } from "../lib/render.js";
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
  assert.deepEqual(buckets.totals(), {
    today: 10,
    days7: 30,
    days30: 60,
    models: [{ model: "未知", today: 10, days7: 30, days30: 60 }],
  });
});

test("token totals keep each model", () => {
  const now = new Date(2026, 9, 30, 9, 0, 0);
  const buckets = new TokenBuckets(now);
  buckets.add(now, 1_000_000, "claude-opus-5-5");
  buckets.add(now, 20_000, "claude-sonnet-4-6");
  const totals = buckets.totals();
  assert.equal(totals.today, 1_020_000);
  assert.deepEqual(
    totals.models.map((row) => row.model),
    ["claude-opus-5-5", "claude-sonnet-4-6"],
  );
});

test("large token counts use 万 and 亿", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(9999), "9,999");
  assert.equal(formatTokens(10000), "1万");
  assert.equal(formatTokens(3_527_818), "352.8万");
  assert.equal(formatTokens(1_661_061_805), "16.61亿");
  assert.equal(shortModel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(shortModel("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(shortModel("gpt-6.1-sol"), "GPT-6.1 Sol");
  assert.equal(shortModel("grok-4.7"), "Grok 4.7");
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
    tokens: {
      today: 2708431,
      days7: 1682104220,
      days30: 1987441009,
      models: [
        { model: "claude-opus-5-5", today: 2600000, days7: 1600000000, days30: 1900000000 },
        { model: "claude-sonnet-4-6", today: 108431, days7: 82104220, days30: 87441009 },
      ],
    },
  });
  const text = render([report], { color: false, now: new Date("2026-10-30T01:00:00Z") });
  assert.equal(text.includes("额度"), true);
  assert.equal(text.includes("Token"), true);
  assert.equal(text.includes("Opus 5.5"), true);
  assert.equal(text.includes("Sonnet 4.6"), true);
  assert.equal(text.includes("260万"), true);
  assert.equal(text.includes("16亿"), true);
  assert.equal(text.includes("2,708,431"), false);
  assert.equal(text.includes("7 天"), true);
  assert.match(text, /7 天\s+\[#+-+\]\s+84%\s+剩余\s+16%\s+重置 /);
  assert.equal(text.includes("│"), false);
  assert.equal(text.indexOf("额度") < text.indexOf("Token"), true);
});
