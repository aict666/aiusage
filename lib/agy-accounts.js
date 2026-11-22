import childProcess from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { configHome, parseJson, readJson, writePrivateJson } from "./files.js";
import { readCachedQuotaSnapshot } from "./quota-cache.js";

export const AGY_KEYCHAIN_SERVICE = "gemini";
export const AGY_KEYCHAIN_ACCOUNT = "antigravity";
export const VAULT_KEYCHAIN_SERVICE = "aiusage-agy-account";

const INDEX_VERSION = 1;
const MAX_ALIAS_LENGTH = 80;
const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/u;
const EMBEDDED_EMAIL_RE = /\b([a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,128}\.[a-zA-Z]{2,24})\b/gu;
const EMBEDDED_JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;

function hashHex(domain, input) {
  return createHash("sha256").update(domain).update(input).digest("hex").slice(0, 16);
}

function escapeSecurityArg(value) {
  const cleaned = String(value ?? "");
  if (/[\r\n\0]/u.test(cleaned)) throw new Error("钥匙串参数包含非法控制字符");
  return cleaned.replace(/(["\\])/gu, "\\$1");
}

function errorWithCode(message, code) {
  return Object.assign(new Error(message), { code });
}

export function agyAccountsDir({ env = process.env, homeDir = homedir(), platform = process.platform } = {}) {
  if (env.AIUSAGE_CONFIG_DIR) {
    return configHome("AIUSAGE_CONFIG_DIR", ".config/aiusage", { env, homeDir, platform });
  }
  if (platform === "darwin") return join(homeDir, "Library", "Application Support", "aiusage");
  if (platform === "win32") return join(env.APPDATA || join(homeDir, "AppData", "Roaming"), "aiusage");
  return join(env.XDG_CONFIG_HOME || join(homeDir, ".config"), "aiusage");
}

export function agyAccountsIndexPath(options = {}) {
  return join(agyAccountsDir(options), "agy-accounts.json");
}

export function agyScopeForAccount(accountId = null, { env = process.env, homeDir = homedir() } = {}) {
  return `${join(homeDir, ".gemini", "antigravity-cli")}\0${env.ANTIGRAVITY_CLI_PATH ?? "agy"}${accountId ? `\0${accountId}` : ""}`;
}

export function parseSecurityMetadata(stdout) {
  const text = String(stdout ?? "");
  const createdMatch = /"cdat"<timedate>=0x[0-9a-fA-F]+\s+"([^"\\]+)/u.exec(text);
  const modifiedMatch = /"mdat"<timedate>=0x[0-9a-fA-F]+\s+"([^"\\]+)/u.exec(text);
  return {
    createdAt: createdMatch ? createdMatch[1] : null,
    modifiedAt: modifiedMatch ? modifiedMatch[1] : null,
  };
}

export function parseSecurityGenericOutput(stdout, stderr) {
  const combined = `${stderr ?? ""}\n${stdout ?? ""}`;
  const hexMatch = /^password:\s+0x([0-9a-fA-F]+)(?:\s|$)/mu.exec(combined);
  if (hexMatch) {
    return {
      buffer: Buffer.from(hexMatch[1], "hex"),
      ...parseSecurityMetadata(stdout),
    };
  }
  const nullMatch = /^password:\s+<NULL>$/mu.exec(combined);
  if (nullMatch) {
    return {
      buffer: Buffer.alloc(0),
      ...parseSecurityMetadata(stdout),
    };
  }
  const asciiMatch = /^password:\s+"(.*)"$/mu.exec(combined);
  if (asciiMatch) {
    return {
      buffer: Buffer.from(asciiMatch[1], "utf8"),
      ...parseSecurityMetadata(stdout),
    };
  }
  throw new Error("无法解析钥匙串中的 agy 票据格式");
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || !EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function extractFields(node, found, depth = 0) {
  if (!node || typeof node !== "object" || depth > 3) return;
  if (Array.isArray(node)) {
    for (const item of node) extractFields(item, found, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase();
    if (typeof value === "string") {
      if (!found.email && (lower === "email" || lower === "user_email" || lower === "account_email" || lower === "account")) {
        const email = normalizeEmail(value);
        if (email) found.email = email;
      }
      if (!found.sub && (lower === "sub" || lower === "user_id" || lower === "userid" || lower === "account_id")) {
        const trimmed = value.trim();
        if (trimmed) found.sub = trimmed;
      }
      if (!found.refreshToken && (lower === "refresh_token" || lower === "refreshtoken")) {
        const trimmed = value.trim();
        if (trimmed) found.refreshToken = trimmed;
      }
      if (lower === "id_token" || lower === "idtoken") {
        const jwt = decodeJwtPayload(value);
        if (jwt) {
          if (!found.email) found.email = normalizeEmail(jwt.email);
          if (!found.sub && typeof jwt.sub === "string" && jwt.sub.trim()) found.sub = jwt.sub.trim();
        }
      }
    } else if (value && typeof value === "object") {
      extractFields(value, found, depth + 1);
    }
  }
}

function unwrapCredentialBuffer(raw) {
  const text = raw.toString("utf8").trim();
  if (text.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    const encoded = text.slice(GO_KEYRING_BASE64_PREFIX.length).trim();
    try {
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length > 0) return decoded;
    } catch { /* Fall back to raw bytes. */ }
  }
  // Handle raw base64-encoded JSON payloads without prefix.
  if (text.length >= 16 && /^[A-Za-z0-9+/=_-]+$/u.test(text)) {
    try {
      const decoded = Buffer.from(text.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
      const decodedTrimmed = decoded.toString("utf8").trim();
      if (decodedTrimmed.startsWith("{") || decodedTrimmed.startsWith("[")) return decoded;
    } catch { /* Fall back to raw bytes. */ }
  }
  return raw;
}

export function inspectAgyCredential(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
  const payloadHash = hashHex("agy-payload:v1:", raw);
  const unwrapped = unwrapCredentialBuffer(raw);
  const found = { email: null, sub: null, refreshToken: null };

  const text = unwrapped.toString("utf8");
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = parseJson(trimmed);
      extractFields(parsed, found);
    } catch {
      // Fall through to JWT & printable scan for non-JSON payloads.
    }
  }

  // Scan for any embedded JWT (e.g. id_token stored under a custom key or inside protobuf).
  if (!found.email || !found.sub) {
    for (const match of text.matchAll(EMBEDDED_JWT_RE)) {
      const jwt = decodeJwtPayload(match[0]);
      if (!jwt) continue;
      if (!found.email) found.email = normalizeEmail(jwt.email);
      if (!found.sub && typeof jwt.sub === "string" && jwt.sub.trim()) found.sub = jwt.sub.trim();
      if (found.email && found.sub) break;
    }
  }

  if (!found.email) {
    for (const match of text.matchAll(EMBEDDED_EMAIL_RE)) {
      const candidate = normalizeEmail(match[1]);
      if (!candidate) continue;
      const domain = candidate.split("@")[1].toLowerCase();
      if (domain.endsWith(".gserviceaccount.com") || domain === "oauth2.googleapis.com") continue;
      found.email = candidate;
      break;
    }
  }

  let identityHash = null;
  if (found.sub) {
    identityHash = hashHex("agy-identity:v1:sub:", found.sub);
  } else if (found.email) {
    identityHash = hashHex("agy-identity:v1:email:", found.email.toLowerCase());
  } else if (found.refreshToken) {
    identityHash = hashHex("agy-identity:v1:rt:", found.refreshToken);
  }

  return {
    email: found.email,
    identityHash,
    payloadHash,
  };
}

export function sanitizeAlias(raw) {
  const cleaned = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim();
  if (!cleaned) throw new Error("账号别名不能为空");
  if (cleaned === "-") throw new Error("别名不能使用 \"-\"（保留用于切换上一个账号）");
  if (cleaned.length > MAX_ALIAS_LENGTH) throw new Error(`账号别名不能超过 ${MAX_ALIAS_LENGTH} 个字符`);
  return cleaned;
}

function defaultAlias(accounts, email) {
  const used = new Set(accounts.map((item) => item.alias.toLowerCase()));
  if (email) {
    const cleanEmail = email.slice(0, MAX_ALIAS_LENGTH).trim();
    if (cleanEmail && cleanEmail !== "-" && !used.has(cleanEmail.toLowerCase())) return cleanEmail;
  }
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `账号 ${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `账号 ${Date.now()}`;
}

function isKeychainNotFound(error) {
  return error?.status === 44 || /could not be found in the keychain/i.test(String(error?.stderr ?? error?.message ?? ""));
}

function resolveTrustedAgyPaths(agyExecutable) {
  const paths = ["/usr/bin/security"];
  if (!agyExecutable) return paths;
  try {
    const real = realpathSync(agyExecutable);
    if (real && !paths.includes(real)) paths.push(real);
  } catch {
    if (!paths.includes(agyExecutable)) paths.push(agyExecutable);
  }
  return paths;
}

function findAgyBinary({ env = process.env, homeDir = homedir(), platform = process.platform } = {}) {
  const configured = env.ANTIGRAVITY_CLI_PATH;
  if (configured) {
    const candidate = configHome("ANTIGRAVITY_CLI_PATH", "", { env, homeDir, platform });
    try {
      accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      if (statSync(candidate).isFile()) return resolve(candidate);
    } catch { /* Ignore missing override here. */ }
    return null;
  }
  const binary = platform === "win32" ? "agy.exe" : "agy";
  const pathVal = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = [...pathVal.split(platform === "win32" ? ";" : delimiter).filter(Boolean), join(homeDir, ".local", "bin")];
  if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs) {
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      if (statSync(candidate).isFile()) return resolve(candidate);
    } catch { /* Try next directory. */ }
  }
  return null;
}

export function createMacKeychainStore({ spawnSync = childProcess.spawnSync, agyExecutable = null } = {}) {
  const runSecurity = (args, options = {}) => {
    const result = spawnSync("security", args, {
      encoding: "utf8",
      ...options,
    });
    if (result.error) throw result.error;
    return result;
  };

  const exists = (service, account) => {
    const result = runSecurity(["find-generic-password", "-s", service, "-a", account], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      return { exists: true, ...parseSecurityMetadata(result.stdout) };
    }
    if (isKeychainNotFound(result)) return { exists: false, createdAt: null, modifiedAt: null };
    throw new Error("无法检查 macOS 钥匙串状态");
  };

  const read = (service, account) => {
    const result = runSecurity(["find-generic-password", "-s", service, "-a", account, "-g"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      return parseSecurityGenericOutput(result.stdout, result.stderr);
    }
    if (isKeychainNotFound(result)) return null;
    if (/User interaction is not allowed|canceled|denied/i.test(String(result.stderr ?? ""))) {
      throw new Error("未获得 macOS 钥匙串访问授权，请在弹窗中允许后重试");
    }
    throw new Error("无法读取 macOS 钥匙串中的 agy 票据");
  };

  const write = (service, account, buffer, { trustAgy = false } = {}) => {
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
    const safeService = escapeSecurityArg(service);
    const safeAccount = escapeSecurityArg(account);
    const hexPayload = raw.toString("hex");
    const itemExists = exists(service, account).exists;
    const trustFlags = !itemExists && trustAgy
      ? resolveTrustedAgyPaths(agyExecutable).map((appPath) => `-T "${escapeSecurityArg(appPath)}"`).join(" ")
      : "";
    const updateFlag = itemExists ? "-U " : "";
    const trustSegment = trustFlags ? `${trustFlags} ` : "";
    // Pass hex payload over stdin (-i -X) so OAuth tokens never appear in process argv.
    const command = `add-generic-password ${updateFlag}-s "${safeService}" -a "${safeAccount}" ${trustSegment}-X ${hexPayload}\n`;
    const result = runSecurity(["-i"], {
      input: command,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const diag = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (result.status !== 0 || /security:\s*SecKeychain|error|denied|failed|invalid|canceled/i.test(diag)) {
      if (/User interaction is not allowed|canceled|denied/i.test(diag)) {
        throw new Error("未获得 macOS 钥匙串写入授权，请在弹窗中允许后重试");
      }
      throw new Error("写入 macOS 钥匙串失败，请检查钥匙串权限");
    }
    const meta = exists(service, account);
    if (!meta.exists) throw new Error("写入 macOS 钥匙串后校验失败");
    return meta;
  };

  const remove = (service, account) => {
    const result = runSecurity(["delete-generic-password", "-s", service, "-a", account], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 || isKeychainNotFound(result)) return true;
    throw new Error("删除 macOS 钥匙串项失败");
  };

  return { exists, read, write, remove };
}

function emptyIndex() {
  return { version: INDEX_VERSION, activeId: null, previousId: null, pinnedId: null, autoGuard: true, lastSwitchedAt: null, processAccounts: [], accounts: [] };
}

function sanitizeProcessAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  for (const item of raw) {
    if (!item || !Number.isInteger(item.pid) || item.pid <= 0 || typeof item.accountId !== "string" || !item.accountId) continue;
    const startedAtMs = typeof item.startedAtMs === "number" && Number.isFinite(item.startedAtMs) ? item.startedAtMs : null;
    cleaned.push({ pid: item.pid, startedAtMs, accountId: item.accountId });
  }
  return cleaned;
}

function readIndex(options = {}) {
  const path = agyAccountsIndexPath(options);
  try {
    const data = readJson(path);
    if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.accounts)) return emptyIndex();
    const accounts = data.accounts.filter((item) => item && typeof item.id === "string" && typeof item.alias === "string");
    const activeId = typeof data.activeId === "string" ? data.activeId : null;
    const pinnedId = typeof data.pinnedId === "string"
      ? data.pinnedId
      : (data.pinnedId === null ? null : activeId);
    return {
      version: INDEX_VERSION,
      activeId,
      previousId: typeof data.previousId === "string" ? data.previousId : null,
      pinnedId,
      autoGuard: data.autoGuard !== false,
      lastSwitchedAt: typeof data.lastSwitchedAt === "string" ? data.lastSwitchedAt : null,
      processAccounts: sanitizeProcessAccounts(data.processAccounts),
      accounts,
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyIndex();
    throw new Error("agy 账号索引文件损坏，请检查 agy-accounts.json");
  }
}

function writeIndex(index, options = {}) {
  const path = agyAccountsIndexPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateJson(path, {
    version: INDEX_VERSION,
    activeId: index.activeId ?? null,
    previousId: index.previousId ?? null,
    pinnedId: index.pinnedId ?? null,
    autoGuard: index.autoGuard !== false,
    lastSwitchedAt: index.lastSwitchedAt ?? null,
    processAccounts: sanitizeProcessAccounts(index.processAccounts),
    accounts: index.accounts,
  });
}

function readAccountCachedQuota(accountId, options = {}) {
  const scope = agyScopeForAccount(accountId, options);
  const snapshot = readCachedQuotaSnapshot("agy", scope, {
    directory: options.cacheDirectory ?? null,
    env: options.env,
    homeDir: options.homeDir,
    platform: options.platform,
  });
  if (!snapshot) return null;
  const nowDate = options.now instanceof Date ? options.now : options.now != null ? new Date(options.now) : new Date();
  const nowMs = nowDate.getTime();
  return {
    updated_at: snapshot.updatedAt,
    windows: snapshot.windows.map((window) => {
      const used = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) ? window.usedPercent : null;
      const remaining = used == null ? null : Math.max(0, Math.min(100, 100 - used));
      const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      const validReset = Number.isFinite(resetMs) && resetMs > 0;
      const resetPassed = validReset ? resetMs <= nowMs : false;
      return {
        label: window.label,
        used_percent: used,
        remaining_percent: remaining,
        resets_at: validReset ? window.resetsAt : null,
        reset_passed: resetPassed,
      };
    }),
  };
}

function publicAccount(account, activeId, options = null) {
  const base = {
    id: account.id,
    alias: account.alias,
    email: account.email ?? null,
    active: account.id === activeId,
    saved_at: account.savedAt ?? null,
    updated_at: account.updatedAt ?? null,
    last_used_at: account.lastUsedAt ?? null,
  };
  if (options) {
    base.quota = readAccountCachedQuota(account.id, options);
  }
  return base;
}

function ensureSupported(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && !options.keychain) {
    throw errorWithCode("当前仅支持在 macOS 上管理 agy 钥匙串账号", "UNSUPPORTED_PLATFORM");
  }
}

function getKeychain(options = {}) {
  if (options.keychain) return options.keychain;
  ensureSupported(options);
  const executable = options.agyExecutable ?? findAgyBinary({ env: options.env, homeDir: options.homeDir, platform: options.platform });
  return createMacKeychainStore({ agyExecutable: executable });
}

function matchLiveCredential(index, liveInfo, liveMeta) {
  if (!liveInfo) return null;
  const byPayload = index.accounts.find((item) => item.payloadHash && item.payloadHash === liveInfo.payloadHash);
  if (byPayload) return byPayload;
  if (liveInfo.identityHash) {
    const byIdentity = index.accounts.find((item) => item.identityHash && item.identityHash === liveInfo.identityHash);
    if (byIdentity) return byIdentity;
  }
  if (!liveInfo.identityHash && index.activeId && liveMeta?.createdAt) {
    const current = index.accounts.find((item) => item.id === index.activeId);
    if (current && !current.identityHash && current.keychainCreatedAt && current.keychainCreatedAt === liveMeta.createdAt) {
      return current;
    }
  }
  return null;
}

function resolveTargetAccount(index, rawTarget) {
  const target = String(rawTarget ?? "").trim();
  if (!target) throw new Error("请指定要切换的账号别名或序号");
  if (!index.accounts.length) throw new Error("尚未保存任何 agy 账号，请先保存当前账号");

  if (target === "-") {
    if (index.previousId) {
      const prev = index.accounts.find((item) => item.id === index.previousId && item.id !== index.activeId);
      if (prev) return prev;
    }
    if (index.accounts.length === 2 && index.activeId) {
      const other = index.accounts.find((item) => item.id !== index.activeId);
      if (other) return other;
    }
    throw new Error("没有可互切的上一个 agy 账号，请指定具体别名或序号");
  }

  const byId = index.accounts.find((item) => item.id === target);
  if (byId) return byId;

  const lower = target.toLowerCase();
  const byAlias = index.accounts.find((item) => item.alias.toLowerCase() === lower);
  if (byAlias) return byAlias;

  const byEmail = index.accounts.find((item) => item.email && item.email.toLowerCase() === lower);
  if (byEmail) return byEmail;

  if (/^\d+$/u.test(target)) {
    const idx = Number(target) - 1;
    if (idx >= 0 && idx < index.accounts.length) return index.accounts[idx];
  }

  throw new Error(`未找到 agy 账号：${target}`);
}

export function listRunningAgyProcesses(options = {}) {
  if (typeof options.listRunningAgyProcesses === "function") {
    return options.listRunningAgyProcesses()
      .map((item) => {
        if (typeof item === "number") return { pid: item, startedAtMs: null };
        if (item && Number.isInteger(item.pid) && item.pid > 0) {
          const startedAtMs = typeof item.startedAtMs === "number" && Number.isFinite(item.startedAtMs) ? item.startedAtMs : null;
          return { pid: item.pid, startedAtMs };
        }
        return null;
      })
      .filter(Boolean);
  }
  if (typeof options.listRunningAgyPids === "function") {
    return options.listRunningAgyPids()
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .map((pid) => ({ pid, startedAtMs: null }));
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || options.keychain) return [];
  try {
    const result = childProcess.spawnSync("ps", ["-eo", "pid=,lstart=,comm=,args="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || !result.stdout) return [];
    const procs = [];
    for (const rawLine of result.stdout.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = /^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)(?:\s+(.*))?$/u.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const startedRaw = match[2];
      const comm = match[3];
      const args = match[4] ?? "";
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const base = comm.split("/").pop();
      if (base !== "agy") continue;
      // Never touch aiusage's own read-only usage probes.
      if (/(?:^|\s)(?:-p|--print)\s+\/usage(?:\s|$)/u.test(args)) continue;
      const parsedMs = Date.parse(startedRaw);
      procs.push({ pid, startedAtMs: Number.isFinite(parsedMs) ? parsedMs : null });
    }
    return procs;
  } catch {
    return [];
  }
}

export function listRunningAgyPids(options = {}) {
  return listRunningAgyProcesses(options).map((item) => item.pid);
}

function sameProcessRecord(entry, proc) {
  if (!entry || !proc || entry.pid !== proc.pid) return false;
  if (Number.isFinite(entry.startedAtMs) && Number.isFinite(proc.startedAtMs)) {
    return Math.abs(entry.startedAtMs - proc.startedAtMs) <= 2000;
  }
  return true;
}

function tagRunningProcessesAsAccount(index, runningProcs, accountId) {
  const existing = sanitizeProcessAccounts(index.processAccounts);
  const alive = existing.filter((entry) => runningProcs.some((proc) => sameProcessRecord(entry, proc)));
  for (const proc of runningProcs) {
    if (!alive.some((entry) => sameProcessRecord(entry, proc))) {
      alive.push({ pid: proc.pid, startedAtMs: proc.startedAtMs ?? null, accountId });
    }
  }
  index.processAccounts = alive;
}

function classifyRunningAgyProcesses(index, options = {}) {
  const running = listRunningAgyProcesses(options);
  const activeId = index.activeId ?? null;
  const recorded = sanitizeProcessAccounts(index.processAccounts);
  const switchedMs = index.lastSwitchedAt ? Date.parse(index.lastSwitchedAt) : NaN;
  // ps lstart has 1-second granularity; require strictly older than switch second to avoid false positives.
  const switchFloorMs = Number.isFinite(switchedMs) ? Math.floor(switchedMs / 1000) * 1000 - 1000 : NaN;

  const stale = [];
  const current = [];
  for (const proc of running) {
    const entry = recorded.find((item) => sameProcessRecord(item, proc));
    if (entry) {
      if (activeId && entry.accountId === activeId) {
        current.push(proc);
      } else {
        stale.push(proc);
      }
    } else if (Number.isFinite(switchFloorMs) && Number.isFinite(proc.startedAtMs) && proc.startedAtMs < switchFloorMs) {
      stale.push(proc);
    } else {
      current.push(proc);
    }
  }
  return { running, stale, current };
}

function sendSigtermToPids(pids, options = {}) {
  const killFn = typeof options.killPid === "function" ? options.killPid : (pid, sig) => process.kill(pid, sig);
  const stopped = [];
  for (const pid of pids) {
    try {
      killFn(pid, "SIGTERM");
      stopped.push(pid);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        // Ignore individual permission errors so other idle agy sessions still exit cleanly.
      }
    }
  }
  return stopped;
}

export function stopRunningAgyProcesses({ all = false, ...options } = {}) {
  const index = readIndex(options);
  const { running, stale, current } = classifyRunningAgyProcesses(index, options);
  const targets = all ? running : stale;
  const targetPids = targets.map((item) => item.pid);
  const stopped = sendSigtermToPids(targetPids, options);
  if (stopped.length > 0 && Array.isArray(index.processAccounts) && index.processAccounts.length > 0) {
    const stoppedSet = new Set(stopped);
    const nextRecords = index.processAccounts.filter((entry) => !stoppedSet.has(entry.pid));
    if (nextRecords.length !== index.processAccounts.length) {
      index.processAccounts = nextRecords;
      try { writeIndex(index, options); } catch { /* Best-effort cleanup. */ }
    }
  }
  return {
    stopped_count: stopped.length,
    stopped_pids: stopped,
    remaining_count: Math.max(0, targetPids.length - stopped.length),
    skipped_current_count: all ? 0 : current.length,
  };
}

function reconcileLiveKeychain(index, { verify = false, allowGuard = true, now = new Date(), ...options } = {}) {
  const platform = options.platform ?? process.platform;
  const supported = platform === "darwin" || Boolean(options.keychain);
  let loggedIn = null;
  let liveStatus = "unknown";
  let liveEmail = null;
  let keychainChanged = false;
  let reconciledFrom = null;
  let guarded = false;
  let guardedOverwriter = null;
  let activeId = index.activeId;

  if (!supported) {
    return { supported, loggedIn, liveStatus, liveEmail, keychainChanged, reconciledFrom, guarded, guardedOverwriter, activeId };
  }

  const keychain = getKeychain(options);
  backfillVaultMetadata(index, keychain, options);

  let meta = null;
  try {
    meta = keychain.exists(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
  } catch {
    return { supported, loggedIn: null, liveStatus: "unknown", liveEmail: null, keychainChanged: false, reconciledFrom: null, guarded: false, guardedOverwriter: null, activeId };
  }

  loggedIn = meta.exists;
  if (!meta.exists) {
    liveStatus = "logged_out";
    if (index.activeId != null || index.pinnedId != null) {
      const prev = index.accounts.find((item) => item.id === index.activeId);
      if (prev) reconciledFrom = prev.alias;
      if (index.activeId != null) index.previousId = index.activeId;
      index.activeId = null;
      index.pinnedId = null;
      try { writeIndex(index, options); } catch { /* Best-effort sync. */ }
    }
    return { supported, loggedIn: false, liveStatus, liveEmail: null, keychainChanged: Boolean(reconciledFrom), reconciledFrom, guarded: false, guardedOverwriter: null, activeId: null };
  }

  // With zero saved accounts and verify=false, avoid prompting Keychain for secret bytes.
  if (!verify && index.accounts.length === 0) {
    return { supported, loggedIn: true, liveStatus: "unsaved", liveEmail: null, keychainChanged: false, reconciledFrom: null, guarded: false, guardedOverwriter: null, activeId: null };
  }

  // Always verify actual Keychain payload bytes (SHA-256 payloadHash) when accounts are saved:
  // macOS Keychain `mdat` only has 1-second granularity, so back-to-back writes by multiple old
  // agy processes within the same second can produce an identical `mdat` while changing the account!
  const active = index.activeId ? index.accounts.find((item) => item.id === index.activeId) ?? null : null;
  let live;
  try {
    live = keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
  } catch {
    const cdatMismatch = Boolean(active?.keychainCreatedAt && meta.createdAt && active.keychainCreatedAt !== meta.createdAt);
    const mdatMismatch = Boolean(active?.keychainModifiedAt && meta.modifiedAt && active.keychainModifiedAt !== meta.modifiedAt);
    return {
      supported,
      loggedIn: true,
      liveStatus: active && !cdatMismatch && !mdatMismatch ? "matched" : "changed",
      liveEmail: active?.email ?? null,
      keychainChanged: cdatMismatch || mdatMismatch,
      reconciledFrom: null,
      guarded: false,
      guardedOverwriter: null,
      activeId,
    };
  }

  if (!live || live.buffer.length === 0) {
    if (index.activeId != null || index.pinnedId != null) {
      index.activeId = null;
      index.pinnedId = null;
      try { writeIndex(index, options); } catch { /* Best-effort sync. */ }
    }
    return { supported, loggedIn: false, liveStatus: "logged_out", liveEmail: null, keychainChanged: false, reconciledFrom: null, guarded: false, guardedOverwriter: null, activeId: null };
  }

  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  const liveInfo = inspectAgyCredential(live.buffer);
  liveEmail = liveInfo.email;
  const matched = matchLiveCredential(index, liveInfo, live);
  let dirty = false;

  if (matched) {
    if (matched.payloadHash !== liveInfo.payloadHash) {
      try {
        keychain.write(VAULT_KEYCHAIN_SERVICE, matched.id, live.buffer);
        matched.payloadHash = liveInfo.payloadHash;
        matched.updatedAt = iso;
        dirty = true;
      } catch { /* Never fail read-only listing if vault write fails. */ }
    }
    if (liveInfo.email && matched.email !== liveInfo.email) {
      matched.email = liveInfo.email;
      dirty = true;
    }
    if (liveInfo.identityHash && matched.identityHash !== liveInfo.identityHash) {
      matched.identityHash = liveInfo.identityHash;
      dirty = true;
    }

    const pinned = allowGuard && index.autoGuard !== false && index.pinnedId
      ? index.accounts.find((item) => item.id === index.pinnedId) ?? null
      : null;

    // Auto-guard: when an old running agy process refreshes another SAVED account's token
    // and overwrites the shared Keychain slot, preserve its fresh token in vault (done above)
    // and immediately restore the user's pinned account back to Keychain.
    if (pinned && pinned.id !== matched.id) {
      try {
        const pinnedVault = keychain.read(VAULT_KEYCHAIN_SERVICE, pinned.id);
        if (pinnedVault && pinnedVault.buffer.length > 0) {
          const restoredMeta = keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, pinnedVault.buffer, { trustAgy: true });
          pinned.keychainCreatedAt = restoredMeta?.createdAt ?? pinned.keychainCreatedAt ?? null;
          pinned.keychainModifiedAt = restoredMeta?.modifiedAt ?? pinned.keychainModifiedAt ?? null;
          index.activeId = pinned.id;
          activeId = pinned.id;
          liveStatus = "matched";
          liveEmail = pinned.email ?? null;
          guarded = true;
          guardedOverwriter = matched.alias;
          keychainChanged = false;
          reconciledFrom = null;
          dirty = true;
          try { writeIndex(index, options); } catch { /* Best-effort sync. */ }
          return { supported, loggedIn: true, liveStatus, liveEmail, keychainChanged, reconciledFrom, guarded, guardedOverwriter, activeId };
        }
      } catch {
        // Fall through to honest reconciliation below if Keychain restore cannot write.
      }
    }

    liveStatus = "matched";
    activeId = matched.id;
    const nextCreated = live.createdAt ?? meta.createdAt ?? null;
    const nextModified = live.modifiedAt ?? meta.modifiedAt ?? null;
    if (nextCreated && matched.keychainCreatedAt !== nextCreated) {
      matched.keychainCreatedAt = nextCreated;
      dirty = true;
    }
    if (nextModified && matched.keychainModifiedAt !== nextModified) {
      matched.keychainModifiedAt = nextModified;
      dirty = true;
    }
    if (index.activeId !== matched.id) {
      if (index.activeId) {
        const prev = index.accounts.find((item) => item.id === index.activeId);
        if (prev) reconciledFrom = prev.alias;
        index.previousId = index.activeId;
      }
      index.activeId = matched.id;
      keychainChanged = Boolean(reconciledFrom);
      dirty = true;
    }
  } else {
    // Brand-new unsaved login: NEVER overwrite it with an older pinned account.
    liveStatus = "unsaved";
    activeId = null;
    if (index.activeId != null || index.pinnedId != null) {
      const prev = index.accounts.find((item) => item.id === index.activeId);
      if (prev) reconciledFrom = prev.alias;
      if (index.activeId != null) index.previousId = index.activeId;
      index.activeId = null;
      index.pinnedId = null;
      keychainChanged = true;
      dirty = true;
    }
  }

  if (dirty) {
    try { writeIndex(index, options); } catch { /* Best-effort sync. */ }
  }

  return { supported, loggedIn: true, liveStatus, liveEmail, keychainChanged, reconciledFrom, guarded, guardedOverwriter, activeId };
}

/**
 * Passive, zero-keychain-secret read by default; pass { reconcile: true } before live
 * quota polling so Keychain overwrites by external agy processes never poison cache scopes.
 */
export function readAgyAccountSummary({ reconcile = false, ...options } = {}) {
  try {
    const index = readIndex(options);
    if (reconcile && index.accounts.length > 0) {
      reconcileLiveKeychain(index, { verify: false, ...options });
    }
    const activeAccount = index.activeId
      ? index.accounts.find((item) => item.id === index.activeId) ?? null
      : null;
    return {
      activeId: activeAccount ? activeAccount.id : null,
      previousId: index.previousId,
      activeAccount: activeAccount ? publicAccount(activeAccount, activeAccount.id) : null,
      accounts: index.accounts.map((item) => publicAccount(item, activeAccount?.id ?? null)),
    };
  } catch {
    return { activeId: null, previousId: null, activeAccount: null, accounts: [] };
  }
}

function backfillVaultMetadata(index, keychain, options) {
  let dirty = false;
  for (const item of index.accounts) {
    if (item.email && item.identityHash) continue;
    if (item.metadataBackfilledVersion === 2) continue;
    try {
      const entry = keychain.read(VAULT_KEYCHAIN_SERVICE, item.id);
      if (entry && entry.buffer.length > 0) {
        const info = inspectAgyCredential(entry.buffer);
        if (info.email && !item.email) item.email = info.email;
        if (info.identityHash && !item.identityHash) item.identityHash = info.identityHash;
        item.metadataBackfilledVersion = 2;
        dirty = true;
      }
    } catch { /* Never fail listing if an individual vault item cannot be inspected. */ }
  }
  if (dirty) {
    try { writeIndex(index, options); } catch { /* Best-effort cache write. */ }
  }
}

export function listAgyAccounts({ verify = false, ...options } = {}) {
  const index = readIndex(options);
  const state = reconcileLiveKeychain(index, { verify, ...options });
  const procStats = classifyRunningAgyProcesses(index, options);

  return {
    supported: state.supported,
    logged_in: state.loggedIn,
    live_status: state.liveStatus,
    live_email: state.liveEmail,
    keychain_changed: state.keychainChanged,
    reconciled_from: state.reconciledFrom,
    guarded: state.guarded,
    guarded_overwriter: state.guardedOverwriter,
    auto_guard: index.autoGuard !== false,
    pinned_id: index.pinnedId,
    running_agy_count: procStats.running.length,
    stale_agy_count: procStats.stale.length,
    active_id: state.activeId,
    previous_id: index.previousId,
    accounts: index.accounts.map((item) => publicAccount(item, state.activeId, options)),
  };
}

export function guardAgyKeychain(options = {}) {
  const index = readIndex(options);
  const state = reconcileLiveKeychain(index, { verify: false, allowGuard: true, ...options });
  const active = state.activeId ? index.accounts.find((item) => item.id === state.activeId) ?? null : null;
  const procStats = classifyRunningAgyProcesses(index, options);
  return {
    supported: state.supported,
    logged_in: state.loggedIn,
    live_status: state.liveStatus,
    guarded: state.guarded,
    guarded_overwriter: state.guardedOverwriter,
    reconciled_from: state.reconciledFrom,
    auto_guard: index.autoGuard !== false,
    active_id: state.activeId,
    active_alias: active?.alias ?? null,
    running_agy_count: procStats.running.length,
    stale_agy_count: procStats.stale.length,
  };
}

export function setAgyAutoGuard(enabled, options = {}) {
  const index = readIndex(options);
  index.autoGuard = Boolean(enabled);
  if (index.autoGuard && !index.pinnedId && index.activeId) {
    index.pinnedId = index.activeId;
  }
  writeIndex(index, options);
  return {
    action: "auto_guard_updated",
    auto_guard: index.autoGuard,
    pinned_id: index.pinnedId,
    accounts: index.accounts.map((item) => publicAccount(item, index.activeId)),
  };
}

export function saveCurrentAgyAccount({ alias = null, now = new Date(), ...options } = {}) {
  ensureSupported(options);
  const keychain = getKeychain(options);
  const live = keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
  if (!live || live.buffer.length === 0) {
    throw errorWithCode("当前未登录 agy，请先在终端运行 agy 完成登录后再保存", "NOT_LOGGED_IN");
  }

  const index = readIndex(options);
  const info = inspectAgyCredential(live.buffer);
  const matched = matchLiveCredential(index, info, live);
  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  const desiredAlias = alias != null && String(alias).trim() !== "" ? sanitizeAlias(alias) : null;

  if (desiredAlias) {
    const duplicate = index.accounts.find(
      (item) => item.alias.toLowerCase() === desiredAlias.toLowerCase() && (!matched || item.id !== matched.id),
    );
    if (duplicate) throw new Error(`别名「${desiredAlias}」已存在，请换一个名称`);
  }

  if (matched) {
    keychain.write(VAULT_KEYCHAIN_SERVICE, matched.id, live.buffer);
    if (desiredAlias) matched.alias = desiredAlias;
    if (info.email) matched.email = info.email;
    if (info.identityHash) matched.identityHash = info.identityHash;
    matched.payloadHash = info.payloadHash;
    matched.keychainCreatedAt = live.createdAt ?? matched.keychainCreatedAt ?? null;
    matched.keychainModifiedAt = live.modifiedAt ?? matched.keychainModifiedAt ?? null;
    matched.updatedAt = iso;
    matched.lastUsedAt = iso;
    if (index.activeId && index.activeId !== matched.id) index.previousId = index.activeId;
    index.activeId = matched.id;
    index.pinnedId = matched.id;
    writeIndex(index, options);
    return {
      action: "updated",
      account: publicAccount(matched, index.activeId),
      accounts: index.accounts.map((item) => publicAccount(item, index.activeId)),
    };
  }

  const id = `agy_${randomBytes(6).toString("hex")}`;
  const finalAlias = desiredAlias || defaultAlias(index.accounts, info.email);
  keychain.write(VAULT_KEYCHAIN_SERVICE, id, live.buffer);

  const entry = {
    id,
    alias: finalAlias,
    email: info.email,
    identityHash: info.identityHash,
    payloadHash: info.payloadHash,
    keychainCreatedAt: live.createdAt ?? null,
    keychainModifiedAt: live.modifiedAt ?? null,
    savedAt: iso,
    updatedAt: iso,
    lastUsedAt: iso,
  };
  if (index.activeId && index.activeId !== id) index.previousId = index.activeId;
  index.activeId = id;
  index.pinnedId = id;
  index.accounts.push(entry);
  writeIndex(index, options);

  return {
    action: "saved",
    account: publicAccount(entry, index.activeId),
    accounts: index.accounts.map((item) => publicAccount(item, index.activeId)),
  };
}

export function switchAgyAccount(target, { force = false, closeRunning = false, now = new Date(), ...options } = {}) {
  ensureSupported(options);
  const keychain = getKeychain(options);
  const index = readIndex(options);
  const chosen = resolveTargetAccount(index, target);
  const vaultEntry = keychain.read(VAULT_KEYCHAIN_SERVICE, chosen.id);
  if (!vaultEntry || vaultEntry.buffer.length === 0) {
    throw errorWithCode(`钥匙串中缺少「${chosen.alias}」的已保存票据，请删除后重新保存`, "MISSING_VAULT_ITEM");
  }

  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  const live = keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
  let syncedCurrent = null;
  let previousActive = index.activeId ? index.accounts.find((item) => item.id === index.activeId) ?? null : null;

  if (live && live.buffer.length > 0) {
    const liveInfo = inspectAgyCredential(live.buffer);
    const matched = matchLiveCredential(index, liveInfo, live);
    if (matched) {
      previousActive = matched;
      if (matched.payloadHash !== liveInfo.payloadHash) {
        keychain.write(VAULT_KEYCHAIN_SERVICE, matched.id, live.buffer);
        matched.payloadHash = liveInfo.payloadHash;
        if (liveInfo.email) matched.email = liveInfo.email;
        if (liveInfo.identityHash) matched.identityHash = liveInfo.identityHash;
        matched.updatedAt = iso;
        syncedCurrent = matched.alias;
      }
      if (matched.id === chosen.id) {
        matched.lastUsedAt = iso;
        matched.keychainCreatedAt = live.createdAt ?? matched.keychainCreatedAt ?? null;
        matched.keychainModifiedAt = live.modifiedAt ?? matched.keychainModifiedAt ?? null;
        index.activeId = matched.id;
        index.pinnedId = matched.id;
        writeIndex(index, options);
        const procStats = classifyRunningAgyProcesses(index, options);
        return {
          action: "already_active",
          account: publicAccount(matched, index.activeId),
          previous_account: null,
          synced_current: syncedCurrent,
          stopped_agy_count: 0,
          running_agy_count: procStats.running.length,
          stale_agy_count: procStats.stale.length,
          auto_guard: index.autoGuard !== false,
          accounts: index.accounts.map((item) => publicAccount(item, index.activeId)),
        };
      }
    } else if (!force) {
      throw errorWithCode(
        "当前已登录的 agy 账号尚未保存，为避免覆盖丢失登录态，请先保存当前账号后再切换（或加 --force 强制覆盖）",
        "UNSAVED_ACTIVE_ACCOUNT",
      );
    }
  }

  // Record every currently running agy process as belonging to the pre-switch account
  // (preserving earlier tags if a process originated from an even earlier account).
  const runningNow = listRunningAgyProcesses(options);
  const previousTag = previousActive?.id ?? "__previous__";
  tagRunningProcessesAsAccount(index, runningNow, previousTag);
  index.lastSwitchedAt = iso;

  const staleTargets = runningNow.filter((proc) => {
    const entry = index.processAccounts.find((item) => sameProcessRecord(item, proc));
    return !entry || entry.accountId !== chosen.id;
  });

  let stoppedCount = 0;
  if (closeRunning && staleTargets.length > 0) {
    const stoppedPids = sendSigtermToPids(staleTargets.map((item) => item.pid), options);
    stoppedCount = stoppedPids.length;
    if (stoppedPids.length > 0) {
      const stoppedSet = new Set(stoppedPids);
      index.processAccounts = index.processAccounts.filter((entry) => !stoppedSet.has(entry.pid));
    }
  }

  const writtenMeta = keychain.write(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, vaultEntry.buffer, { trustAgy: true });
  const targetInfo = inspectAgyCredential(vaultEntry.buffer);
  chosen.payloadHash = targetInfo.payloadHash;
  if (targetInfo.email) chosen.email = targetInfo.email;
  if (targetInfo.identityHash) chosen.identityHash = targetInfo.identityHash;
  chosen.keychainCreatedAt = writtenMeta?.createdAt ?? chosen.keychainCreatedAt ?? null;
  chosen.keychainModifiedAt = writtenMeta?.modifiedAt ?? chosen.keychainModifiedAt ?? null;
  chosen.lastUsedAt = iso;

  if (previousActive && previousActive.id !== chosen.id) {
    index.previousId = previousActive.id;
  }
  index.activeId = chosen.id;
  index.pinnedId = chosen.id;
  writeIndex(index, options);

  const remainingStaleCount = Math.max(0, staleTargets.length - stoppedCount);
  return {
    action: "switched",
    account: publicAccount(chosen, index.activeId),
    previous_account: previousActive && previousActive.id !== chosen.id ? publicAccount(previousActive, index.activeId) : null,
    synced_current: syncedCurrent,
    stopped_agy_count: stoppedCount,
    running_agy_count: Math.max(0, runningNow.length - stoppedCount),
    stale_agy_count: remainingStaleCount,
    auto_guard: index.autoGuard !== false,
    accounts: index.accounts.map((item) => publicAccount(item, index.activeId)),
  };
}

export function prepareNewAgyLogin({ force = false, now = new Date(), ...options } = {}) {
  ensureSupported(options);
  const keychain = getKeychain(options);
  const index = readIndex(options);
  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  const live = keychain.read(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
  let syncedAccount = null;
  let loggedOutAccountId = index.activeId ?? "__previous__";

  if (live && live.buffer.length > 0) {
    const liveInfo = inspectAgyCredential(live.buffer);
    const matched = matchLiveCredential(index, liveInfo, live);
    if (matched) {
      loggedOutAccountId = matched.id;
      if (matched.payloadHash !== liveInfo.payloadHash) {
        keychain.write(VAULT_KEYCHAIN_SERVICE, matched.id, live.buffer);
        matched.payloadHash = liveInfo.payloadHash;
        if (liveInfo.email) matched.email = liveInfo.email;
        if (liveInfo.identityHash) matched.identityHash = liveInfo.identityHash;
        matched.updatedAt = iso;
      }
      syncedAccount = matched.alias;
      index.previousId = matched.id;
    } else if (!force) {
      throw errorWithCode(
        "当前已登录的 agy 账号尚未保存，请先保存当前账号后再退出（或加 --force 强制退出）",
        "UNSAVED_ACTIVE_ACCOUNT",
      );
    }
    keychain.remove(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
  }

  const runningNow = listRunningAgyProcesses(options);
  tagRunningProcessesAsAccount(index, runningNow, loggedOutAccountId);
  index.lastSwitchedAt = iso;
  index.activeId = null;
  index.pinnedId = null;
  writeIndex(index, options);
  return {
    action: "logged_out",
    synced_account: syncedAccount,
    stale_agy_count: runningNow.length,
    accounts: index.accounts.map((item) => publicAccount(item, null)),
  };
}

export function renameAgyAccount(target, newAlias, { now = new Date(), ...options } = {}) {
  const index = readIndex(options);
  const chosen = resolveTargetAccount(index, target);
  const rawNew = String(newAlias ?? "").trim();
  const cleaned = !rawNew && chosen.email
    ? sanitizeAlias(chosen.email.slice(0, MAX_ALIAS_LENGTH))
    : sanitizeAlias(rawNew);
  const duplicate = index.accounts.find(
    (item) => item.id !== chosen.id && item.alias.toLowerCase() === cleaned.toLowerCase(),
  );
  if (duplicate) throw new Error(`别名「${cleaned}」已存在，请换一个名称`);
  const previousAlias = chosen.alias;
  chosen.alias = cleaned;
  chosen.updatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  writeIndex(index, options);
  return {
    action: "renamed",
    previous_alias: previousAlias,
    account: publicAccount(chosen, index.activeId),
    accounts: index.accounts.map((item) => publicAccount(item, index.activeId)),
  };
}

export function removeAgyAccount(target, options = {}) {
  ensureSupported(options);
  const keychain = getKeychain(options);
  const index = readIndex(options);
  const chosen = resolveTargetAccount(index, target);
  keychain.remove(VAULT_KEYCHAIN_SERVICE, chosen.id);
  index.accounts = index.accounts.filter((item) => item.id !== chosen.id);
  if (index.activeId === chosen.id) index.activeId = null;
  if (index.pinnedId === chosen.id) index.pinnedId = null;
  if (index.previousId === chosen.id) index.previousId = null;
  writeIndex(index, options);
  return {
    action: "removed",
    removed: publicAccount(chosen, null),
    accounts: index.accounts.map((item) => publicAccount(item, index.activeId)),
  };
}

function shortWindowLabel(label) {
  return String(label || "")
    .replace(/Claude\/GPT/u, "Claude")
    .replace(/Gemini 4 Argon/u, "Argon")
    .replace(/\s*5 小时/u, " 5h")
    .replace(/\s*每周/u, " 周")
    .trim();
}

function formatCompactCountdown(iso, nowMs) {
  const targetMs = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(targetMs)) return null;
  const deltaMin = Math.round((targetMs - nowMs) / 60_000);
  if (deltaMin <= 0) return "已到点";
  if (deltaMin < 60) return `${deltaMin}m后重置`;
  const hours = Math.floor(deltaMin / 60);
  const mins = deltaMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m后重置` : `${hours}h后重置`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}d${remH}h后重置` : `${days}d后重置`;
}

function formatShortClock(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatAgyAccountsList(data, { now = new Date() } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const lines = [];
  if (!data.supported) {
    lines.push("当前系统暂不支持 agy 钥匙串账号管理（目前仅支持 macOS）。");
    return `${lines.join("\n")}\n`;
  }
  if (!data.accounts.length) {
    lines.push("尚未保存任何 agy 账号。");
    lines.push(data.logged_in
      ? "检测到当前已登录 agy，运行 aiusage agy save <别名> 即可保存当前票据。"
      : "请先在终端运行 agy 登录，再运行 aiusage agy save <别名> 保存票据。");
    return `${lines.join("\n")}\n`;
  }
  lines.push("已保存的 agy 账号：");
  data.accounts.forEach((account, index) => {
    const marker = account.active ? "*" : " ";
    const showEmail = account.email && account.email.toLowerCase() !== account.alias.toLowerCase();
    const emailPart = showEmail ? `  (${account.email})` : "";
    const statePart = account.active ? "  [当前]" : "";
    lines.push(`  ${marker} ${index + 1}. ${account.alias}${emailPart}${statePart}`);
    if (account.quota?.windows?.length) {
      const clock = formatShortClock(account.quota.updated_at);
      const summary = account.quota.windows.map((win) => {
        const name = shortWindowLabel(win.label);
        if (win.reset_passed && (win.used_percent ?? 0) > 0) {
          const prevRem = win.remaining_percent != null ? `（上次 ${Math.round(win.remaining_percent)}%）` : "";
          return `${name} 已到重置点${prevRem}`;
        }
        if (win.remaining_percent == null) return `${name} 未知`;
        const rem = Math.round(win.remaining_percent);
        const cd = rem <= 30 ? formatCompactCountdown(win.resets_at, nowMs) : null;
        return cd ? `${name} ${rem}% (${cd})` : `${name} ${rem}%`;
      }).join(" · ");
      lines.push(`       上次快照${clock ? ` ${clock}` : ""}：${summary}`);
    } else if (!account.active) {
      lines.push("       暂无额度快照（切过去查询一次后自动记录）");
    }
  });
  if (data.live_status === "unsaved") {
    const extra = data.live_email ? `（${data.live_email}）` : "";
    lines.push(`\n提示：当前活跃的 agy 登录${extra}尚未保存，可运行 aiusage agy save <别名> 保存。`);
  } else if (data.live_status === "changed") {
    lines.push("\n提示：检测到系统钥匙串中的 agy 登录已变动，可运行 aiusage agy list --verify 核对或重新保存。");
  } else if (data.live_status === "logged_out") {
    lines.push("\n当前未登录 agy，可直接运行 aiusage agy switch <别名> 恢复已保存账号，或运行 agy 登录新账号。");
  }
  return `${lines.join("\n")}\n`;
}
