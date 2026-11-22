import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect, parseKeychainAccount, ProviderReport, saveClaudeOauth, validateGrokIssuer, Window } from "../lib/collect.js";
import { httpJson } from "../lib/http.js";
import { computeWindowPace, inferWindowSeconds } from "../lib/pace.js";
import { walkJsonl } from "../lib/token-cache.js";

test("pace calculates burn ratio and projected exhaustion accurately", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  assert.equal(inferWindowSeconds("5 小时"), 18_000);
  assert.equal(inferWindowSeconds("Claude/GPT 每周"), 604_800);
  assert.equal(inferWindowSeconds("Sonnet 周"), 604_800);
  assert.equal(inferWindowSeconds("额外用量"), null);

  // 7-day window with 5 days left (~28.6% elapsed), already 60% used -> ~2.1x critical burn
  const fastReset = new Date(now.getTime() + 5 * 86_400_000).toISOString();
  const fast = computeWindowPace(new Window("7 天", 60, fastReset), now);
  assert.equal(fast.status, "critical");
  assert.ok(fast.ratio >= 2.0 && fast.ratio <= 2.2);
  assert.ok(Date.parse(fast.exhausts_at) < Date.parse(fastReset));
  assert.ok(Date.parse(fast.exhausts_at) > now.getTime());

  // 5-hour window with 1 hour left (80% elapsed), only 30% used -> comfortable
  const calmReset = new Date(now.getTime() + 3_600_000).toISOString();
  const calm = computeWindowPace(new Window("5 小时", 30, calmReset), now);
  assert.equal(calm.status, "comfortable");
  assert.equal(calm.exhausts_at, null);
  assert.ok(calm.delta_percent <= -49);

  // ProviderReport JSON exposes pace on bounded windows and omits it on unbounded ones
  const report = new ProviderReport({
    name: "Claude",
    plan: "pro",
    windows: [new Window("7 天", 60, fastReset), new Window("额外用量", 15, null)],
  });
  const json = report.toJSON(now);
  assert.equal(json.windows[0].pace.status, "critical");
  assert.equal(json.windows[1].pace, undefined);
});

test("incremental token cursor skips unchanged logs, reads only appended bytes, and detects file rewrites", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiusage-incremental-"));
  const previous = {};
  for (const [name, folder] of [["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"], ["GROK_HOME", "grok"], ["AGY_HOME", "agy"], ["AIUSAGE_CACHE_DIR", "cache"]]) {
    previous[name] = process.env[name];
    const dir = join(root, folder);
    mkdirSync(dir, { recursive: true });
    process.env[name] = dir;
  }
  t.after(() => {
    for (const [name, val] of Object.entries(previous)) {
      if (val === undefined) delete process.env[name];
      else process.env[name] = val;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const now = new Date();
  const logDir = join(root, "claude", "projects", "demo");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "session.jsonl");
  const line1 = JSON.stringify({
    requestId: "req-1",
    timestamp: now.toISOString(),
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } },
  }) + "\n";
  writeFileSync(logFile, line1);

  let openedFds = new Set();
  let readPositions = [];
  const origOpen = fs.open;
  const origRead = fs.read;
  t.mock.method(fs, "open", (...args) => {
    const targetPath = args[0];
    const cb = args.pop();
    return origOpen(...args, (err, fd) => {
      if (!err && targetPath === logFile) openedFds.add(fd);
      cb(err, fd);
    });
  });
  t.mock.method(fs, "read", (fd, buffer, offset, length, position, cb) => {
    if (openedFds.has(fd) && typeof position === "number") readPositions.push(position);
    return origRead(fd, buffer, offset, length, position, cb);
  });

  // 1st scan: opens file and reads from byte offset 0
  const [first] = await collect(now, null, { offline: true });
  assert.equal(first.tokens.today, 100);
  assert.deepEqual(readPositions, [0]);

  // 2nd scan with unchanged file: 0 async stream opens/reads!
  openedFds = new Set();
  readPositions = [];
  const [second] = await collect(now, null, { offline: true });
  assert.equal(second.tokens.today, 100);
  assert.equal(openedFds.size, 0);
  assert.deepEqual(readPositions, []);

  // 3rd scan after appending: seeks directly to exact byte length of line1!
  const line2 = JSON.stringify({
    requestId: "req-2",
    timestamp: now.toISOString(),
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 25 } },
  }) + "\n";
  appendFileSync(logFile, line2);
  openedFds = new Set();
  readPositions = [];
  const [third] = await collect(now, null, { offline: true });
  assert.equal(third.tokens.today, 225);
  assert.deepEqual(readPositions, [Buffer.byteLength(line1)]);

  // 4th scan after rewriting file from byte 0 with larger content: detects header change and rescans from 0
  const rewritten = JSON.stringify({
    requestId: "rewritten-only",
    timestamp: now.toISOString(),
    message: { model: "claude-opus-5-5", usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10, padding: "x".repeat(400) } },
  }) + "\n";
  writeFileSync(logFile, rewritten);
  openedFds = new Set();
  readPositions = [];
  const [fourth] = await collect(now, null, { offline: true });
  assert.equal(fourth.tokens.today, 310);
  assert.equal(fourth.tokens.models[0].model, "claude-opus-5-5");
  assert.deepEqual(readPositions, [0]);
});

test("walkJsonl ignores symlinks and symlink loops safely", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiusage-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realFile = join(root, "real.jsonl");
  writeFileSync(realFile, "{}\n");
  symlinkSync(root, join(root, "loop"));
  symlinkSync(realFile, join(root, "linked.jsonl"));
  assert.deepEqual(walkJsonl(root), [realFile]);
});

test("validateGrokIssuer blocks untrusted hosts, plaintext HTTP, and URL credentials", () => {
  assert.equal(validateGrokIssuer(undefined), "https://auth.x.ai");
  assert.equal(validateGrokIssuer("https://auth.x.ai/"), "https://auth.x.ai");
  assert.equal(validateGrokIssuer("https://us.auth.x.ai"), "https://us.auth.x.ai");
  for (const bad of [
    "http://auth.x.ai",
    "https://evil.example",
    "https://auth.x.ai.evil.example",
    "https://user:secret@auth.x.ai",
    "https://auth.x.ai?leak=1",
    "not-a-url",
  ]) {
    assert.throws(() => validateGrokIssuer(bad), /不受信任/);
  }
});

test("keychain save passes secrets over stdin hex rather than process argv and preserves account", (t) => {
  assert.equal(parseKeychainAccount('attributes:\n    "acct"<blob>="claude-custom"\n'), "claude-custom");
  assert.equal(parseKeychainAccount('attributes:\n    "acct"<blob>=<NULL>\n'), "");

  let capturedFile, capturedArgs, capturedOptions;
  t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    capturedFile = file;
    capturedArgs = args;
    capturedOptions = options;
    return "";
  });

  const secretToken = "super-secret-oauth-token-12345";
  saveClaudeOauth({ accessToken: secretToken, refreshToken: "refresh-999" }, "keychain", {}, "claude-custom");
  assert.equal(capturedFile, "security");
  assert.deepEqual(capturedArgs, ["-i"]);
  assert.ok(!JSON.stringify(capturedArgs).includes(secretToken));
  assert.match(capturedOptions.input, /add-generic-password -U -s "Claude Code-credentials" -a "claude-custom" -X [0-9a-f]+\n/);
});

test("httpJson enforces maximum response byte size", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(2048), { status: 200 }));
  await assert.rejects(httpJson("https://example.test", { maxBytes: 512 }), /响应内容过大/);
});
