import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { TokenBuckets, normalizePercent, parseTime } from "./time.js";
import { configHome, parseJson, readJson, writePrivateJson } from "./files.js";
import { claudeUsage, codexUsage, grokUsage } from "./usage.js";
import { httpJson } from "./http.js";
import { QuotaCache } from "./quota-cache.js";

export class Window {
  constructor(label, usedPercent, resetsAt) {
    this.label = label;
    this.usedPercent = usedPercent == null ? null : Number(usedPercent);
    this.resetsAt = resetsAt ?? null;
  }
}

export class ProviderReport {
  constructor({ name, plan = null, windows = [], tokens = null, error = null, skipped = false, quota = null, tokenError = null }) {
    this.name = name;
    this.plan = plan;
    this.windows = windows;
    this.tokens = tokens;
    this.error = error;
    this.skipped = skipped;
    this.quota = quota;
    this.tokenError = tokenError;
  }

  toJSON() {
    return {
      name: this.name,
      plan: this.plan,
      windows: this.windows.map((window) => ({
        label: window.label,
        used_percent: window.usedPercent,
        resets_at: window.resetsAt,
      })),
      tokens: this.tokens,
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

export function claudeUsageTotal(usage) {
  return claudeUsage(usage).total;
}

function recent(path, oldest) {
  return statSync(path).mtime >= new Date(oldest.getTime() - 86400000);
}

function walkJsonl(root) {
  const files = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files;
}

async function eachLine(path, visit, signal) {
  if (signal?.aborted) return;
  const size = statSync(path).size;
  if (!size) return;
  // Each scan is a finite snapshot, even if an active CLI keeps appending logs.
  const stream = createReadStream(path, { end: size - 1 });
  const closed = new Promise((resolve) => stream.once("close", resolve));
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const abort = () => {
    lines.close();
    stream.destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const line of lines) {
      if (signal?.aborted) break;
      visit(line);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    lines.close();
    stream.destroy();
    // An error/finished event can precede close; Windows needs the actual close.
    await closed;
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

function saveClaudeOauth(oauth, source, original) {
  const data = source === "keychain" || original.claudeAiOauth
    ? { ...original, claudeAiOauth: oauth }
    : { ...original, ...oauth };
  if (source === "keychain") {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", userInfo().username, "-w", JSON.stringify(data)],
      { stdio: "ignore" },
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
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const data = parseJson(raw);
      let oauth = data.claudeAiOauth || {};
      if (!oauth.accessToken) throw new Error("未登录");
      if (claudeNeedsRefresh(oauth)) {
        oauth = await refreshClaude(oauth, signal);
        saveClaudeOauth(oauth, "keychain", data);
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
  const data = await httpJson("https://api.anthropic.com/api/oauth/usage", {
    signal,
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "aiusage",
    },
  });
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
  if (data.extra_usage?.is_enabled) {
    windows.push(new Window("额外用量", normalizePercent(data.extra_usage.utilization), null));
  }
  return [oauth.subscriptionType || "claude.ai", windows];
}

async function claudeTokens(buckets, signal) {
  const root = join(claudeHome(), "projects");
  const latest = new Map();
  for (const path of walkJsonl(root)) {
    if (!recent(path, buckets.monthStart)) continue;
    await eachLine(path, (line) => {
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
      const previous = latest.get(requestId);
      const model = obj.message?.model || obj.requestedModel || null;
      if (!previous || obj.timestamp >= previous[0]) latest.set(requestId, [obj.timestamp, claudeUsage(usage), model || previous?.[2]]);
    }, signal);
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
    windows.push(new Window(label, normalizePercent(window.used_percent), window.reset_at));
  }
  return [data.plan_type || auth.auth_mode || "chatgpt", windows];
}

async function codexTokens(buckets, signal) {
  const latestResponses = new Map();
  for (const path of walkJsonl(join(codexHome(), "sessions"))) {
    if (!recent(path, buckets.monthStart)) continue;
    let model = null;
    await eachLine(path, (line) => {
      if (!line.includes("token_usage_record") && !line.includes("turn_context") && !line.includes("session_meta")) return;
      let obj;
      try {
        obj = parseJson(line);
      } catch {
        return;
      }
      if (obj.type === "session_meta") {
        model = obj.payload?.model || obj.payload?.base_instructions?.provenance?.model || model;
        return;
      }
      if (obj.type === "turn_context") {
        model = obj.payload?.model || model;
        return;
      }
      if (obj.type !== "token_usage_record") return;
      const responseId = obj.payload?.response_id;
      const usage = codexUsage(obj.payload?.usage || {});
      const moment = parseTime(obj.timestamp);
      if (!moment || !Number.isFinite(moment.getTime()) || moment < buckets.monthStart) return;
      const actualModel = obj.payload?.model || model;
      if (!responseId) {
        buckets.add(moment, usage.total, actualModel, usage);
        return;
      }
      const previous = latestResponses.get(responseId);
      if (previous && !previous[2] && actualModel) previous[2] = actualModel;
      if (!previous || moment >= previous[0]) latestResponses.set(responseId, [moment, usage, actualModel || previous?.[2]]);
    }, signal);
  }
  for (const [moment, usage, model] of latestResponses.values()) buckets.add(moment, usage.total, model, usage);
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

function refreshGrok(auth, entry, path, signal) {
  return (async () => {
    const refresh = entry.refresh_token;
    const clientId = entry.oidc_client_id;
    const issuer = String(entry.oidc_issuer || "https://auth.x.ai").replace(/\/$/, "");
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
  return [settings.subscription_tier_display || "Grok", windows];
}

async function grokTokens(buckets, signal) {
  const path = join(grokHome(), "logs", "unified.jsonl");
  if (!existsSync(path)) return;
  let model = null;
  const seen = new Set();
  const pending = [];
  await eachLine(path, (line) => {
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
    if (next) {
      model = next;
      seen.add(next);
    }
    if (ctx.prompt_tokens == null) return;
    const usage = grokUsage(ctx);
    const moment = parseTime(obj.ts);
    if (model) buckets.add(moment, usage.total, model, usage);
    else pending.push([moment, usage]);
  }, signal);
  const only = seen.size === 1 ? [...seen][0] : null;
  for (const [moment, usage] of pending) buckets.add(moment, usage.total, only, usage);
}

const PROVIDERS = [
  ["Claude", claudeQuota, claudeTokens],
  ["Codex", codexQuota, codexTokens],
  ["Grok", grokQuota, grokTokens],
];

async function runQuota(quota, signal) {
  try {
    const [plan, windows] = await quota(signal);
    return { plan, windows, error: null, skipped: false };
  } catch (error) {
    const skipped = error.message === "未登录";
    return { plan: null, windows: [], error: skipped ? null : error.message, skipped };
  }
}

async function runTokens(tokensOf, buckets, signal) {
  try {
    await tokensOf(buckets, signal);
    return { tokens: buckets.totals(), tokenError: null };
  } catch (error) {
    return { tokens: null, tokenError: error.message };
  }
}

function reportFrom(name, quotaResult, tokenResult) {
  return new ProviderReport({
    name, ...quotaResult,
    tokens: tokenResult.tokens,
    tokenError: tokenResult.tokenError,
    error: quotaResult.skipped ? null : tokenResult.tokenError || quotaResult.error,
  });
}

export function applyQuotaUpdate(reports, { name, result }) {
  return reports.map((report) => report.name === name
    ? reportFrom(name, result, { tokens: report.tokens, tokenError: report.tokenError }) : report);
}

export function formatProgress(names, state) {
  return names.map((name) => `${name} ${state.get(name)}`).join("  ");
}

export async function collectProviders(providers, now = new Date(), status = null, { quotaCache = null, scopes = {}, signal } = {}) {
  const names = providers.map(([name]) => name);
  const state = new Map(names.map((name) => [name, "读取中"]));
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
      const tokenTask = runTokens(tokensOf, buckets, signal);
      try {
        return reportFrom(name, await quotaTask, await tokenTask);
      } finally {
        state.set(name, "完成");
        paint();
      }
    })(),
  );
  return Promise.all(jobs);
}

export async function collect(now = new Date(), status = null, options = {}) {
  const scopes = { Claude: claudeHome(), Codex: codexHome(), Grok: grokHome() };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) scopes.Claude += `\0${process.env.CLAUDE_CODE_OAUTH_TOKEN}`;
  return collectProviders(PROVIDERS, now, status, { quotaCache: options.quotaCache || new QuotaCache(options), scopes, signal: options.signal });
}
