import { stripVTControlCharacters } from "node:util";
import { parseTime } from "./time.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BAR_WIDTH = 12;
const GAP = "  ";
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text) {
  return [...segments.segment(String(text))].map(({ segment }) => segment);
}

function isWide(code) {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1b000 && code <= 0x1b2ff) || (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function displayWidth(text) {
  let width = 0;
  for (const segment of graphemes(stripVTControlCharacters(String(text)))) {
    const visible = segment.replace(/[\p{Mark}\p{Cf}\p{Cc}]/gu, "");
    if (!visible) continue;
    const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}/u.test(segment) ||
      (segment.includes("\ufe0f") && /[\p{Extended_Pictographic}#*0-9]/u.test(segment));
    width += emoji || isWide(visible.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

export function pad(text, width, align = "left") {
  text = String(text);
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  const spaces = " ".repeat(gap);
  return align === "right" ? spaces + text : text + spaces;
}

function clean(text) {
  return stripVTControlCharacters(String(text ?? "")).replace(/\s+/gu, " ").trim();
}

export function truncate(text, width) {
  text = clean(text);
  if (displayWidth(text) <= width) return text;
  if (width < 1) return "";
  let result = "";
  let size = 0;
  for (const segment of graphemes(text)) {
    const next = displayWidth(segment);
    if (size + next > width - 1) break;
    result += segment;
    size += next;
  }
  return `${result}…`;
}

function wrap(text, width) {
  width = Math.max(1, width);
  const lines = [];
  let line = "";
  let size = 0;
  for (const word of clean(text).split(/( )/u)) {
    if (size + displayWidth(word) > width && line.trim()) {
      lines.push(line.trimEnd());
      line = "";
      size = 0;
    }
    for (const segment of graphemes(word)) {
      const next = displayWidth(segment);
      if (size + next > width && line) {
        lines.push(line.trimEnd());
        line = "";
        size = 0;
      }
      if (!line && segment === " ") continue;
      line += segment;
      size += next;
    }
  }
  if (line) lines.push(line.trimEnd());
  return lines;
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
  const clamped = Math.max(0, Math.min(100, finitePercent(percent) ?? 0));
  const filled = Math.round((clamped / 100) * width);
  return `${"━".repeat(filled)}${"─".repeat(width - filled)}`;
}

export function formatWhen(value, now) {
  const moment = parseTime(value);
  if (!moment || !Number.isFinite(moment.getTime())) return null;
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
  const digits = number >= 100 ? 0 : number >= 10 ? 1 : 2;
  return number.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatTokenParts(value) {
  if (value == null || !Number.isFinite(Number(value))) return { num: "—", unit: "" };
  const abs = Math.abs(Math.trunc(value));
  const sign = value < 0 ? "-" : "";
  const units = ["", "K", "M", "B"];
  let amount = abs;
  let unit = 0;
  while (unit < units.length - 1 && Number(compactNumber(amount)) >= 1_000) {
    amount /= 1_000;
    unit += 1;
  }
  return { num: sign + compactNumber(amount), unit: units[unit] };
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

function finitePercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
}

function percentText(value) {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function remaining(window) {
  const used = finitePercent(window.usedPercent);
  return used == null ? null : Math.max(0, 100 - used);
}

function usageCell(window, width, percentWidth, color) {
  const used = finitePercent(window.usedPercent);
  const bar = barText(used, width);
  const filled = bar.lastIndexOf("━") + 1;
  return paint(bar.slice(0, filled), tone(used), color) + paint(bar.slice(filled), DIM, color) +
    " " + paint(pad(percentText(used), percentWidth, "right"), tone(used), color);
}

function resetText(window, now) {
  return formatReset(window.resetsAt, now).replace("，", " · ");
}

function providerTitle(report, color, plan = true) {
  return paint(clean(report.name), BOLD, color) +
    (plan && report.plan ? paint(` · ${clean(report.plan)}`, DIM, color) : "");
}

function row(cells, widths, right = []) {
  return cells.map((cell, index) => pad(cell, widths[index], right.includes(index) ? "right" : "left")).join(GAP).trimEnd();
}

function rule(width, color) {
  return paint("─".repeat(width), DIM, color);
}

function message(report) {
  if (report.skipped) return "未登录 · 请先登录对应的 CLI";
  if (report.error) return `读取失败 · ${clean(report.error)}`;
  return "暂无额度窗口";
}

function quotaTable(reports, now, color, width) {
  const windows = reports.flatMap((report) => report.windows);
  const headers = ["服务 / 套餐", "窗口", "已用", "剩余", "重置"];
  const percentWidth = Math.max(4, ...windows.map((window) => displayWidth(percentText(finitePercent(window.usedPercent)))));
  const widths = [
    Math.max(displayWidth(headers[0]), ...reports.map((report) => displayWidth(providerTitle(report, false)))),
    Math.max(4, ...windows.map((window) => displayWidth(clean(window.label)))),
    BAR_WIDTH + 1 + percentWidth,
    4,
    Math.max(4, ...windows.map((window) => displayWidth(resetText(window, now)))),
  ];
  const total = () => widths.reduce((sum, cell) => sum + cell, GAP.length * 4);
  const barWidth = BAR_WIDTH - Math.max(0, total() - width);
  if (barWidth < 6) return quotaCompact(reports, now, color, width);
  widths[2] = barWidth + 1 + percentWidth;
  const lines = [paint(row(headers, widths, [3]), DIM, color), rule(width, color)];
  for (const report of reports) {
    if (report.skipped || report.windows.length === 0) {
      const available = width - widths[0] - GAP.length;
      const details = wrap(message(report), available);
      details.forEach((detail, index) => lines.push(
        pad(index ? "" : providerTitle(report, color), widths[0]) + GAP + paint(detail, report.error ? YELLOW : DIM, color),
      ));
      continue;
    }
    report.windows.forEach((window, index) => lines.push(row([
      index ? "" : providerTitle(report, color),
      clean(window.label),
      usageCell(window, barWidth, percentWidth, color),
      percentText(remaining(window)),
      paint(resetText(window, now), DIM, color),
    ], widths, [3])));
    if (report.error) {
      const indent = " ".repeat(widths[0] + GAP.length);
      for (const detail of wrap(`提示 · ${clean(report.error)}`, width - indent.length)) {
        lines.push(indent + paint(detail, YELLOW, color));
      }
    }
  }
  return lines;
}

function quotaCompact(reports, now, color, width) {
  const lines = [rule(width, color)];
  reports.forEach((report, index) => {
    if (index) lines.push("");
    for (const title of wrap(providerTitle(report, false), width)) lines.push(paint(title, BOLD, color));
    if (report.skipped || report.windows.length === 0) {
      for (const detail of wrap(message(report), width - 2)) lines.push(GAP + paint(detail, report.error ? YELLOW : DIM, color));
      return;
    }
    for (const window of report.windows) {
      const used = finitePercent(window.usedPercent);
      const label = clean(window.label);
      const percentWidth = Math.max(4, displayWidth(percentText(used)));
      const barWidth = Math.min(BAR_WIDTH, width - 2 - displayWidth(label) - 2 - 1 - percentWidth);
      if (barWidth >= 4) lines.push(`${GAP}${label}${GAP}${usageCell(window, barWidth, percentWidth, color)}`);
      else for (const detail of wrap(`${label} · 已用 ${percentText(used)}`, width - 2)) lines.push(GAP + detail);
      for (const detail of wrap(`剩余 ${percentText(remaining(window))} · ${resetText(window, now)}`, width - 2)) {
        lines.push(GAP + paint(detail, DIM, color));
      }
    }
    if (report.error) for (const detail of wrap(`提示 · ${clean(report.error)}`, width - 2)) lines.push(GAP + paint(detail, YELLOW, color));
  });
  return lines;
}

function tokenRows(report) {
  const models = report.tokens?.models || [];
  if (models.length) return models;
  if (!report.tokens) return [{ model: "—", today: null, days7: null, days30: null }];
  return [{ model: "合计", today: report.tokens.today, days7: report.tokens.days7, days30: report.tokens.days30 }];
}

function tokenTable(reports, color, width) {
  const grouped = reports.map((report) => ({ report, rows: tokenRows(report) }));
  const serviceWidth = Math.max(6, ...grouped.map(({ report }) => displayWidth(report.name)));
  const modelWidth = Math.max(
    4, ...grouped.flatMap(({ rows }) => rows.map((entry) => displayWidth(clean(shortModel(entry.model))))),
  );
  const labels = ["今天", "近 7 天", "近 30 天"];
  const keys = ["today", "days7", "days30"];
  const numberWidths = keys.map((key, index) => Math.max(
    8, displayWidth(labels[index]), ...grouped.flatMap(({ rows }) => rows.map((entry) => displayWidth(formatTokens(entry[key])))),
  ));
  const minimum = serviceWidth + modelWidth + numberWidths.reduce((sum, size) => sum + size, GAP.length * 4);
  if (minimum > width) return tokenCompact(grouped, color, width, labels, keys);
  const extra = Math.min(6, Math.floor((width - minimum) / 4));
  const widths = [serviceWidth, modelWidth + width - minimum - extra * 3, ...numberWidths.map((size) => size + extra)];
  const lines = [paint(row(["服务", "模型", ...labels], widths, [2, 3, 4]), DIM, color), rule(width, color)];
  for (const { report, rows } of grouped) {
    rows.forEach((entry, index) => lines.push(row([
      index ? "" : providerTitle(report, color, false),
      clean(shortModel(entry.model)),
      ...keys.map((key, index) => paint(formatTokens(entry[key]), entry[key] == null || entry[key] === 0 ? DIM : index === 0 ? BOLD : null, color)),
    ], widths, [2, 3, 4])));
  }
  return lines;
}

function tokenCompact(grouped, color, width, labels, keys) {
  const lines = [rule(width, color)];
  const widths = labels.map((label, index) => Math.max(
    displayWidth(label), ...grouped.flatMap(({ rows }) => rows.map((entry) => displayWidth(formatTokens(entry[keys[index]])))),
  ));
  grouped.forEach(({ report, rows }, index) => {
    if (index) lines.push("");
    for (const title of wrap(report.name, width)) lines.push(paint(title, BOLD, color));
    for (const entry of rows) {
      for (const model of wrap(shortModel(entry.model), width - 2)) lines.push(GAP + model);
      const values = keys.map((key) => formatTokens(entry[key]));
      if (widths.reduce((sum, size) => sum + size, GAP.length * 2) <= width - 2) {
        lines.push(GAP + paint(row(labels, widths, [0, 1, 2]), DIM, color));
        lines.push(GAP + row(values, widths, [0, 1, 2]));
      } else {
        labels.forEach((label, index) => {
          for (const detail of wrap(`${label}  ${values[index]}`, width - 2)) lines.push(GAP + detail);
        });
      }
    }
  });
  return lines;
}

export function render(reports, { color = false, now = new Date(), width = 80, demo = false, ascii = false } = {}) {
  const contentWidth = Math.max(16, Math.min(96, Math.floor(Number(width) || 80) - 4));
  const stamp = `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  const title = paint(demo ? "aiusage · 示例" : "aiusage", BOLD + CYAN, color);
  const header = contentWidth >= displayWidth(title) + displayWidth(stamp) + 1
    ? [pad(title, contentWidth - displayWidth(stamp)) + paint(stamp, DIM, color)]
    : [title, paint(stamp, DIM, color)];
  const lines = ["", ...header, "", paint("套餐额度", BOLD, color)];
  if (reports.length) lines.push(...quotaTable(reports, now, color, contentWidth));
  else lines.push(rule(contentWidth, color), paint("暂无服务数据", DIM, color));
  lines.push("", paint("本机 Token", BOLD, color));
  if (reports.length) {
    lines.push(...tokenTable(reports, color, contentWidth), "");
    for (const note of wrap("本机日志 · 含缓存 · 近 7 / 30 天均含今天", contentWidth)) lines.push(paint(note, DIM, color));
  } else {
    lines.push(rule(contentWidth, color), paint("暂无本机 Token 记录", DIM, color));
  }
  const output = lines.map((line) => line ? GAP + line : "").join("\n") + "\n";
  return ascii ? output.replace(/━/gu, "#").replace(/─/gu, "-").replace(/·/gu, "/").replace(/—/gu, "-") : output;
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
        models: "models split the same totals; json counts stay raw, the terminal shows K, M, and B",
      },
    },
    null,
    2,
  )}\n`;
}
