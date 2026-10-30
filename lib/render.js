import { BAR_WIDTH, parseTime } from "./time.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

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

export function usageText(percent) {
  if (percent == null) return `[${"-".repeat(BAR_WIDTH)}]    -`;
  const clamped = Math.max(0, Math.min(100, Number(percent)));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const bar = "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled);
  return `[${bar}] ${String(Math.round(clamped)).padStart(3, " ")}%`;
}

function two(number) {
  return String(number).padStart(2, "0");
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatWhen(value, now) {
  const moment = parseTime(value);
  if (!moment) return "-";
  const clock = `${two(moment.getHours())}:${two(moment.getMinutes())}`;
  const days = Math.round((startOfDay(moment) - startOfDay(now)) / 86400000);
  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `明天 ${clock}`;
  return `${two(moment.getMonth() + 1)}-${two(moment.getDate())} ${clock}`;
}

export function formatTokens(value) {
  if (value == null) return "-";
  return Math.trunc(value).toLocaleString("en-US");
}

function paint(text, code, enabled) {
  if (!enabled || !code) return text;
  return `${code}${text}${RESET}`;
}

function table(headers, rows, aligns, color) {
  const widths = headers.map((header) => displayWidth(header));
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], displayWidth(cell.text));
    });
  }
  const line = (cells, rule = false) =>
    cells
      .map((cell, index) => {
        const text = rule ? "-".repeat(widths[index]) : pad(cell.text, widths[index], aligns[index]);
        return paint(text, rule ? null : cell.color, color && !rule);
      })
      .join("  ");
  return [
    line(headers.map((header) => ({ text: header }))),
    line(headers.map(() => ({ text: "" })), true),
    ...rows.map((row) => line(row)),
  ];
}

export function render(reports, { color = false, now = new Date() } = {}) {
  const quotaRows = [];
  const tokenRows = [];
  for (const report of reports) {
    if (report.skipped) {
      quotaRows.push([
        { text: report.name },
        { text: "-" },
        { text: "未登录" },
        { text: usageText(null), color: DIM },
        { text: "-" },
        { text: "先登录对应的 CLI" },
      ]);
    } else if (report.error && report.windows.length === 0) {
      quotaRows.push([
        { text: report.name },
        { text: report.plan || "-" },
        { text: "失败" },
        { text: usageText(null), color: DIM },
        { text: "-" },
        { text: report.error },
      ]);
    } else {
      for (const window of report.windows) {
        const left = window.usedPercent == null ? "-" : `${Math.max(0, Math.round(100 - window.usedPercent))}%`;
        quotaRows.push([
          { text: report.name },
          { text: report.plan || "-" },
          { text: window.label },
          { text: usageText(window.usedPercent), color: tone(window.usedPercent) },
          { text: left },
          { text: formatWhen(window.resetsAt, now) },
        ]);
      }
    }
    const tokens = report.tokens;
    tokenRows.push([
      { text: report.name },
      { text: formatTokens(tokens ? tokens.today : null) },
      { text: formatTokens(tokens ? tokens.days7 : null) },
      { text: formatTokens(tokens ? tokens.days30 : null) },
    ]);
    if (report.error && report.windows.length) {
      tokenRows.push([{ text: "" }, { text: report.error, color: YELLOW }, { text: "" }, { text: "" }]);
    }
  }
  const stamp = `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  return [
    paint("额度", BOLD, color),
    "",
    ...table(["服务", "套餐", "窗口", "用量", "剩余", "重置"], quotaRows, ["left", "left", "left", "left", "right", "left"], color),
    "",
    paint("Token", BOLD, color),
    "",
    ...table(["服务", "今天", "近 7 天", "近 30 天"], tokenRows, ["left", "right", "right", "right"], color),
    "",
    paint(`统计时间 ${stamp}`, DIM, color),
    paint("Claude 计入输入、缓存写入、缓存读取和输出，同一请求只取最后一条。", DIM, color),
    paint("Codex 和 Grok 计入每次调用的输入与输出，缓存已经包含在输入里。近 7 天和近 30 天都包含今天。", DIM, color),
    "",
  ].join("\n");
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
