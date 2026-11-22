import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { agyPath, agyQuota, parseAgyUsage, runAgyCommand } from "../lib/agy.js";
import { applyQuotaUpdate, ProviderReport } from "../lib/collect.js";
import { costTotals } from "../lib/pricing.js";
import { displayWidth, render } from "../lib/render.js";

const reset = "2026-11-12T01:33:11Z";
const payload = (groups) => ({ status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups } } });
const report = () => payload([
  { name: "Gemini Models", buckets: [
    { id: "gemini-5h", window: "5h", remaining_fraction: 1, reset_time: reset },
    { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.75, reset_time: reset },
  ] },
  { name: "Claude and GPT models", buckets: [
    { id: "3p-5h", window: "5h", remaining_fraction: 0, reset_time: reset },
    { id: "3p-weekly", window: "weekly", remaining_fraction: 0.5, reset_time: reset },
  ] },
  { name: "Gemini 4 Argon", buckets: [{ id: "gemini-argon-wtu-weekly", window: "weekly", remaining_fraction: 0.25, reset_time: reset }] },
]);

test("agy parses each model pool and cadence, including untouched and exhausted quotas", () => {
  const [plan, windows] = parseAgyUsage(report());
  assert.equal(plan, null);
  assert.deepEqual(windows.map(({ label, usedPercent }) => [label, usedPercent]), [
    ["Gemini 5 小时", 0], ["Gemini 每周", 25], ["Claude/GPT 5 小时", 100], ["Claude/GPT 每周", 50], ["Gemini 4 Argon 每周", 75],
  ]);
  assert.ok(windows.every((window) => window.resetsAt === "2026-11-12T01:33:11.000Z"));
});

test("weekly-only, disabled, missing, and invalid quota fractions never invent allowances", () => {
  const [, windows] = parseAgyUsage(payload([{ name: "Gemini Models", buckets: [
    { window: "5h", remaining_fraction: 1, disabled: true },
    ...[undefined, null, "0.5", -1, 2, NaN].map((remaining_fraction) => ({ window: "weekly", remaining_fraction, reset_time: reset })),
    { name: "Custom limit", remaining_fraction: 0.5, reset_time: "invalid" },
    { name: "Untouched epoch", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
  ] }, { name: "Disabled group", disabled: true, buckets: [{ remaining_fraction: 1 }] }]));
  assert.equal(windows.length, 8);
  assert.ok(windows.slice(0, 6).every((window) => window.usedPercent === null && window.label === "Gemini 每周"));
  assert.deepEqual(windows.at(-2), { label: "Gemini Custom limit", usedPercent: 50, resetsAt: null });
  assert.deepEqual(windows.at(-1), { label: "Gemini Untouched epoch", usedPercent: 0, resetsAt: null });
  assert.throws(() => parseAgyUsage(payload([])), /暂未提供可用额度/);
});

test("only successful read-only usage reports are accepted and errors keep account details private", () => {
  for (const data of [{ status: "SUCCESS", usage: { total_tokens: 0 } }, { ...report(), num_turns: 1 }, { ...report(), command: { name: "model" } }]) {
    assert.throws(() => parseAgyUsage(data), /未返回有效额度/);
  }
  assert.throws(() => parseAgyUsage({ status: "ERROR", response: "UNAUTHENTICATED person@example.com secret-token" }), (error) => {
    assert.equal(error.code, 401);
    assert.doesNotMatch(error.message, /person|secret-token/);
    return true;
  });
});

test("agy calls the native usage report in a temporary directory and cleans it up", async () => {
  const calls = [];
  let directory;
  const run = async (file, args, options) => {
    directory = options.cwd;
    assert.equal(file, process.execPath);
    assert.ok(existsSync(directory));
    assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
    assert.ok(existsSync(options.env.BROWSER));
    assert.ok(options.env.PATH.startsWith(directory + delimiter));
    calls.push(args);
    return { code: 0, stdout: args[0] === "--version" ? "1.5.0\n" : "\uFEFF" + JSON.stringify(report()), stderr: "" };
  };
  const [, windows] = await agyQuota(undefined, { executable: process.execPath, run, env: { Path: "old-path" } });
  assert.equal(windows.length, 5);
  assert.deepEqual(calls, [["--version"], ["-p", "/usage", "--output-format", "json"]]);
  assert.equal(existsSync(directory), false);
});

test("old and unrecognized agy versions never receive a slash command", async () => {
  for (const version of ["1.1.11", "1.0.99", "0.9.0", "unknown", "1.5.0-preview"]) {
    let calls = 0, directory;
    await assert.rejects(agyQuota(undefined, { executable: process.execPath, run: async (file, args, options) => {
      calls++;
      directory = options.cwd;
      assert.deepEqual(args, ["--version"]);
      return { code: 0, stdout: version, stderr: "" };
    } }), /需要 1\.1\.12/);
    assert.equal(calls, 1);
    assert.equal(existsSync(directory), false);
  }
  for (const version of ["1.1.12", "1.1.13", "1.2.0", "2.0.0", "agy v1.5.0"]) {
    await agyQuota(undefined, { executable: process.execPath, run: async (file, args) => ({
      code: 0, stdout: args[0] === "--version" ? version : JSON.stringify(report()), stderr: "",
    }) });
  }
});

test("native auth and rate-limit failures reach quota backoff without leaking stderr", async () => {
  for (const [diagnostic, code] of [["HTTP 429 secret-token", 429], ["PERMISSION_DENIED person@example.com", 403], ["sign in https://example.com/?token=secret", 401]]) {
    let directory;
    await assert.rejects(agyQuota(undefined, { executable: process.execPath, run: async (file, args, options) => {
      directory = options.cwd;
      return args[0] === "--version" ? { code: 0, stdout: "1.5.0" } : { code: 1, stdout: "", stderr: diagnostic };
    } }), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret|person|https/);
      return true;
    });
    assert.equal(existsSync(directory), false);
  }
});

test("agy discovery supports paths with spaces and an authoritative executable override", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aiusage agy 中文 "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(binary, "fixture", { mode: 0o700 });
  assert.equal(agyPath({ env: { PATH: directory }, homeDir: directory }), binary);
  assert.equal(agyPath({ env: { ANTIGRAVITY_CLI_PATH: binary }, homeDir: directory }), binary);
  assert.throws(() => agyPath({ env: { PATH: directory, ANTIGRAVITY_CLI_PATH: "" } }), /ANTIGRAVITY_CLI_PATH/);
  assert.throws(() => agyPath({ env: { PATH: directory, ANTIGRAVITY_CLI_PATH: join(directory, "missing") } }), /ANTIGRAVITY_CLI_PATH/);
  await assert.rejects(agyQuota(undefined, { executable: null }), /^Error: 未登录$/);
});

test("native command output, timeouts, and cancellation are bounded", async () => {
  const result = await runAgyCommand(process.execPath, ["-e", "process.stdout.write('1.5.0')"]);
  assert.equal(result.stdout, "1.5.0");
  await assert.rejects(runAgyCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }), /查询超时/);
  const controller = new AbortController();
  const pending = runAgyCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(runAgyCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]), /报告过大/);
});

test("quota-only reports keep native token totals honest after live updates", () => {
  const [, windows] = parseAgyUsage(report());
  const [updated] = applyQuotaUpdate([new ProviderReport({ name: "agy", tokensSupported: false })], {
    name: "agy", result: { plan: null, windows, error: null, skipped: false },
  });
  assert.equal(updated.toJSON().tokens, null);
  assert.equal(updated.toJSON().tokens_supported, false);
  assert.equal(costTotals([updated]).today.incomplete, false);
  for (const width of [24, 40, 80, 120]) {
    const text = render([updated], { width });
    assert.doesNotMatch(text.split("本机 Token")[1], /agy|未记录模型/);
    assert.match(text, /暂无本机 Token 记录/);
    assert.ok(text.split("\n").every((line) => displayWidth(line) <= width));
  }
});
