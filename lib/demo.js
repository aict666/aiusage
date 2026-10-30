import { ProviderReport, Window } from "./collect.js";

// Fixed example amounts; reset times are relative to the preview's timestamp.
export function demoReports(now = new Date()) {
  const after = (hours) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  const tokens = (models) => ({
    ...Object.fromEntries(["today", "days7", "days30"].map((key) => [key, models.reduce((sum, row) => sum + row[key], 0)])),
    models,
  });
  return [
    new ProviderReport({
      name: "Claude",
      plan: "pro",
      windows: [new Window("5 小时", 6, after(4.5)), new Window("7 天", 84, after(42))],
      tokens: tokens([
        { model: "claude-opus-5-5", today: 3_527_818, days7: 1_661_061_805, days30: 1_990_000_000 },
        { model: "claude-sonnet-4-6", today: 124_000, days7: 120_000_000, days30: 140_000_000 },
      ]),
    }),
    new ProviderReport({
      name: "Codex",
      plan: "prolite",
      windows: [new Window("每周", 13, after(126.55))],
      tokens: tokens([{ model: "gpt-6.1-sol", today: 0, days7: 963_000_000, days30: 1_880_000_000 }]),
    }),
    new ProviderReport({
      name: "Grok",
      plan: "SuperGrok",
      windows: [new Window("每周", 60, after(77 + 56 / 60))],
      tokens: tokens([{ model: "grok-4.7", today: 11_716_325, days7: 107_000_000, days30: 122_000_000 }]),
    }),
  ];
}
