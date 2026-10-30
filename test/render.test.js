import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { ProviderReport, Window, claudeUsageTotal } from "../lib/collect.js";
import { version } from "../lib/cli.js";
import { demoReports } from "../lib/demo.js";
import { barText, displayWidth, formatCost, formatTokens, pad, render, shortModel, truncate } from "../lib/render.js";
import { TokenBuckets } from "../lib/time.js";

test("version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, pkg.version);
});

test("usage bars keep one width", () => {
  const low = barText(5);
  const high = barText(84);
  assert.equal(displayWidth(low), displayWidth(high));
  assert.equal(low.startsWith("━"), true);
  assert.equal(high.includes("%"), false);
  assert.equal(barText(-10), barText(0));
  assert.equal(barText(120), barText(100));
  assert.equal(barText(NaN), barText(null));
  assert.ok(barText(1, 8).startsWith("━"));
});

test("terminal widths handle CJK, line drawing, ANSI, and graphemes", () => {
  assert.equal(displayWidth("额度"), 4);
  assert.equal(displayWidth("━─·é"), 4);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("👩🏽‍💻"), 2);
  assert.equal(displayWidth("🇨🇳"), 2);
  assert.equal(displayWidth("\x1b[31m额度\x1b[0m"), 4);
  assert.equal(displayWidth(pad("\x1b[1mé\x1b[0m", 6)), 6);
  assert.equal(truncate("你好世界", 5), "你好…");
  assert.equal(truncate("👩🏽‍💻abc", 3), "👩🏽‍💻…");
});

test("longer token windows include today", () => {
  const now = new Date(2026, 9, 30, 9, 0, 0);
  const buckets = new TokenBuckets(now);
  buckets.add(new Date(now.getTime() - 3600000), 10);
  buckets.add(new Date(now.getTime() - 3 * 86400000), 20);
  buckets.add(new Date(now.getTime() - 10 * 86400000), 30);
  buckets.add(new Date(now.getTime() - 40 * 86400000), 40);
  const totals = buckets.totals();
  assert.deepEqual({ today: totals.today, days7: totals.days7, days30: totals.days30, models: totals.models.map(({ usage, ...row }) => row) }, {
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

test("large token counts use K, M, and B", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(3_527_818), "3.53M");
  assert.equal(formatTokens(11_716_325), "11.7M");
  assert.equal(formatTokens(1_661_061_805), "1.66B");
  assert.equal(formatTokens(999_999), "1M");
  assert.equal(formatTokens(999_999_999), "1B");
  assert.equal(formatTokens(NaN), "—");
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
  assert.equal(text.includes("2.6M"), true);
  assert.equal(text.includes("1.6B"), true);
  assert.equal(text.includes("2,708,431"), false);
  assert.equal(text.includes("7 天"), true);
  assert.match(text, /7 天\s+━+─+\s+84%\s+16%\s+\d{2}-\d{2}/);
  assert.equal(text.includes("│"), false);
  assert.equal(text.indexOf("额度") < text.indexOf("Token"), true);
});

test("wide output shares column headers and keeps numeric columns aligned", () => {
  const now = new Date(2026, 9, 30, 9);
  const text = render(demoReports(now), { now, width: 80 });
  const tokens = text.split("本机 Token")[1];
  assert.equal(tokens.match(/近 7 天/g)?.length, 1);
  assert.equal(tokens.match(/近 30 天/g)?.length, 1);
  const rows = tokens.split("\n").filter((line) => /Opus|Sonnet|GPT|Grok 4/.test(line));
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(displayWidth)).size, 1);
  assert.ok(text.split("\n").every((line) => displayWidth(line) <= 80));
});

test("colored output preserves the plain layout", () => {
  const now = new Date(2026, 9, 30, 9);
  for (const width of [24, 40, 60, 80, 120]) {
    const reports = demoReports(now);
    const plain = render(reports, { now, width });
    const colored = render(reports, { now, width, color: true });
    assert.equal(stripVTControlCharacters(colored), plain);
    assert.ok(colored.includes("\x1b[31m"), "high usage should be red");
    assert.ok(plain.split("\n").every((line) => displayWidth(line) <= width), `overflow at width ${width}`);
    for (const value of ["3.53M", "1.66B", "1.99B", "Sonnet 4.6", "GPT-6.1 Sol", "11.7M", "84%", "16%"]) {
      assert.ok(plain.includes(value), `missing ${value} at width ${width}`);
    }
  }
});

test("missing login, empty windows, and long errors stay readable", () => {
  const now = new Date(2026, 9, 30, 9);
  const reports = [
    new ProviderReport({ name: "Claude", skipped: true }),
    new ProviderReport({ name: "Codex", tokens: { today: 0, days7: 0, days30: 0 } }),
    new ProviderReport({ name: "Grok", error: "HTTP 503 " + "接口暂时不可用，请稍后重试。".repeat(12) }),
  ];
  for (const width of [24, 40, 60, 80, 120]) {
    const text = render(reports, { now, width });
    assert.match(text, /未登录/);
    assert.match(text, /暂无额度窗口/);
    assert.match(text, /HTTP\s+503/);
    assert.match(text, /—/);
    assert.ok(text.split("\n").every((line) => displayWidth(line) <= width), `overflow at width ${width}`);
    assert.equal(text.includes("NaN"), false);
  }
});

test("long names and model labels wrap without dropping their text", () => {
  const report = new ProviderReport({
    name: "自定义 Provider",
    plan: "very-long-plan-name-for-a-team-account",
    windows: [new Window("额外用量自定义窗口", null, null)],
    tokens: { models: [{ model: "custom-model-with-a-very-long-version-suffix", today: 12, days7: 13, days30: 14 }] },
  });
  for (const width of [24, 40, 80]) {
    const text = render([report], { width });
    assert.ok(text.split("\n").every((line) => displayWidth(line) <= width), `overflow at width ${width}`);
    assert.ok(text.replace(/\s/g, "").includes(report.tokens.models[0].model));
  }
});

test("no providers has a readable empty state", () => {
  const text = render([]);
  assert.match(text, /暂无服务数据/);
  assert.match(text, /暂无本机 Token 记录/);
  assert.equal(text.includes("Infinity"), false);
});

test("cache and USD cost rows are visible by default and details adds input/output", () => {
  const now = new Date(2026, 9, 30, 9);
  const reports = demoReports(now);
  for (const width of [24, 40, 52, 60, 80, 120]) {
    for (const details of [false, true]) {
      const text = render(reports, { now, width, details });
      assert.ok(/读缓存/u.test(text));
      assert.ok(/估算 USD/u.test(text));
      assert.ok(/\$\d/u.test(text));
      assert.ok(text.includes("非套餐扣费"));
      assert.ok(text.split("\n").every((line) => displayWidth(line) <= width), `overflow at ${width}, details=${details}`);
      if (details) assert.match(text, /未缓存/);
    }
  }
});

test("default output uses two rows per model without forcing a narrow layout", () => {
  const now = new Date(2026, 9, 30, 9);
  const reports = demoReports(now);
  const text = render(reports, { now, width: 180 });
  assert.ok(Math.max(...text.split("\n").map(displayWidth)) > 62);
  assert.ok(text.trimEnd().split("\n").length <= 24);
  assert.equal(text.includes("价格 2026-10-30"), false);
  assert.equal(text.includes("已知部分"), false);
  const tokens = text.split("本机 Token")[1].split("Token 含缓存")[0];
  assert.equal(tokens.includes("\n\n"), false);
  assert.match(tokens, /Opus 5\.5\s+3\.53M \/ \$4\.55/);
  assert.match(tokens, /缓存读\/写\s+3M \/ 353K/);
  const summaries = tokens.split("\n").filter((line) => /Opus|Sonnet|GPT|Grok 4/.test(line));
  const caches = tokens.split("\n").filter((line) => /读缓存|缓存读\/写/.test(line));
  assert.equal(summaries.length, 4);
  assert.equal(caches.length, 4);
  const codex = text.split("  Codex  ")[1].split("  Grok  ")[0];
  assert.equal(codex.includes("写缓存"), false);
  const detailed = render(reports, { now, width: 180, details: true });
  assert.ok(detailed.includes("写缓存"));
  assert.ok(detailed.includes("命中率"));
  assert.ok(detailed.includes("86.7%"));
  assert.ok(detailed.includes("今天 13:30"));
  assert.ok(detailed.trimEnd().split("\n").length > text.trimEnd().split("\n").length);
});

test("cache hit rate uses prompt tokens rather than total tokens", () => {
  const now = new Date();
  const buckets = new TokenBuckets(now, "Codex");
  buckets.add(now, 200, "gpt-6.1-sol", { total: 200, prompt_tokens: 100, input_tokens: 20, output_tokens: 100,
    cache_read_tokens: 80, cache_write_tokens: 0, cache_write_short_tokens: 0, cache_write_long_tokens: 0, unclassified_tokens: 0, valid: true });
  const report = new ProviderReport({ name: "Codex", tokens: buckets.totals() });
  const text = render([report], { details: true });
  assert.ok(text.includes("80.0%"));
  assert.equal(text.includes("40.0%"), false);
  buckets.add(now, 50, "gpt-6.1-sol");
  const partial = render([new ProviderReport({ name: "Codex", tokens: buckets.totals() })], { details: true });
  assert.equal(partial.includes("80.0%"), false);
  assert.ok(partial.includes("80+"));
});

test("unknown or partial estimates remain explicit instead of showing zero cost", () => {
  assert.equal(formatCost(null), "—");
  assert.equal(formatCost({ cost_usd: 0, priced_tokens: 0, unpriced_tokens: 100 }), "—");
  assert.equal(formatCost({ cost_usd: 2.5, priced_tokens: 1000, unpriced_tokens: 100 }), "$2.50+");
  assert.equal(formatCost({ cost_usd: 0.001, priced_tokens: 100, unpriced_tokens: 0 }), "<$0.01");
  assert.equal(formatCost({ cost_usd: 0, priced_tokens: 0, unpriced_tokens: 0 }), "$0.00");
});
