import childProcess from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { TokenBuckets, normalizePercent, parseTime } from "./time.js";
import { configHome, parseJson, readJson, writePrivateJson } from "./files.js";
import { agyUsage, claudeUsage, codexUsage, grokUsage } from "./usage.js";
import { httpJson } from "./http.js";
import { QuotaCache } from "./quota-cache.js";
import { agyQuota } from "./agy.js";
import { agyScopeForAccount, readAgyAccountSummary } from "./agy-accounts.js";
import { computeWindowPace } from "./pace.js";
import { TokenScanSession, walkJsonl } from "./token-cache.js";

import { claudeResetCredits, codexResetCredits, fetchGrokResetCredits, optionalResetCredits } from "./reset-credits.js";

export class Window {
  constructor(label, usedPercent, resetsAt, windowSeconds = null) {
    this.label = label;
    this.usedPercent = usedPercent == null ? null : Number(usedPercent);
    this.resetsAt = resetsAt ?? null;
    if (windowSeconds != null) this.windowSeconds = Number(windowSeconds);
  }
}

export class ProviderReport {
  constructor({ name, plan = null, account = null, windows = [], tokens = null, error = null, skipped = false, quota = null, tokenError = null, tokensSupported = true, resetCredits = null }) {
    this.name = name;
    this.plan = plan;
    this.account = account;
    this.windows = windows;
    this.tokens = tokens;
    this.error = error;
    this.skipped = skipped;
    this.quota = quota;
    this.tokenError = tokenError;
    this.tokensSupported = tokensSupported;
    this.resetCredits = resetCredits;
  }

  toJSON(now = new Date()) {
    return {
      name: this.name,
      plan: this.plan,
      ...(this.account ? { account: this.account } : {}),
      ...(this.resetCredits ? { reset_credits: this.resetCredits } : {}),
      windows: this.windows.map((window) => {
        const pace = computeWindowPace(window, now);
        return {
          label: window.label,
          used_percent: window.usedPercent,
          resets_at: window.resetsAt,
          ...(pace ? { pace } : {}),
        };
      }),
      tokens: this.tokens,
      ...(this.tokensSupported ? {} : { tokens_supported: false }),
      error: this.error,
      skipped: this.skipped,
      ...(this.quota ? { quota: this.quota } : {}),
    };
  }
}

function claudeHome() {
  return configHome("CLAUDE_CONFIG_DIR", ".claude");
}

function codexHome() {
  return configHome("CODEX_HOME", ".codex");
}

function grokHome() {
  return configHome("GROK_HOME", ".grok");
}

function agyHome() {
  return configHome("AGY_HOME", ".gemini/antigravity-cli");
}

export function claudeUsageTotal(usage) {
  return claudeUsage(usage).total;
}

function recent(path, oldest) {
  try {
    const info = lstatSync(path);
    return !info.isSymbolicLink() && info.mtime >= new Date(oldest.getTime() - 86400000);
  } catch {
    return false;
  }
}

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

function claudeNeedsRefresh(oauth) {
  return typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now() + 60_000;
}

async function refreshClaude(oauth, signal) {
  if (!oauth.refreshToken) throw new Error("登录已过期，请重新打开 Claude Code");
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: CLAUDE_CLIENT_ID,
  });
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  let lastError = null;
  for (const url of ["https://platform.claude.com/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"]) {
    try {
      const data = await httpJson(url, { headers, body, signal });
      if (!data.access_token) continue;
      return {
        ...oauth,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || oauth.refreshToken,
        expiresAt: Date.now() + Number(data.expires_in || 0) * 1000,
      };
    } catch (error) {
      // A second OAuth endpoint must never bypass throttling or an auth refusal.
      if (![404, 410].includes(error.code)) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("登录已过期，请重新打开 Claude Code");
}

export function parseKeychainAccount(metadataText) {
  if (typeof metadataText !== "string") return null;
  const quoted = /"acct"<blob>="((?:[^"\\]|\\.)*)"/u.exec(metadataText);
  if (quoted) return quoted[1].replace(/\\(.)/gu, "$1");
  if (/"acct"<blob>=<NULL>/u.test(metadataText)) return "";
  return null;
}

export function saveClaudeOauth(oauth, source, original, keychainAccount = null) {
  const data = source === "keychain" || original.claudeAiOauth
    ? { ...original, claudeAiOauth: oauth }
    : { ...original, ...oauth };
  if (source === "keychain") {
    const account = keychainAccount ?? userInfo().username;
    const safeAccount = String(account).replace(/[\r\n]/gu, "").replace(/(["\\])/gu, "\\$1");
    const hexPayload = Buffer.from(JSON.stringify(data), "utf8").toString("hex");
    // Pass credentials over stdin in batch mode (-i) with hex (-X) so tokens never appear in process argv.
    childProcess.execFileSync(
      "security",
      ["-i"],
      {
        input: `add-generic-password -U -s "Claude Code-credentials" -a "${safeAccount}" -X ${hexPayload}\n`,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    return;
  }
  writePrivateJson(source, data);
}

async function claudeOauth(signal) {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN, subscriptionType: null };
  }
  const credentials = join(claudeHome(), ".credentials.json");
  if (existsSync(credentials)) {
    const data = readJson(credentials);
    let oauth = data.claudeAiOauth || data;
    if (oauth.accessToken) {
      if (claudeNeedsRefresh(oauth)) {
        oauth = await refreshClaude(oauth, signal);
        saveClaudeOauth(oauth, credentials, data);
      }
      return oauth;
    }
  }
  if (process.platform === "darwin") {
    try {
      let keychainAccount = null;
      try {
        const meta = childProcess.execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        keychainAccount = parseKeychainAccount(meta);
      } catch { /* Fall back to password read below for authoritative status. */ }
      const raw = childProcess.execFileSync(
        "security",
        keychainAccount != null
          ? ["find-generic-password", "-s", "Claude Code-credentials", "-a", keychainAccount, "-w"]
          : ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const data = parseJson(raw);
      let oauth = data.claudeAiOauth || {};
      if (!oauth.accessToken) throw new Error("未登录");
      if (claudeNeedsRefresh(oauth)) {
        oauth = await refreshClaude(oauth, signal);
        saveClaudeOauth(oauth, "keychain", data, keychainAccount);
      }
      return oauth;
    } catch (error) {
      if (error.message === "未登录" || error.message.startsWith("登录已过期")) throw error;
      if (error.status === 44) throw new Error("未登录");
      if (error.code) throw error;
      throw new Error("无法读取钥匙串里的 Claude 登录");
    }
  }
  throw new Error("未登录");
}

async function claudeQuota(signal) {
  const oauth = await claudeOauth(signal);
  const data = await httpJson("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
    signal,
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/2.1.322 (external, cli)",
      "x-app": "cli",
    },
  });
  return [oauth.subscriptionType || "claude.ai", claudeWindows(data), claudeResetCredits(data)];
}

export function claudeWindows(data) {
  const windows = [];
  for (const [label, key] of [
    ["5 小时", "five_hour"],
    ["7 天", "seven_day"],
    ["Sonnet 周", "seven_day_sonnet"],
    ["Opus 周", "seven_day_opus"],
  ]) {
    const window = data[key];
    if (!window) continue;
    windows.push(new Window(label, normalizePercent(window.utilization), window.resets_at));
  }
  // New model-specific limits (including Fable) live in the structured list.
  // is_active indicates the currently limiting window, not whether to show it.
  for (const limit of Array.isArray(data.limits) ? data.limits : []) {
    if (limit?.kind !== "weekly_scoped") continue;
    const model = limit.scope?.model?.display_name;
    if (typeof model !== "string" || !model.trim()) continue;
    const label = `${model.trim()} 周`;
    if (windows.some((window) => window.label === label)) continue;
    windows.push(new Window(label, normalizePercent(limit.percent), limit.resets_at));
  }
  if (data.extra_usage?.is_enabled) {
    windows.push(new Window("额外用量", normalizePercent(data.extra_usage.utilization), null));
  }
  return windows;
}

const claudeAdapter = {
  empty: () => ({}),
  clone: (state) => ({ ...(state || {}) }),
  consume(state, line, isTrailing, trailing) {
    if (!line.includes('"usage"')) return;
    let obj;
    try {
      obj = parseJson(line);
    } catch {
      return;
    }
    const usage = obj.message?.usage;
    if (!usage || typeof usage !== "object") return;
    const requestId = obj.requestId || obj.message?.id || obj.uuid;
    if (!requestId || !obj.timestamp) return;
    const model = obj.message?.model || obj.requestedModel || null;
    const normalized = claudeUsage(usage);
    if (isTrailing) {
      trailing.push([requestId, obj.timestamp, normalized, model]);
      return;
    }
    const previous = state[requestId];
    if (!previous || obj.timestamp >= previous[0]) {
      state[requestId] = [obj.timestamp, normalized, model || previous?.[2] || null];
    }
  },
  compact(state, cutoffMs) {
    const next = {};
    for (const [id, entry] of Object.entries(state)) {
      const moment = parseTime(entry[0]);
      if (moment && Number.isFinite(moment.getTime()) && moment.getTime() >= cutoffMs) {
        next[id] = entry;
      }
    }
    return next;
  },
  materialize: (state, trailing) => ({ entries: Object.entries(state), trailing }),
};

async function claudeTokens(buckets, signal, session) {
  const root = join(claudeHome(), "projects");
  const latest = new Map();
  const merge = (requestId, timestamp, usage, model) => {
    const previous = latest.get(requestId);
    if (!previous || timestamp >= previous[0]) {
      latest.set(requestId, [timestamp, usage, model || previous?.[2] || null]);
    }
  };
  for (const path of walkJsonl(root)) {
    if (!recent(path, buckets.monthStart)) continue;
    const scanned = await session.scanFile("Claude", path, claudeAdapter, signal);
    if (!scanned) continue;
    for (const [requestId, [timestamp, usage, model]] of scanned.entries) merge(requestId, timestamp, usage, model);
    for (const [requestId, timestamp, usage, model] of scanned.trailing) merge(requestId, timestamp, usage, model);
  }
  for (const [timestamp, usage, model] of latest.values()) buckets.add(parseTime(timestamp), usage.total, model, usage);
}

async function codexQuota(signal) {
  const authPath = join(codexHome(), "auth.json");
  if (!existsSync(authPath)) throw new Error("未登录");
  const auth = readJson(authPath);
  const access = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!access || !accountId) throw new Error("未登录");
  const data = await httpJson("https://chatgpt.com/backend-api/wham/usage", {
    signal,
    headers: {
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      "User-Agent": "aiusage",
    },
  });
  const rate = data.rate_limit || {};
  const windows = [];
  for (const [fallback, key] of [
    ["主窗口", "primary_window"],
    ["短窗口", "secondary_window"],
  ]) {
    const window = rate[key];
    if (!window) continue;
    const seconds = window.limit_window_seconds || 0;
    let label = fallback;
    if (seconds >= 6 * 24 * 3600) label = "每周";
    else if (seconds && seconds <= 6 * 3600) label = "5 小时";
    windows.push(new Window(label, normalizePercent(window.used_percent), window.reset_at, seconds || null));
  }
  const resetCredits = await optionalResetCredits(async () => {
    const details = await httpJson("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
      signal, headers: { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountId, Accept: "application/json", "User-Agent": "aiusage" },
    });
    return codexResetCredits(data.rate_limit_reset_credits, details);
  }, codexResetCredits(data.rate_limit_reset_credits));
  return [data.plan_type || auth.auth_mode || "chatgpt", windows, resetCredits];
}

const codexAdapter = {
  empty: () => ({ model: null, responses: {}, anon: [] }),
  clone: (state) => ({
    model: state?.model || null,
    responses: Object.fromEntries(Object.entries(state?.responses || {}).map(([k, v]) => [k, [...v]])),
    anon: [...(state?.anon || [])],
  }),
  consume(state, line, isTrailing, trailing) {
    if (!line.includes("token_usage_record") && !line.includes("turn_context") && !line.includes("session_meta")) return;
    let obj;
    try {
      obj = parseJson(line);
    } catch {
      return;
    }
    if (obj.type === "session_meta") {
      const next = obj.payload?.model || obj.payload?.base_instructions?.provenance?.model || state.model;
      if (isTrailing) trailing.push({ kind: "model", model: next });
      else state.model = next;
      return;
    }
    if (obj.type === "turn_context") {
      const next = obj.payload?.model || state.model;
      if (isTrailing) trailing.push({ kind: "model", model: next });
      else state.model = next;
      return;
    }
    if (obj.type !== "token_usage_record") return;
    const moment = parseTime(obj.timestamp);
    if (!moment || !Number.isFinite(moment.getTime())) return;
    const ms = moment.getTime();
    const usage = codexUsage(obj.payload?.usage || {});
    const responseId = obj.payload?.response_id;
    let inheritedModel = state.model;
    if (isTrailing) {
      for (let i = trailing.length - 1; i >= 0; i -= 1) {
        if (trailing[i].kind === "model") {
          inheritedModel = trailing[i].model;
          break;
        }
      }
      trailing.push({ kind: "record", responseId, ms, usage, model: obj.payload?.model || inheritedModel || null });
      return;
    }
    const actualModel = obj.payload?.model || inheritedModel || null;
    if (!responseId) {
      state.anon.push([ms, usage, actualModel]);
      return;
    }
    const previous = state.responses[responseId];
    if (previous && !previous[2] && actualModel) previous[2] = actualModel;
    if (!previous || ms >= previous[0]) state.responses[responseId] = [ms, usage, actualModel || previous?.[2] || null];
  },
  compact(state, cutoffMs) {
    const responses = {};
    for (const [id, entry] of Object.entries(state.responses)) {
      if (entry[0] >= cutoffMs) responses[id] = entry;
    }
    return {
      model: state.model,
      responses,
      anon: state.anon.filter((entry) => entry[0] >= cutoffMs),
    };
  },
  materialize: (state, trailing) => ({ state, trailing }),
};

async function codexTokens(buckets, signal, session) {
  const latestResponses = new Map();
  const minMs = buckets.monthStart.getTime();
  const mergeResponse = (responseId, ms, usage, model) => {
    if (ms < minMs) return;
    const previous = latestResponses.get(responseId);
    if (previous && !previous[2] && model) previous[2] = model;
    if (!previous || ms >= previous[0]) latestResponses.set(responseId, [ms, usage, model || previous?.[2] || null]);
  };
  for (const path of walkJsonl(join(codexHome(), "sessions"))) {
    if (!recent(path, buckets.monthStart)) continue;
    const scanned = await session.scanFile("Codex", path, codexAdapter, signal);
    if (!scanned) continue;
    for (const [ms, usage, model] of scanned.state.anon) {
      if (ms >= minMs) buckets.add(new Date(ms), usage.total, model, usage);
    }
    for (const [responseId, [ms, usage, model]] of Object.entries(scanned.state.responses)) {
      mergeResponse(responseId, ms, usage, model);
    }
    for (const item of scanned.trailing) {
      if (item.kind !== "record" || item.ms < minMs) continue;
      if (!item.responseId) buckets.add(new Date(item.ms), item.usage.total, item.model, item.usage);
      else mergeResponse(item.responseId, item.ms, item.usage, item.model);
    }
  }
  for (const [ms, usage, model] of latestResponses.values()) buckets.add(new Date(ms), usage.total, model, usage);
}

function grokEntry(auth) {
  const entries = Object.values(auth || {}).filter((value) => value && typeof value === "object" && value.key);
  if (!entries.length) throw new Error("未登录");
  return entries.sort((a, b) => String(a.expires_at || "").localeCompare(String(b.expires_at || ""))).at(-1);
}

function grokExpired(entry, now) {
  const moment = parseTime(entry.expires_at);
  if (!moment) return false;
  return moment.getTime() <= now.getTime() + 90_000;
}

export function validateGrokIssuer(rawIssuer) {
  const candidate = String(rawIssuer || "https://auth.x.ai").trim().replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Grok 认证地址不受信任，请运行 grok login");
  }
  const host = parsed.hostname.toLowerCase();
  const trustedHost = host === "auth.x.ai" || host === "x.ai" || host.endsWith(".x.ai");
  if (parsed.protocol !== "https:" || !trustedHost || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Grok 认证地址不受信任，请运行 grok login");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

function refreshGrok(auth, entry, path, signal) {
  return (async () => {
    const refresh = entry.refresh_token;
    const clientId = entry.oidc_client_id;
    const issuer = validateGrokIssuer(entry.oidc_issuer);
    if (!refresh || !clientId) throw new Error("登录已过期，请运行 grok login");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    const data = await httpJson(`${issuer}/oauth2/token`, {
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!data.access_token) throw new Error("登录已过期，请运行 grok login");
    entry.key = data.access_token;
    if (data.refresh_token) entry.refresh_token = data.refresh_token;
    if (data.expires_in) {
      entry.expires_at = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
    }
    writePrivateJson(path, auth);
  })();
}

async function grokAuth(signal) {
  const path = join(grokHome(), "auth.json");
  if (!existsSync(path)) throw new Error("未登录");
  const auth = readJson(path);
  const entry = grokEntry(auth);
  if (grokExpired(entry, new Date())) await refreshGrok(auth, entry, path, signal);
  return entry;
}

async function grokQuota(signal) {
  let entry = await grokAuth(signal);
  const headers = {
    Authorization: `Bearer ${entry.key}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "aiusage",
  };
  const billingUrl = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
  const settingsUrl = "https://cli-chat-proxy.grok.com/v1/settings";
  let billing;
  let settings;
  const fetchBoth = async () => {
    const results = await Promise.allSettled([
      httpJson(billingUrl, { headers, signal }), httpJson(settingsUrl, { headers, signal }),
    ]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw errors.find((error) => error.code === 429 || error.code === 403) || errors[0];
    return results.map((result) => result.value);
  };
  try {
    [billing, settings] = await fetchBoth();
  } catch (error) {
    if (error.code !== 401) throw error;
    const path = join(grokHome(), "auth.json");
    const auth = readJson(path);
    entry = grokEntry(auth);
    await refreshGrok(auth, entry, path, signal);
    headers.Authorization = `Bearer ${entry.key}`;
    [billing, settings] = await fetchBoth();
  }
  const config = billing.config || {};
  const period = config.currentPeriod || {};
  const label = String(period.type || "").includes("WEEKLY") ? "每周" : "本期";
  const windows = [new Window(label, normalizePercent(config.creditUsagePercent), period.end || config.billingPeriodEnd)];
  const cap = config.onDemandCap?.val;
  if (cap) windows.push(new Window(`额外 ${config.onDemandUsed?.val || 0}/${cap}`, null, null));
  const resetCredits = await optionalResetCredits(() => fetchGrokResetCredits(entry.key, signal));
  return [settings.subscription_tier_display || "Grok", windows, resetCredits];
}

const grokAdapter = {
  empty: () => ({ model: null, seen: [], named: [], pending: [] }),
  clone: (state) => ({
    model: state?.model || null,
    seen: [...(state?.seen || [])],
    named: [...(state?.named || [])],
    pending: [...(state?.pending || [])],
  }),
  consume(state, line, isTrailing, trailing) {
    const hasUsage = line.includes("prompt_tokens");
    const named = line.includes("current_model_id") || line.includes("model changed");
    if (!hasUsage && !named) return;
    let obj;
    try {
      obj = parseJson(line);
    } catch {
      return;
    }
    const ctx = obj.ctx || {};
    const next = ctx.current_model_id || (obj.msg === "model changed" ? ctx.model || ctx.new_model : null);
    if (isTrailing) {
      trailing.push({
        next,
        ts: obj.ts,
        hasPrompt: ctx.prompt_tokens != null,
        usage: ctx.prompt_tokens != null ? grokUsage(ctx) : null,
      });
      return;
    }
    if (next) {
      state.model = next;
      if (!state.seen.includes(next)) state.seen.push(next);
    }
    if (ctx.prompt_tokens == null) return;
    const moment = parseTime(obj.ts);
    if (!moment || !Number.isFinite(moment.getTime())) return;
    const ms = moment.getTime();
    const usage = grokUsage(ctx);
    if (state.model) state.named.push([ms, usage, state.model]);
    else state.pending.push([ms, usage]);
  },
  compact(state, cutoffMs) {
    return {
      model: state.model,
      seen: state.seen,
      named: state.named.filter((entry) => entry[0] >= cutoffMs),
      pending: state.pending.filter((entry) => entry[0] >= cutoffMs),
    };
  },
  materialize: (state, trailing) => ({ state, trailing }),
};

async function grokTokens(buckets, signal, session) {
  const path = join(grokHome(), "logs", "unified.jsonl");
  if (!existsSync(path)) return;
  const scanned = await session.scanFile("Grok", path, grokAdapter, signal);
  if (!scanned) return;
  let model = scanned.state.model;
  const seen = new Set(scanned.state.seen);
  const extraNamed = [];
  const extraPending = [];
  for (const item of scanned.trailing) {
    if (item.next) {
      model = item.next;
      seen.add(item.next);
    }
    if (!item.hasPrompt) continue;
    const moment = parseTime(item.ts);
    if (!moment || !Number.isFinite(moment.getTime())) continue;
    if (model) extraNamed.push([moment.getTime(), item.usage, model]);
    else extraPending.push([moment.getTime(), item.usage]);
  }
  for (const [ms, usage, entryModel] of [...scanned.state.named, ...extraNamed]) {
    buckets.add(new Date(ms), usage.total, entryModel, usage);
  }
  const only = seen.size === 1 ? [...seen][0] : null;
  for (const [ms, usage] of [...scanned.state.pending, ...extraPending]) {
    buckets.add(new Date(ms), usage.total, only, usage);
  }
}

function agyTranscriptPaths(root) {
  const brainDir = join(root, "brain");
  if (!existsSync(brainDir)) return [];
  let entries;
  try {
    entries = readdirSync(brainDir);
  } catch {
    return [];
  }
  const paths = [];
  for (const convId of entries) {
    const convDir = join(brainDir, convId);
    try {
      if (lstatSync(convDir).isSymbolicLink()) continue;
      const transcript = join(convDir, ".system_generated", "logs", "transcript.jsonl");
      const info = lstatSync(transcript);
      if (!info.isSymbolicLink() && info.isFile()) paths.push(transcript);
    } catch {
      // Conversation directory may not have a transcript yet.
    }
  }
  return paths;
}

const agyAdapter = {
  empty: () => ({}),
  clone: (state) => ({ ...(state || {}) }),
  consume(state, line, isTrailing, trailing) {
    if (!line.includes("PLANNER_RESPONSE")) return;
    let obj;
    try {
      obj = parseJson(line);
    } catch {
      return;
    }
    if (obj.type !== "PLANNER_RESPONSE" || !obj.created_at) return;
    const normalized = agyUsage(obj);
    if (normalized.total == null) return;
    const stepKey = String(obj.step_index ?? obj.created_at);
    const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : null;
    if (isTrailing) {
      trailing.push([stepKey, obj.created_at, normalized, model]);
      return;
    }
    const previous = state[stepKey];
    if (!previous || obj.created_at >= previous[0]) {
      state[stepKey] = [obj.created_at, normalized, model || previous?.[2] || null];
    }
  },
  compact(state, cutoffMs) {
    const next = {};
    for (const [key, entry] of Object.entries(state)) {
      const moment = parseTime(entry[0]);
      if (moment && Number.isFinite(moment.getTime()) && moment.getTime() >= cutoffMs) {
        next[key] = entry;
      }
    }
    return next;
  },
  materialize: (state, trailing) => ({ entries: Object.entries(state), trailing }),
};

async function agyTokens(buckets, signal, session) {
  for (const path of agyTranscriptPaths(agyHome())) {
    if (!recent(path, buckets.monthStart)) continue;
    const scanned = await session.scanFile("agy", path, agyAdapter, signal);
    if (!scanned) continue;
    const merged = new Map(scanned.entries);
    for (const [stepKey, timestamp, usage, model] of scanned.trailing) {
      const prev = merged.get(stepKey);
      if (!prev || timestamp >= prev[0]) merged.set(stepKey, [timestamp, usage, model || prev?.[2] || null]);
    }
    for (const [timestamp, usage, model] of merged.values()) {
      buckets.add(parseTime(timestamp), usage.total, model, usage);
    }
  }
}

const PROVIDERS = [
  ["Claude", claudeQuota, claudeTokens],
  ["Codex", codexQuota, codexTokens],
  ["Grok", grokQuota, grokTokens],
  ["agy", agyQuota, agyTokens],
];

async function runQuota(quota, signal) {
  try {
    const [plan, windows, resetCredits = null] = await quota(signal);
    return { plan, windows, resetCredits, error: null, skipped: false };
  } catch (error) {
    const skipped = error.message === "未登录";
    return { plan: null, windows: [], error: skipped ? null : error.message, skipped };
  }
}

async function runTokens(tokensOf, buckets, signal, session) {
  if (!tokensOf) return { tokens: null, tokenError: null, tokensSupported: false };
  try {
    await tokensOf(buckets, signal, session);
    return { tokens: buckets.totals(), tokenError: null };
  } catch (error) {
    return { tokens: null, tokenError: error.message };
  }
}

function reportFrom(name, quotaResult, tokenResult, account = null) {
  return new ProviderReport({
    name, ...quotaResult,
    account: quotaResult.skipped ? null : account,
    tokens: tokenResult.tokens,
    tokenError: tokenResult.tokenError,
    tokensSupported: tokenResult.tokensSupported,
    error: quotaResult.skipped ? null : tokenResult.tokenError || quotaResult.error,
  });
}

export function applyQuotaUpdate(reports, { name, result }) {
  return reports.map((report) => report.name === name
    ? reportFrom(name, result, { tokens: report.tokens, tokenError: report.tokenError, tokensSupported: report.tokensSupported }, report.account) : report);
}

export function formatProgress(names, state) {
  return names.map((name) => `${name} ${state.get(name)}`).join("  ");
}

export async function collectProviders(providers, now = new Date(), status = null, { quotaCache = null, scopes = {}, accounts = {}, signal } = {}) {
  const names = providers.map(([name]) => name);
  const state = new Map(names.map((name) => [name, "读取中"]));
  const session = new TokenScanSession(now, quotaCache?.directory);
  const paint = () => {
    if (status) status(formatProgress(names, state));
  };
  paint();
  const jobs = providers.map(([name, quota, tokensOf]) =>
    (async () => {
      await Promise.resolve();
      const buckets = new TokenBuckets(now, name);
      const quotaTask = quotaCache ? quotaCache.get(name, () => quota(signal), scopes[name] || "") : runQuota(quota, signal);
      await Promise.resolve();
      const tokenTask = runTokens(tokensOf, buckets, signal, session);
      try {
        return reportFrom(name, await quotaTask, await tokenTask, accounts[name] ?? null);
      } finally {
        state.set(name, "完成");
        paint();
      }
    })(),
  );
  try {
    return await Promise.all(jobs);
  } finally {
    session.flush(Boolean(signal?.aborted));
  }
}

export async function collect(now = new Date(), status = null, options = {}) {
  // Refresh old Claude snapshots once: they did not retain structured limits.
  const isOffline = Boolean(options.offline || options.quotaCache?.offline);
  const agySummary = readAgyAccountSummary({ reconcile: !isOffline });
  const activeAgy = agySummary.activeAccount
    ? { id: agySummary.activeAccount.id, alias: agySummary.activeAccount.alias, email: agySummary.activeAccount.email }
    : null;
  const scopes = {
    Claude: `${claudeHome()}\0structured-limits-v1`,
    Codex: codexHome(),
    Grok: grokHome(),
    agy: agyScopeForAccount(agySummary.activeId),
  };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) scopes.Claude += `\0${process.env.CLAUDE_CODE_OAUTH_TOKEN}`;
  return collectProviders(PROVIDERS, now, status, {
    quotaCache: options.quotaCache || new QuotaCache(options),
    scopes,
    accounts: activeAgy ? { agy: activeAgy } : {},
    signal: options.signal,
  });
}
