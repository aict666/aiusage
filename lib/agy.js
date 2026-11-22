import childProcess from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { configHome, parseJson } from "./files.js";
import { parseTime } from "./time.js";
import { agyScopeForAccount, readAgyAccountSummary } from "./agy-accounts.js";

const MIN_VERSION = [1, 1, 12];
const MAX_OUTPUT = 1024 * 1024;

function pathValue(env) {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

export function agyPath({ env = process.env, homeDir = homedir(), platform = process.platform } = {}) {
  const configured = env.ANTIGRAVITY_CLI_PATH;
  if (configured !== undefined) {
    if (!configured) throw new Error("请将 ANTIGRAVITY_CLI_PATH 设为 agy 可执行文件路径");
    const path = configHome("ANTIGRAVITY_CLI_PATH", "", { env, homeDir, platform });
    try {
      accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      if (statSync(path).isFile()) return resolve(path);
    } catch { /* Report the configured path without exposing it. */ }
    throw new Error("无法运行 agy，请检查 ANTIGRAVITY_CLI_PATH");
  }
  const binary = platform === "win32" ? "agy.exe" : "agy";
  const directories = [...pathValue(env).split(platform === "win32" ? ";" : delimiter).filter(Boolean), join(homeDir, ".local", "bin")];
  if (platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const directory of directories) {
    const path = join(directory, binary);
    try {
      accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      if (statSync(path).isFile()) return resolve(path);
    } catch { /* Try the next installation directory. */ }
  }
  return null;
}

export function agyScope(options = {}) {
  const activeId = readAgyAccountSummary(options).activeId;
  return agyScopeForAccount(activeId, options);
}

const cancelled = () => Object.assign(new Error("已停止刷新"), { name: "AbortError" });

// Keep diagnostics private: agy can include account details and sign-in URLs in stderr.
export function runAgyCommand(executable, args, { signal, timeoutMs = 45_000, ...options } = {}) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* Already exited. */ }
      }
      child.kill("SIGKILL");
    };
    const abort = () => stop();
    const child = childProcess.execFile(executable, args, {
      ...options, encoding: "utf8", maxBuffer: MAX_OUTPUT, windowsHide: true,
      detached: process.platform !== "win32",
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      stop();
      if (signal?.aborted) return reject(cancelled());
      if (timedOut) return reject(new Error("agy 额度查询超时，请在终端运行 agy 检查登录或网络"));
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error("agy 额度报告过大"));
      if (error && typeof error.code !== "number") return reject(new Error("无法运行 agy，请检查安装及可执行文件权限"));
      resolve({ stdout, stderr, code: error?.code || 0 });
    });
    // No prompt input: /usage is a built-in read-only report, never an agent turn.
    child.stdin?.end();
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function commandError(text) {
  if (/\b429\b|RESOURCE_EXHAUSTED|too many requests|rate.limit/i.test(text)) return Object.assign(new Error("agy HTTP 429"), { code: 429 });
  if (/\b403\b|PERMISSION_DENIED|forbidden/i.test(text)) return Object.assign(new Error("agy HTTP 403，请在终端运行 agy 检查账号权限"), { code: 403 });
  if (/\b401\b|UNAUTHENTICATED|sign[ -]?in|log[ -]?in|authentication|credential|token.{0,30}expired/i.test(text)) {
    return Object.assign(new Error("agy 未登录或登录已过期，请先运行 agy 登录"), { code: 401 });
  }
  return new Error("agy 未返回有效额度，请在终端运行 agy -p /usage --output-format json 检查");
}

export function parseAgyUsage(data) {
  if (data?.status !== "SUCCESS" || data.command?.name !== "usage" || (data.num_turns != null && data.num_turns !== 0)) {
    throw commandError(JSON.stringify(data));
  }
  const groups = data.command.data?.groups;
  if (!Array.isArray(groups)) throw commandError("");
  const windows = [];
  for (const group of groups) {
    if (!group || group.disabled || !Array.isArray(group.buckets)) continue;
    const family = group.name === "Gemini Models" ? "Gemini" : group.name === "Claude and GPT models" ? "Claude/GPT" : group.name;
    for (const bucket of group.buckets) {
      if (!bucket || bucket.disabled) continue;
      const cadence = bucket.window === "weekly" ? "每周" : bucket.window === "5h" ? "5 小时" : bucket.name || bucket.id;
      const fraction = bucket.remaining_fraction;
      const known = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
      const reset = parseTime(bucket.reset_time);
      windows.push({
        label: [family, cadence].filter(Boolean).join(" ") || "额度",
        usedPercent: known ? (1 - fraction) * 100 : null,
        // agy emits Unix epoch 0 ("1970-01-01T00:00:00Z") for untouched buckets.
        resetsAt: reset && Number.isFinite(reset.getTime()) && reset.getTime() > 0 ? reset.toISOString() : null,
      });
    }
  }
  if (!windows.length) throw new Error("agy 暂未提供可用额度，请在终端运行 agy 检查账号套餐");
  // The command report does not identify the subscription plan or local token history.
  return [null, windows];
}

export async function agyQuota(signal, { env = process.env, run = runAgyCommand, executable = agyPath({ env }) } = {}) {
  if (!executable) throw new Error("未登录");
  const directory = mkdtempSync(join(tmpdir(), "aiusage-agy-"));
  try {
    // Do not let a passive quota refresh launch an interactive browser sign-in.
    const windows = process.platform === "win32";
    for (const name of ["open", "xdg-open", "rundll32"]) {
      writeFileSync(join(directory, name + (windows ? ".cmd" : "")), windows ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    }
    const childEnv = { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true", BROWSER: join(directory, windows ? "open.cmd" : "open") };
    // Windows environment names are case-insensitive; pass only one PATH spelling.
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "path") delete childEnv[key];
    childEnv.PATH = directory + delimiter + pathValue(env);
    const options = { cwd: directory, env: childEnv, signal };
    const version = await run(executable, ["--version"], { ...options, timeoutMs: 5_000 });
    const match = version.stdout.trim().match(/^(?:agy\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\+\S+)?$/);
    const parts = match?.slice(1).map(Number);
    const difference = parts?.findIndex((part, index) => part !== MIN_VERSION[index]);
    if (version.code || !parts || (difference !== -1 && parts[difference] < MIN_VERSION[difference])) {
      throw new Error("agy 版本过旧或无法确认，请运行 agy update（需要 1.1.12+）");
    }
    const result = await run(executable, ["-p", "/usage", "--output-format", "json"], options);
    if (result.code) throw commandError(result.stderr + result.stdout);
    let data;
    try { data = parseJson(result.stdout); } catch { throw commandError(result.stderr); }
    return parseAgyUsage(data);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
