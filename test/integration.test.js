import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../lib/collect.js";
import { readJson } from "../lib/files.js";
import { render } from "../lib/render.js";

function fixture(t, { expired = false, flat = false, quotas = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiusage 集成 "));
  const previous = {};
  const paths = {};
  for (const [name, folder] of [["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"], ["GROK_HOME", "grok"], ["AGY_HOME", "agy"], ["AIUSAGE_CACHE_DIR", "cache"]]) {
    previous[name] = process.env[name];
    paths[folder] = join(root, folder);
    mkdirSync(paths[folder]);
    process.env[name] = paths[folder];
  }
  previous.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  previous.ANTIGRAVITY_CLI_PATH = process.env.ANTIGRAVITY_CLI_PATH;
  process.env.ANTIGRAVITY_CLI_PATH = process.execPath;
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
  const agyLogDir = join(paths.agy, "brain", "conv-1", ".system_generated", "logs");
  mkdirSync(agyLogDir, { recursive: true });
  jsonl(join(agyLogDir, "transcript.jsonl"), [
    { step_index: 0, type: "USER_INPUT", created_at: now.toISOString() },
    { step_index: 1, type: "PLANNER_RESPONSE", created_at: now.toISOString(), model: "gemini-2.5-pro", input_tokens: 100, cache_read_tokens: 200, output_tokens: 50 },
  ]);
  // transcript_full.jsonl mirrors the same steps and must never be double-counted.
  jsonl(join(agyLogDir, "transcript_full.jsonl"), [
    { step_index: 1, type: "PLANNER_RESPONSE", created_at: now.toISOString(), model: "gemini-2.5-pro", input_tokens: 100, cache_read_tokens: 200, output_tokens: 50 },
  ]);
  const requested = [];
  const agyCalls = [];
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    assert.equal(file, process.execPath);
    agyCalls.push(args);
    queueMicrotask(() => callback(null, args[0] === "--version" ? "1.5.0\n" : JSON.stringify({
      status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [
        { name: "Gemini Models", buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.75, reset_time: new Date(now.getTime() + 3_600_000).toISOString() }] },
      ] } },
    }), ""));
    return { stdin: { end() {} } };
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requested.push(url);
    if (url === "https://platform.claude.com/v1/oauth/token") return Response.json({ access_token: "claude-new", refresh_token: "claude-refresh-new", expires_in: 3600 });
    if (url === "https://auth.x.ai/oauth2/token") return Response.json({ access_token: "grok-new", refresh_token: "grok-refresh-new", expires_in: 3600 });
    if (url === "https://api.anthropic.com/api/oauth/usage?cedar_ember=1") {
      assert.equal(options.headers.Authorization, `Bearer ${expired ? "claude-new" : "claude-test"}`);
      return Response.json(quotas.claude ?? { five_hour: { utilization: 25, resets_at: new Date(now.getTime() + 3_600_000).toISOString() } });
    }
    if (url === "https://chatgpt.com/backend-api/wham/usage") return Response.json(quotas.codex ?? { plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } });
    if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") return Response.json({credits: [], available_count: 0});
    if (url === "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets") {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, `Bearer ${expired ? "grok-new" : "grok-test"}`);
      assert.deepEqual(options.body, new Uint8Array(5));
      return new Response(new Uint8Array(5));
    }
    if (url.startsWith("https://cli-chat-proxy.grok.com/v1/")) {
      assert.equal(options.headers.Authorization, `Bearer ${expired ? "grok-new" : "grok-test"}`);
      return Response.json(url.includes("billing") ? quotas.grok ?? { config: { creditUsagePercent: 60 } } : { subscription_tier_display: "SuperGrok" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { paths, now, requested, agyCalls };
}

test("all providers read custom paths, BOM credentials, and CRLF logs", async (t) => {
  const { now, requested } = fixture(t);
  const reports = await collect(now);
  assert.equal(requested.length, 6);
  assert.deepEqual(reports.map(({ name, skipped, error, tokens }) => ({ name, skipped, error, today: tokens?.today })), [
    { name: "Claude", skipped: false, error: null, today: 100 },
    { name: "Codex", skipped: false, error: null, today: 250 },
    { name: "Grok", skipped: false, error: null, today: 50 },
    { name: "agy", skipped: false, error: null, today: 350 },
  ]);
  assert.deepEqual(reports.map((report) => report.tokens.models[0].model), ["claude-sonnet-4-6", "gpt-6.1-sol", "grok-4.7", "gemini-2.5-pro"]);
  assert.deepEqual(reports.map((report) => report.tokens.usage.today.cache_read_tokens), [30, 150, 20, 200]);
  assert.deepEqual(reports.map((report) => report.tokens.usage.today.unpriced_tokens), [0, 0, 0, 0]);
  assert.equal(reports[0].tokens.usage.today.cost_usd, 0.000714);
  assert.equal(reports[3].windows[0].usedPercent, 25);
  assert.equal(reports[3].tokens.today, 350);
});

for (const percent of [0, 0.5, 1, 1.5, 100, null]) test(`quota percentages preserve API units through cache, JSON, and display (${percent})`, async (t) => {
  const window = { utilization: percent, resets_at: "2026-11-15T00:00:00Z" };
  const { now, requested } = fixture(t, { quotas: {
    claude: {
      five_hour: window, seven_day: window, seven_day_sonnet: window, seven_day_opus: window,
      extra_usage: { is_enabled: true, utilization: percent },
    },
    codex: { rate_limit: {
      primary_window: { used_percent: percent, limit_window_seconds: 18000 },
      secondary_window: { used_percent: percent, limit_window_seconds: 604800 },
    } },
    grok: { config: { creditUsagePercent: percent } },
  } });
  for (const cached of [false, true]) {
    const reports = await collect(now);
    assert.equal(requested.length, 6);
    assert.deepEqual(reports.slice(0, 3).map((report) => report.windows.length), [5, 2, 1]);
    for (const report of reports.slice(0, 3)) {
      assert.equal(report.error, null);
      assert.equal(report.quota.cached, cached);
      assert.ok(report.windows.every((entry) => entry.usedPercent === percent));
      assert.ok(report.toJSON().windows.every((entry) => entry.used_percent === percent));
    }
    // agy explicitly reports a remaining fraction; its conversion stays separate.
    assert.equal(reports[3].windows[0].usedPercent, 25);
    if (percent === 1) {
      const text = render([reports[0]], { color: false, width: 140, now });
      assert.match(text, /7 天\s+[━─]+\s+1%\s+99%/);
      assert.doesNotMatch(text, /100%/);
    }
  }
});

test("agy shares persisted quota cooldowns across collections", async (t) => {
  const { now, agyCalls } = fixture(t);
  const first = (await collect(now))[3];
  const cached = (await collect(now))[3];
  assert.deepEqual(agyCalls, [["--version"], ["-p", "/usage", "--output-format", "json"]]);
  assert.deepEqual(cached.windows, first.windows);
  assert.equal(cached.quota.cached, true);
  assert.equal(cached.quota.updated_at, first.quota.updated_at);
});

test("Claude merges message snapshots when requestId is absent", async (t) => {
  const { paths, now } = fixture(t);
  const path = join(paths.claude, "projects", "project with spaces", "session.jsonl");
  const rows = [
    { uuid: "snapshot-a", timestamp: new Date(now.getTime() - 500).toISOString(), message: { id: "message-2", model: "claude-sonnet-4-6", usage: { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 0, output_tokens: 5 } } },
    { uuid: "snapshot-b", timestamp: now.toISOString(), message: { id: "message-2", model: "claude-sonnet-4-6", usage: { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 0, output_tokens: 20 } } },
  ];
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n");
  const [claude] = await collect(now);
  assert.equal(claude.tokens.today, 200);
  assert.equal(claude.tokens.usage.today.cache_read_tokens, 100);
  assert.equal(claude.tokens.usage.today.output_tokens, 60);
});

test("Codex counts a response once across rollouts and ignores cumulative usage fields", async (t) => {
  const { paths, now } = fixture(t);
  const first = { type: "token_usage_record", ordinal: 1, timestamp: new Date(now.getTime() - 500).toISOString(), payload: {
    response_id: "response-2", model: "gpt-6.1-sol",
    usage: { total_tokens: 120, input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20 },
    turn_token_usage: { total_tokens: 12_000, input_tokens: 10_000, cached_input_tokens: 8_000, output_tokens: 2_000 },
    thread_token_usage: { total_tokens: 120_000, input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 20_000 },
  } };
  const last = { ...first, ordinal: 2, timestamp: now.toISOString(), payload: { ...first.payload, usage: { ...first.payload.usage, output_tokens: 40, total_tokens: 140 } } };
  appendFileSync(join(paths.codex, "sessions", "session.jsonl"), JSON.stringify(first) + "\r\n");
  writeFileSync(join(paths.codex, "sessions", "fork.jsonl"), JSON.stringify({ ...last, ordinal: 9, payload: { ...last.payload, model: undefined } }) + "\r\n");
  const [, codex] = await collect(now);
  assert.equal(codex.tokens.today, 390);
  assert.equal(codex.tokens.usage.today.cache_read_tokens, 230);
  assert.equal(codex.tokens.usage.today.output_tokens, 90);
  assert.equal(codex.tokens.usage.today.priced_tokens, 390);
});

test("equal token amounts without response IDs remain separate calls", async (t) => {
  const { paths, now } = fixture(t);
  const row = { type: "token_usage_record", timestamp: now.toISOString(), payload: { model: "gpt-6.1-sol",
    usage: { total_tokens: 120, input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20 } } };
  appendFileSync(join(paths.codex, "sessions", "session.jsonl"), JSON.stringify(row) + "\n" + JSON.stringify(row) + "\n");
  const [, codex] = await collect(now);
  assert.equal(codex.tokens.today, 490);
  assert.equal(codex.tokens.usage.today.cache_read_tokens, 310);
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

test("Claude OAuth throttling is not retried on another endpoint or a subsequent local update", async (t) => {
  const { now } = fixture(t, { expired: true });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return new Response(null, { status: 429, headers: { "retry-after": "7200" } });
  });
  const [first] = await collect(now);
  assert.equal(first.error, "HTTP 429");
  assert.ok(Date.parse(first.quota.next_refresh_at) >= Date.now() + 7190_000);
  await collect(now);
  assert.deepEqual(requests.filter((url) => /claude|anthropic/.test(url)), ["https://platform.claude.com/v1/oauth/token"]);
});

test("offline collection reads token logs without accessing endpoints or invoking agy", async (t) => {
  const { now, requested, agyCalls } = fixture(t);
  const reports = await collect(now, null, { offline: true });
  assert.equal(requested.length, 0);
  assert.deepEqual(reports.map((report) => report.tokens?.today), [100, 250, 50, 350]);
  assert.equal(agyCalls.length, 0);
  assert.ok(reports.every((report) => report.quota.status === "offline"));
});

test("cancelling a local log scan does not leave a rejected stream or request running", async (t) => {
  const { now, requested } = fixture(t);
  const controller = new AbortController();
  const pending = collect(now, null, { offline: true, signal: controller.signal });
  controller.abort();
  const reports = await pending;
  assert.equal(reports.length, 4);
  assert.equal(requested.length, 0);
});

test("cancelling after files open waits for the underlying file handles to close", async (t) => {
  const { now } = fixture(t);
  const controller = new AbortController();
  const active = new Set();
  let opened = 0;
  const open = fs.open, close = fs.close;
  t.mock.method(fs, "open", (...args) => {
    const callback = args.pop();
    open(...args, (error, fd) => {
      if (!error) { active.add(fd); opened++; }
      callback(error, fd);
      if (!error) controller.abort();
    });
  });
  t.mock.method(fs, "close", (fd, callback) => close(fd, (error) => {
    if (!error) active.delete(fd);
    callback(error);
  }));
  await collect(now, null, { offline: true, signal: controller.signal });
  assert.ok(opened > 0);
  assert.equal(active.size, 0);
});

test("a growing log is read as a finite snapshot and new records arrive on the next scan", async (t) => {
  const { paths, now } = fixture(t);
  const path = join(paths.claude, "projects", "project with spaces", "session.jsonl");
  const open = fs.open;
  let appended = false;
  t.mock.method(fs, "open", (...args) => {
    if (args[0] === path && !appended) {
      appended = true;
      appendFileSync(path, JSON.stringify({ requestId: "new-during-scan", timestamp: now.toISOString(),
        message: { model: "claude-sonnet-4-6", usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30 } } }) + "\n");
    }
    return open(...args);
  });
  const [before] = await collect(now, null, { offline: true });
  assert.equal(appended, true);
  assert.equal(before.tokens.today, 100);
  const [after] = await collect(now, null, { offline: true });
  assert.equal(after.tokens.today, 150);
});
