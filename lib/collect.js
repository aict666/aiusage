import { execFileSync } from "node:child_process";
import { createReadStream, chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { TokenBuckets, normalizePercent, parseTime } from "./time.js";

export class Window {
  constructor(label, usedPercent, resetsAt) {
    this.label = label;
    this.usedPercent = usedPercent == null ? null : Number(usedPercent);
    this.resetsAt = resetsAt ?? null;
  }
}

export class ProviderReport {
  constructor({ name, plan = null, windows = [], tokens = null, error = null, skipped = false }) {
    this.name = name;
    this.plan = plan;
    this.windows = windows;
    this.tokens = tokens;
    this.error = error;
    this.skipped = skipped;
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
    };
  }
}

function home(envName, fallback) {
  return process.env[envName] || join(homedir(), fallback);
}

function claudeHome() {
  return home("CLAUDE_CONFIG_DIR", ".claude");
}

function codexHome() {
  return home("CODEX_HOME", ".codex");
}

function grokHome() {
  return home("GROK_HOME", ".grok");
}

async function httpJson(url, { headers = {}, body = null } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: body == null ? "GET" : "POST",
      headers,
      body,
    });
  } catch (error) {
    throw new Error(`网络失败：${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    const detail = text.slice(0, 160).replace(/\n/g, " ");
    const error = new Error(response.status === 401 ? "登录已过期" : `HTTP ${response.status} ${detail}`);
    error.code = response.status;
    throw error;
  }
  return JSON.parse(text);
}

export function claudeUsageTotal(usage) {
  let cacheCreate = usage.cache_creation_input_tokens || 0;
  if (!cacheCreate && usage.cache_creation && typeof usage.cache_creation === "object") {
    cacheCreate = Object.values(usage.cache_creation).reduce((sum, value) => {
      return sum + (typeof value === "number" ? value : 0);
    }, 0);
  }
  return (usage.input_tokens || 0) + cacheCreate + (usage.cache_read_input_tokens || 0) + (usage.output_tokens || 0);
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

async function eachLine(path, visit) {
  const lines = readline.createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) visit(line);
}

function claudeOauth() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN, subscriptionType: null };
  }
  const credentials = join(claudeHome(), ".credentials.json");
  if (existsSync(credentials)) {
    const data = JSON.parse(readFileSync(credentials, "utf8"));
    const oauth = data.claudeAiOauth || data;
    if (oauth.accessToken) return oauth;
  }
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const oauth = JSON.parse(raw).claudeAiOauth || {};
      if (!oauth.accessToken) throw new Error("未登录");
      return oauth;
    } catch (error) {
      if (error.message === "未登录") throw error;
      if (error.status === 44) throw new Error("未登录");
      throw new Error("无法读取钥匙串里的 Claude 登录");
    }
  }
  throw new Error("未登录");
}

async function claudeQuota() {
  const oauth = claudeOauth();
  const data = await httpJson("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "ai-quota",
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

async function claudeTokens(buckets) {
  const root = join(claudeHome(), "projects");
  const latest = new Map();
  for (const path of walkJsonl(root)) {
    if (!recent(path, buckets.monthStart)) continue;
    await eachLine(path, (line) => {
      if (!line.includes('"usage"')) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      const usage = obj.message?.usage;
      if (!usage || typeof usage !== "object") return;
      const requestId = obj.requestId || obj.uuid;
      if (!requestId || !obj.timestamp) return;
      const previous = latest.get(requestId);
      if (!previous || obj.timestamp >= previous[0]) latest.set(requestId, [obj.timestamp, claudeUsageTotal(usage)]);
    });
  }
  for (const [timestamp, total] of latest.values()) buckets.add(parseTime(timestamp), total);
}

async function codexQuota() {
  const authPath = join(codexHome(), "auth.json");
  if (!existsSync(authPath)) throw new Error("未登录");
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  const access = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!access || !accountId) throw new Error("未登录");
  const data = await httpJson("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      "User-Agent": "ai-quota",
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

async function codexTokens(buckets) {
  for (const path of walkJsonl(join(codexHome(), "sessions"))) {
    if (!recent(path, buckets.monthStart)) continue;
    await eachLine(path, (line) => {
      if (!line.includes("token_usage_record")) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (obj.type !== "token_usage_record") return;
      buckets.add(parseTime(obj.timestamp), obj.payload?.usage?.total_tokens || 0);
    });
  }
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

function refreshGrok(auth, entry, path) {
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
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!data.access_token) throw new Error("登录已过期，请运行 grok login");
    entry.key = data.access_token;
    if (data.refresh_token) entry.refresh_token = data.refresh_token;
    if (data.expires_in) {
      entry.expires_at = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
    }
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`);
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  })();
}

async function grokAuth() {
  const path = join(grokHome(), "auth.json");
  if (!existsSync(path)) throw new Error("未登录");
  const auth = JSON.parse(readFileSync(path, "utf8"));
  const entry = grokEntry(auth);
  if (grokExpired(entry, new Date())) await refreshGrok(auth, entry, path);
  return entry;
}

async function grokQuota() {
  let entry = await grokAuth();
  const headers = {
    Authorization: `Bearer ${entry.key}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "ai-quota",
  };
  let billing;
  let settings;
  try {
    billing = await httpJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers });
    settings = await httpJson("https://cli-chat-proxy.grok.com/v1/settings", { headers });
  } catch (error) {
    if (error.code !== 401) throw error;
    const path = join(grokHome(), "auth.json");
    const auth = JSON.parse(readFileSync(path, "utf8"));
    entry = grokEntry(auth);
    await refreshGrok(auth, entry, path);
    headers.Authorization = `Bearer ${entry.key}`;
    billing = await httpJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers });
    settings = await httpJson("https://cli-chat-proxy.grok.com/v1/settings", { headers });
  }
  const config = billing.config || {};
  const period = config.currentPeriod || {};
  const label = String(period.type || "").includes("WEEKLY") ? "每周" : "本期";
  const windows = [new Window(label, normalizePercent(config.creditUsagePercent), period.end || config.billingPeriodEnd)];
  const cap = config.onDemandCap?.val;
  if (cap) windows.push(new Window(`额外 ${config.onDemandUsed?.val || 0}/${cap}`, null, null));
  return [settings.subscription_tier_display || "Grok", windows];
}

async function grokTokens(buckets) {
  const path = join(grokHome(), "logs", "unified.jsonl");
  if (!existsSync(path)) return;
  await eachLine(path, (line) => {
    if (!line.includes("prompt_tokens")) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const ctx = obj.ctx || {};
    if (ctx.prompt_tokens == null) return;
    buckets.add(parseTime(obj.ts), (ctx.prompt_tokens || 0) + (ctx.completion_tokens || 0));
  });
}

const PROVIDERS = [
  ["Claude", claudeQuota, claudeTokens],
  ["Codex", codexQuota, codexTokens],
  ["Grok", grokQuota, grokTokens],
];

export async function collect(now = new Date(), status = null) {
  const reports = [];
  for (const [name, quota, tokensOf] of PROVIDERS) {
    if (status) status(`正在读取 ${name}…`);
    const buckets = new TokenBuckets(now);
    let tokens = { today: 0, days7: 0, days30: 0 };
    let tokenError = null;
    try {
      await tokensOf(buckets);
      tokens = buckets.totals();
    } catch (error) {
      tokenError = error.message;
      tokens = null;
    }
    try {
      const [plan, windows] = await quota();
      reports.push(new ProviderReport({ name, plan, windows, tokens, error: tokenError }));
    } catch (error) {
      const skipped = error.message === "未登录";
      reports.push(
        new ProviderReport({
          name,
          tokens,
          error: skipped ? null : tokenError || error.message,
          skipped,
        }),
      );
    }
  }
  return reports;
}
