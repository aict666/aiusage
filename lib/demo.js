import { ProviderReport, Window } from "./collect.js";
import { TokenBuckets } from "./time.js";
import { claudeUsage, codexUsage, grokUsage } from "./usage.js";

// Fixed example amounts; reset times are relative to the preview's timestamp.
export function demoReports(now = new Date()) {
  const after = (hours) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  const tokens = (provider, models) => {
    const buckets = new TokenBuckets(now, provider);
    for (const row of models) {
      const periods = [[now, row.today], [new Date(now.getTime() - 3 * 86400000), row.days7 - row.today], [new Date(now.getTime() - 14 * 86400000), row.days30 - row.days7]];
      for (const [moment, total] of periods) {
        // Simulate many short requests so aggregate monthly tokens do not trigger long-context rates.
        for (let left = total; left > 0; left -= Math.min(left, 180_000)) {
          const amount = Math.min(left, 180_000);
          const read = Math.floor(amount * 0.85);
          const output = Math.floor(amount * 0.02);
          let usage;
          if (provider === "Claude") {
            const write = Math.floor(amount * 0.1);
            const long = Math.floor(write / 3);
            usage = claudeUsage({ input_tokens: amount - read - output - write, output_tokens: output, cache_read_input_tokens: read,
              cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: write - long, ephemeral_1h_input_tokens: long } });
          } else if (provider === "Codex") {
            usage = codexUsage({ total_tokens: amount, input_tokens: amount - output, output_tokens: output, cached_input_tokens: read, cache_write_input_tokens: 0 });
          } else usage = grokUsage({ prompt_tokens: amount - output, completion_tokens: output, cached_prompt_tokens: read });
          buckets.add(moment, amount, row.model, usage);
        }
      }
    }
    return buckets.totals();
  };
  return [
    new ProviderReport({
      name: "Claude",
      plan: "pro",
      windows: [new Window("5 小时", 6, after(4.5)), new Window("7 天", 84, after(42))],
      tokens: tokens("Claude", [
        { model: "claude-opus-5-5", today: 3_527_818, days7: 1_661_061_805, days30: 1_990_000_000 },
        { model: "claude-sonnet-4-6", today: 124_000, days7: 120_000_000, days30: 140_000_000 },
      ]),
    }),
    new ProviderReport({
      name: "Codex",
      plan: "prolite",
      windows: [new Window("每周", 13, after(126.55))],
      tokens: tokens("Codex", [{ model: "gpt-6.1-sol", today: 0, days7: 963_000_000, days30: 1_880_000_000 }]),
    }),
    new ProviderReport({
      name: "Grok",
      plan: "SuperGrok",
      windows: [new Window("每周", 60, after(77 + 56 / 60))],
      tokens: tokens("Grok", [{ model: "grok-4.7", today: 11_716_325, days7: 107_000_000, days30: 122_000_000 }]),
    }),
  ];
}
