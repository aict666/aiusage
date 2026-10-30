import assert from "node:assert/strict";
import test from "node:test";
import { collectProviders } from "../lib/collect.js";

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
