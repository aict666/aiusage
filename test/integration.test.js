import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../lib/collect.js";
import { readJson } from "../lib/files.js";

function fixture(t, { expired = false, flat = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiusage 集成 "));
  const previous = {};
  const paths = {};
  for (const [name, folder] of [["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"], ["GROK_HOME", "grok"]]) {
    previous[name] = process.env[name];
    paths[folder] = join(root, folder);
    mkdirSync(paths[folder]);
    process.env[name] = paths[folder];
  }
  previous.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const now = new Date();
  const oauth = { accessToken: "claude-test", refreshToken: "claude-refresh", expiresAt: expired ? 0 : now.getTime() + 3_600_000, subscriptionType: "pro" };
  const claude = flat ? { ...oauth, preserved: "claude metadata" } : { claudeAiOauth: oauth, preserved: "claude metadata" };
  writeFileSync(join(paths.claude, ".credentials.json"), "\uFEFF" + JSON.stringify(claude));
  const codex = JSON.stringify({ tokens: { access_token: "codex-test", account_id: "test-account" } });
  writeFileSync(join(paths.codex, "auth.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(codex, "utf16le")]));
  writeFileSync(join(paths.grok, "auth.json"), JSON.stringify({
    session: { key: "grok-test", refresh_token: "grok-refresh", oidc_client_id: "test-client", expires_at: new Date(now.getTime() + (expired ? -3_600_000 : 3_600_000)).toISOString() },
    preserved: "grok metadata",
  }));
  const jsonl = (path, rows) => writeFileSync(path, "\uFEFF" + rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n");
  mkdirSync(join(paths.claude, "projects", "project with spaces"), { recursive: true });
  jsonl(join(paths.claude, "projects", "project with spaces", "session.jsonl"), [
    { requestId: "request", timestamp: new Date(now.getTime() - 1_000).toISOString(), message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 20 }, cache_read_input_tokens: 30, output_tokens: 1 } } },
    { requestId: "request", timestamp: now.toISOString(), message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 20 }, cache_read_input_tokens: 30, output_tokens: 40 } } },
  ]);
  mkdirSync(join(paths.codex, "sessions"));
  jsonl(join(paths.codex, "sessions", "session.jsonl"), [
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { type: "token_usage_record", timestamp: now.toISOString(), payload: { usage: { total_tokens: 250, input_tokens: 200, cached_input_tokens: 150, cache_write_input_tokens: 0, output_tokens: 50 } } },
  ]);
  mkdirSync(join(paths.grok, "logs"));
  jsonl(join(paths.grok, "logs", "unified.jsonl"), [
    { msg: "model changed", ctx: { current_model_id: "grok-4.7" } },
    { ts: now.toISOString(), ctx: { prompt_tokens: 30, cached_prompt_tokens: 20, completion_tokens: 20 } },
  ]);
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requested.push(url);
    if (url === "https://platform.claude.com/v1/oauth/token") return Response.json({ access_token: "claude-new", refresh_token: "claude-refresh-new", expires_in: 3600 });
    if (url === "https://auth.x.ai/oauth2/token") return Response.json({ access_token: "grok-new", refresh_token: "grok-refresh-new", expires_in: 3600 });
    if (url === "https://api.anthropic.com/api/oauth/usage") {
      assert.equal(options.headers.Authorization, `Bearer ${expired ? "claude-new" : "claude-test"}`);
      return Response.json({ five_hour: { utilization: 25, resets_at: new Date(now.getTime() + 3_600_000).toISOString() } });
    }
    if (url === "https://chatgpt.com/backend-api/wham/usage") return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } });
    if (url.startsWith("https://cli-chat-proxy.grok.com/v1/")) {
      assert.equal(options.headers.Authorization, `Bearer ${expired ? "grok-new" : "grok-test"}`);
      return Response.json(url.includes("billing") ? { config: { creditUsagePercent: 60 } } : { subscription_tier_display: "SuperGrok" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { paths, now, requested };
}

test("all providers read custom paths, BOM credentials, and CRLF logs", async (t) => {
  const { now, requested } = fixture(t);
  const reports = await collect(now);
  assert.equal(requested.length, 4);
  assert.deepEqual(reports.map(({ name, skipped, error, tokens }) => ({ name, skipped, error, today: tokens?.today })), [
    { name: "Claude", skipped: false, error: null, today: 100 },
    { name: "Codex", skipped: false, error: null, today: 250 },
    { name: "Grok", skipped: false, error: null, today: 50 },
  ]);
  assert.deepEqual(reports.map((report) => report.tokens.models[0].model), ["claude-sonnet-4-6", "gpt-6.1-sol", "grok-4.7"]);
  assert.deepEqual(reports.map((report) => report.tokens.usage.today.cache_read_tokens), [30, 150, 20]);
  assert.deepEqual(reports.map((report) => report.tokens.usage.today.unpriced_tokens), [0, 0, 0]);
  assert.equal(reports[0].tokens.usage.today.cost_usd, 0.000714);
});

for (const flat of [false, true]) test(`refresh preserves credential metadata and file shape (flat=${flat})`, async (t) => {
  const { paths, now } = fixture(t, { expired: true, flat });
  const reports = await collect(now);
  assert.ok(reports.every((report) => !report.error && !report.skipped));
  const claude = readJson(join(paths.claude, ".credentials.json"));
  const grok = readJson(join(paths.grok, "auth.json"));
  assert.equal(claude.preserved, "claude metadata");
  assert.equal((flat ? claude : claude.claudeAiOauth).accessToken, "claude-new");
  assert.equal(Object.hasOwn(claude, "claudeAiOauth"), !flat);
  assert.equal(grok.preserved, "grok metadata");
  assert.equal(grok.session.key, "grok-new");
  for (const [directory, filename] of [[paths.claude, ".credentials.json"], [paths.grok, "auth.json"]]) {
    assert.ok(readdirSync(directory).every((file) => !file.endsWith(".tmp")));
    if (process.platform !== "win32") assert.equal(statSync(join(directory, filename)).mode & 0o777, 0o600);
  }
});
