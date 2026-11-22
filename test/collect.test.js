import assert from "node:assert/strict";
import test from "node:test";
import { applyQuotaUpdate, collectProviders, ProviderReport } from "../lib/collect.js";

test("three providers start together and keep order", async () => {
  let running = 0;
  let maxRunning = 0;
  const quota = (plan) => async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 40));
    running -= 1;
    return [plan, []];
  };
  const lines = [];
  const reports = await collectProviders(
    [
      ["Claude", quota("pro"), async () => {}],
      ["Codex", quota("prolite"), async () => {}],
      ["Grok", quota("SuperGrok"), async () => {}],
    ],
    new Date(),
    (text) => lines.push(text),
  );
  assert.equal(maxRunning, 3);
  assert.deepEqual(
    reports.map((report) => report.name),
    ["Claude", "Codex", "Grok"],
  );
  assert.equal(lines[0], "Claude 读取中  Codex 读取中  Grok 读取中");
  assert.equal(lines.at(-1), "Claude 完成  Codex 完成  Grok 完成");
});

test("quota and local tokens of one provider overlap", async () => {
  let quotaOpen = false;
  let sawOverlap = false;
  await collectProviders(
    [
      [
        "Claude",
        async () => {
          quotaOpen = true;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return ["pro", []];
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          sawOverlap = quotaOpen;
        },
      ],
    ],
    new Date(),
  );
  assert.equal(sawOverlap, true);
});

test("login miss stays separate from a token error", async () => {
  const [report] = await collectProviders([
    [
      "Codex",
      async () => {
        throw new Error("未登录");
      },
      async () => {
        throw new Error("日志读失败");
      },
    ],
  ]);
  assert.equal(report.skipped, true);
  assert.equal(report.error, null);
  assert.equal(report.tokens, null);
});

test("quota updates preserve local log errors and provider JSON serialization", () => {
  const [report] = applyQuotaUpdate([new ProviderReport({ name: "Claude", tokens: null, tokenError: "日志读失败", error: "日志读失败" })], {
    name: "Claude", result: { plan: "pro", windows: [{ label: "5 小时", usedPercent: 42, resetsAt: null }], error: null, skipped: false },
  });
  assert.equal(report.error, "日志读失败");
  assert.equal(report.tokens, null);
  assert.equal(report.toJSON().windows[0].used_percent, 42);
});

test("Claude includes Fable structured limits even when not the active limiting window", async () => {
  const { claudeWindows } = await import('../lib/collect.js');
  const windows = claudeWindows({
    seven_day: {utilization: 86, resets_at: '2026-11-14T19:00:00Z'},
    seven_day_sonnet: {utilization: 10},
    limits: [
      {kind: 'weekly_all', percent: 86},
      {kind: 'weekly_scoped', percent: 59, is_active: false, resets_at: '2026-11-14T19:00:00Z', scope: {model: {id: null, display_name: 'Fable'}}},
      {kind: 'weekly_scoped', percent: 10, scope: {model: {display_name: 'Sonnet'}}},
      {kind: 'weekly_scoped', percent: null, scope: {model: {display_name: 'Other'}}},
    ],
    weekly_scoped_shares: [{limit_index: 1, used_percent_of_weekly: 30, allowance_percent_of_weekly: 50}],
  });
  assert.deepEqual(windows.map(w => [w.label, w.usedPercent]), [['7 天',86], ['Sonnet 周',10], ['Fable 周',59], ['Other 周',null]]);
  assert.equal(windows[2].resetsAt, '2026-11-14T19:00:00Z');
});
