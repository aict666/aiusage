import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configHome, readJson, writePrivateJson } from "../lib/files.js";

test("config paths use each platform's home and separators", () => {
  const cases = [
    { platform: "linux", homeDir: "/home/test 用户", expected: "/home/test 用户/.claude" },
    { platform: "darwin", homeDir: "/Users/test 用户", expected: "/Users/test 用户/.claude" },
    { platform: "win32", homeDir: "C:\\Users\\test 用户", expected: "C:\\Users\\test 用户\\.claude" },
  ];
  for (const entry of cases) assert.equal(configHome("CLAUDE_CONFIG_DIR", ".claude", { ...entry, env: {} }), entry.expected);
  assert.equal(configHome("GROK_HOME", ".grok", {
    platform: "win32", homeDir: "C:\\Users\\test", env: { GROK_HOME: "D:\\自定义 配置\\grok" },
  }), "D:\\自定义 配置\\grok");
  assert.equal(configHome("CODEX_HOME", ".codex", {
    platform: "linux", homeDir: "/home/test", env: { CODEX_HOME: "~/custom codex" },
  }), "/home/test/custom codex");
  assert.equal(configHome("CODEX_HOME", ".codex", {
    platform: "win32", homeDir: "C:\\Users\\test", env: { CODEX_HOME: "~\\custom codex" },
  }), "C:\\Users\\test\\custom codex");
});

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "aiusage 文件 "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("credential files accept UTF-8 BOM and PowerShell UTF-16 LE", (t) => {
  const path = join(temporary(t), "auth.json");
  const data = { account: "用户", token: "test-only" };
  for (const bytes of [
    Buffer.from(JSON.stringify(data)),
    Buffer.from("\uFEFF" + JSON.stringify(data)),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(data), "utf16le")]),
  ]) {
    writeFileSync(path, bytes);
    assert.deepEqual(readJson(path), data);
  }
});

test("private credential replacement succeeds without chmod or shell commands", (t) => {
  const directory = temporary(t);
  const path = join(directory, "auth.json");
  writeFileSync(path, '{"old":true}');
  writePrivateJson(path, { token: "refreshed", metadata: { keep: true } });
  assert.deepEqual(readJson(path), { token: "refreshed", metadata: { keep: true } });
  assert.ok(readFileSync(path, "utf8").endsWith("\n"));
  assert.deepEqual(readdirSync(directory), ["auth.json"]);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("failed replacement leaves existing data and cleans its temporary file", (t) => {
  const directory = temporary(t);
  const path = join(directory, "auth.json");
  mkdirSync(path);
  writeFileSync(join(path, "keep"), "existing data");
  assert.throws(() => writePrivateJson(path, { token: "refreshed" }));
  assert.equal(readFileSync(join(path, "keep"), "utf8"), "existing data");
  assert.deepEqual(readdirSync(directory), ["auth.json"]);
});
