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

function compactNumber(number) {
  const digits = number >= 100 ? 1 : 2;
  return number.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatTokenParts(value) {
  if (value == null) return { num: "-", unit: "" };
  const abs = Math.abs(Math.trunc(value));
  const sign = value < 0 ? "-" : "";
  if (abs < 10_000) return { num: sign + abs.toLocaleString("en-US"), unit: "" };
  if (abs < 100_000_000) return { num: sign + compactNumber(abs / 10_000), unit: "万" };
  return { num: sign + compactNumber(abs / 100_000_000), unit: "亿" };
}

export function formatTokens(value) {
  const { num, unit } = formatTokenParts(value);
  return unit ? `${num}${unit}` : num;
}

export function shortModel(model) {
  if (!model || model === "未知") return "未知";
  const claude = /^claude-(opus|sonnet|haiku)(?:-(\d+))?(?:-(\d+))?(?:-\d{8})?$/i.exec(model);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1);
    const version = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2] || "";
    return version ? `${family} ${version}` : family;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(model);
  if (gpt) {
    const suffix = gpt[2] ? ` ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}` : "";
    return `GPT-${gpt[1]}${suffix}`;
  }
  const grok = /^grok-(.+)$/i.exec(model);
  if (grok) return `Grok ${grok[1]}`;
  return model;
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

function tokenRows(report) {
  const models = report.tokens?.models || [];
  if (models.length) return models;
  if (!report.tokens) return [{ model: "—", today: null, days7: null, days30: null }];
  return [{ model: "合计", today: report.tokens.today, days7: report.tokens.days7, days30: report.tokens.days30 }];
}

function tokenCell(value) {
  const { num, unit } = formatTokenParts(value);
  return `${pad(num, 6, "right")}${unit || "  "}`;
}

function tokenLine(service, model, row, serviceWidth, modelWidth) {
  return `  ${pad(service, serviceWidth)}  ${pad(shortModel(model), modelWidth)}  今天 ${tokenCell(row.today)}   近 7 天 ${tokenCell(row.days7)}   近 30 天 ${tokenCell(row.days30)}`;
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
  const grouped = reports.map((report) => ({ report, rows: tokenRows(report) }));
  const serviceWidth = Math.max(6, ...grouped.map(({ report }) => displayWidth(report.name)));
  const modelWidth = Math.max(
    6,
    ...grouped.flatMap(({ rows }) => rows.map((row) => displayWidth(shortModel(row.model)))),
  );
  for (const { report, rows } of grouped) {
    rows.forEach((row, index) => {
      lines.push(tokenLine(index === 0 ? report.name : "", row.model, row, serviceWidth, modelWidth));
    });
  }
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
        models: "models split the same totals; json counts stay raw, the terminal shows 万 and 亿",
      },
    },
    null,
    2,
  )}\n`;
}
