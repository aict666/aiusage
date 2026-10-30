import { parseTime } from "./time.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BAR_WIDTH = 16;

export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += char.codePointAt(0) > 127 ? 2 : 1;
  return width;
}

export function pad(text, width, align = "left") {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  const spaces = " ".repeat(gap);
  return align === "right" ? spaces + text : text + spaces;
}

function tone(percent) {
  if (percent == null) return null;
  if (percent >= 80) return RED;
  if (percent >= 50) return YELLOW;
  return GREEN;
}

function paint(text, code, enabled) {
  if (!enabled || !code) return text;
  return `${code}${text}${RESET}`;
}

function two(number) {
  return String(number).padStart(2, "0");
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function barText(percent, width = BAR_WIDTH) {
  if (percent == null) return `[${"-".repeat(width)}]`;
  const clamped = Math.max(0, Math.min(100, Number(percent)));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function formatWhen(value, now) {
  const moment = parseTime(value);
  if (!moment) return null;
  const clock = `${two(moment.getHours())}:${two(moment.getMinutes())}`;
  const days = Math.round((startOfDay(moment) - startOfDay(now)) / 86400000);
  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `明天 ${clock}`;
  return `${two(moment.getMonth() + 1)}-${two(moment.getDate())} ${clock}`;
}

export function formatReset(value, now) {
  const when = formatWhen(value, now);
  if (!when) return "重置时间未知";
  const moment = parseTime(value);
  const delta = moment.getTime() - now.getTime();
  if (delta <= 0) return `${when}，已到点`;
  const minutes = Math.max(1, Math.round(delta / 60000));
  if (minutes < 60) return `${when}，${minutes} 分钟后`;
  const hours = Math.round(delta / 3600000);
  if (hours < 48) return `${when}，${hours} 小时后`;
  return `${when}，${Math.round(delta / 86400000)} 天后`;
}

export function formatTokens(value) {
  if (value == null) return "-";
  return Math.trunc(value).toLocaleString("en-US");
}

function percentText(value) {
  if (value == null) return "  -";
  return `${String(Math.max(0, Math.round(value))).padStart(3, " ")}%`;
}

function quotaLine(window, now, color) {
  const used = window.usedPercent;
  const left = used == null ? null : Math.max(0, 100 - used);
  const label = pad(window.label, 10);
  const bar = paint(barText(used), tone(used), color);
  const usedText = paint(percentText(used), tone(used), color);
  return `  ${label}  ${bar}  ${usedText}   剩余 ${percentText(left)}   重置 ${formatReset(window.resetsAt, now)}`;
}

function tokenLine(name, tokens) {
  const cell = (value) => formatTokens(value).padStart(14, " ");
  const today = tokens ? tokens.today : null;
  const days7 = tokens ? tokens.days7 : null;
  const days30 = tokens ? tokens.days30 : null;
  return `  ${name.padEnd(8)}今天${cell(today)}    近 7 天${cell(days7)}    近 30 天${cell(days30)}`;
}

function quotaBlock(report, now, color) {
  const title = paint(`${report.name}  ${report.plan || "-"}`, BOLD, color);
  if (report.skipped) return [title, "  未登录，先登录对应的 CLI"];
  if (report.error && report.windows.length === 0) return [title, `  ${report.error}`];
  const lines = [title];
  if (report.windows.length === 0) lines.push("  暂无额度窗口");
  for (const window of report.windows) lines.push(quotaLine(window, now, color));
  if (report.error) lines.push(paint(`  ${report.error}`, YELLOW, color));
  return lines;
}

export function render(reports, { color = false, now = new Date() } = {}) {
  const lines = [paint("额度", BOLD, color), ""];
  reports.forEach((report, index) => {
    if (index) lines.push("");
    lines.push(...quotaBlock(report, now, color));
  });
  lines.push("", paint("Token", BOLD, color), "");
  for (const report of reports) lines.push(tokenLine(report.name, report.tokens));
  const stamp = `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  lines.push("", paint(stamp, DIM, color), "");
  return lines.join("\n");
}

export function dumps(reports, now = new Date()) {
  return `${JSON.stringify(
    {
      generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      providers: reports.map((report) => report.toJSON()),
      token_notes: {
        claude: "input + cache_creation + cache_read + output, last snapshot per request",
        codex: "per-call total_tokens; cached input is already inside that total",
        grok: "prompt_tokens + completion_tokens; cached prompt is already inside prompt_tokens",
        windows: "days_7 and days_30 include today",
      },
    },
    null,
    2,
  )}\n`;
}
