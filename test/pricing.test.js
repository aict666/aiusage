import assert from "node:assert/strict";
import test from "node:test";
import { estimateCost, modelPrice } from "../lib/pricing.js";
import { claudeUsage, codexUsage, grokUsage } from "../lib/usage.js";
import { TokenBuckets } from "../lib/time.js";

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

test("Claude separately prices ordinary input, cache reads, and both write lifetimes", () => {
  const usage = claudeUsage({
    input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  });
  assert.equal(usage.total, 5_000_000);
  near(estimateCost("Claude", "claude-opus-5-5", usage).usd, 37.2);
});

test("Claude nested cache totals are counted once, including zero aggregate snapshots", () => {
  const usage = claudeUsage({ input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 50,
    cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 100 } });
  assert.equal(usage.total, 160);
  assert.equal(usage.cache_write_tokens, 100);
  assert.equal(usage.cache_write_short_tokens, 100);
  assert.equal(usage.cache_write_long_tokens, 0);
});

test("Codex cache reads and writes are subsets of input and reasoning is a subset of output", () => {
  const usage = codexUsage({ input_tokens: 12_000, output_tokens: 1_000, total_tokens: 13_000, reasoning_output_tokens: 900,
    input_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 7_000,
      cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 } } });
  assert.equal(usage.total, 13_000);
  assert.equal(usage.input_tokens, 1_000);
  assert.equal(usage.output_tokens, 1_000);
  assert.equal(usage.cache_write_tokens, 7_000);
  near(estimateCost("Codex", "gpt-6.1-sol", usage).usd, 0.0399);
});

test("Grok splits cached prompt input without inflating its token total", () => {
  const usage = grokUsage({ prompt_tokens: 100_000, cached_prompt_tokens: 80_000, completion_tokens: 10_000, reasoning_tokens: 6_000 });
  assert.equal(usage.total, 110_000);
  assert.equal(usage.input_tokens, 20_000);
  assert.equal(usage.output_tokens, 10_000);
  assert.equal(usage.cache_write_tokens, 0);
  near(estimateCost("Grok", "grok-4.7", usage).usd, 0.14);
});

test("long-context thresholds are applied per request and include cached prompt tokens", () => {
  const short = codexUsage({ input_tokens: 272_000, cached_input_tokens: 0, output_tokens: 1_000 });
  const long = codexUsage({ input_tokens: 272_001, cached_input_tokens: 0, output_tokens: 1_000 });
  near(estimateCost("Codex", "gpt-6.1-sol", short).usd, 0.554);
  near(estimateCost("Codex", "gpt-6.1-sol", long).usd, 1.103004);
  near(estimateCost("Codex", "gpt-6.1-sol", codexUsage({ input_tokens: 300_000, cached_input_tokens: 200_000, output_tokens: 1_000 })).usd, 0.455);
  near(estimateCost("Grok", "grok-4.7", grokUsage({ prompt_tokens: 199_999, cached_prompt_tokens: 199_999, completion_tokens: 0 })).usd, 0.0999995);
  near(estimateCost("Grok", "grok-4.7", grokUsage({ prompt_tokens: 200_000, cached_prompt_tokens: 200_000, completion_tokens: 0 })).usd, 0.2);
});

test("aggregation never applies a long-context surcharge to monthly token totals", () => {
  const now = new Date(2026, 9, 30, 12);
  const buckets = new TokenBuckets(now, "Codex");
  const usage = codexUsage({ input_tokens: 150_000, cached_input_tokens: 0, output_tokens: 0 });
  buckets.add(now, usage.total, "gpt-6.1-sol", usage);
  buckets.add(now, usage.total, "gpt-6.1-sol", usage);
  assert.equal(buckets.totals().today, 300_000);
  near(buckets.totals().usage.today.cost_usd, 0.6);
});

test("missing cache lifetime or usage fields does not produce a guessed cost", () => {
  const unknownLifetime = claudeUsage({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 });
  assert.equal(estimateCost("Claude", "claude-opus-5-5", unknownLifetime).reason, "unknown_cache_write_lifetime");
  const missingCache = grokUsage({ prompt_tokens: 100, completion_tokens: 10 });
  assert.equal(missingCache.cache_read_tokens, null);
  assert.equal(estimateCost("Grok", "grok-4.7", missingCache).usd, null);
  const legacy = codexUsage({ total_tokens: 250 });
  assert.equal(legacy.total, 250);
  assert.equal(legacy.unclassified_tokens, 250);
  assert.equal(estimateCost("Codex", "gpt-6.1-sol", legacy).usd, null);
});

test("only known model IDs and their dated snapshots receive prices", () => {
  assert.equal(modelPrice("Claude", "claude-opus-5-5-20260922").input, 4);
  assert.equal(modelPrice("Codex", "gpt-6.1-sol-2026-10-01").read, 0.1);
  assert.equal(modelPrice("Codex", "gpt-6.1-sol-unknown"), null);
  assert.equal(modelPrice("Claude", "claude-opus-9-9"), null);
});

test("mixed complete and legacy records expose known amounts and unpriced coverage", () => {
  const now = new Date(2026, 9, 30, 12);
  const buckets = new TokenBuckets(now, "Codex");
  const known = codexUsage({ input_tokens: 1_000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 100 });
  buckets.add(now, known.total, "gpt-6.1-sol", known);
  buckets.add(now, 300, "gpt-6.1-sol");
  const totals = buckets.totals();
  assert.equal(totals.today, 1_400);
  assert.equal(totals.usage.today.cache_read_tokens, 800);
  assert.ok(totals.usage.today.missing.includes("cache_read_tokens"));
  assert.equal(totals.usage.today.priced_tokens, 1_100);
  assert.equal(totals.usage.today.unpriced_tokens, 300);
  near(totals.usage.today.cost_usd, 0.00148);
  assert.deepEqual(totals.models[0].usage, totals.usage);
});

test("breakdowns and costs stay inside the same time windows and model groups", () => {
  const now = new Date(2026, 9, 30, 12);
  const buckets = new TokenBuckets(now, "Grok");
  const usage = grokUsage({ prompt_tokens: 1_000, cached_prompt_tokens: 500, completion_tokens: 100 });
  buckets.add(now, usage.total, "grok-4.7", usage);
  buckets.add(new Date(now.getTime() - 3 * 86400000), usage.total, "grok-4.7", usage);
  buckets.add(new Date(now.getTime() - 14 * 86400000), usage.total, "grok-4.6", usage);
  buckets.add(new Date(now.getTime() - 40 * 86400000), usage.total, "grok-4.7", usage);
  const totals = buckets.totals();
  assert.deepEqual([totals.today, totals.days7, totals.days30], [1100, 2200, 3300]);
  assert.deepEqual([totals.usage.today.cache_read_tokens, totals.usage.days7.cache_read_tokens, totals.usage.days30.cache_read_tokens], [500, 1000, 1500]);
  near(totals.usage.days30.cost_usd, 0.00555);
  near(totals.models.reduce((sum, row) => sum + row.usage.days30.cost_usd, 0), totals.usage.days30.cost_usd);
});

test("inconsistent and non-finite counters cannot become a negative or fabricated bill", () => {
  const now = new Date();
  const buckets = new TokenBuckets(now, "Grok");
  const invalid = grokUsage({ prompt_tokens: 10, cached_prompt_tokens: 50, completion_tokens: 5 });
  buckets.add(now, invalid.total, "grok-4.7", invalid);
  buckets.add(now, Infinity, "grok-4.7");
  buckets.add(new Date(NaN), 100, "grok-4.7");
  const totals = buckets.totals();
  assert.equal(totals.today, 15);
  assert.equal(totals.usage.today.unclassified_tokens, 15);
  assert.equal(totals.usage.today.input_tokens, 0);
  assert.equal(totals.usage.today.unpriced_tokens, 15);
  assert.deepEqual(totals.usage.today.cost_reasons, ["inconsistent_usage"]);
});
