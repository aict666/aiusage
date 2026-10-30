import { stripVTControlCharacters } from "node:util";
import { parseTime } from "./time.js";
import { costTotals, pricingInfo } from "./pricing.js";

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
  const filled = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * width)) : 0;
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
  const moment = parseTime(window.resetsAt);
  if (!moment || !Number.isFinite(moment.getTime())) return "—";
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

function quotaError(report, now) {
  const retry = report.quota?.status === "backoff" && report.quota.next_refresh_at
    ? ` · 下次 ${formatWhen(report.quota.next_refresh_at, now)}` : "";
  return clean(report.error) + retry;
}

function message(report, now) {
  if (report.skipped) return "未登录 · 请先登录对应的 CLI";
  if (report.error) return `读取失败 · ${quotaError(report, now)}`;
  if (report.quota?.status === "offline") return "离线模式 · 暂无额度缓存";
  if (report.quota?.status === "updating") return "额度更新中";
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
      const details = wrap(message(report, now), available);
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
      for (const detail of wrap(`提示 · ${quotaError(report, now)}`, width - indent.length)) {
        lines.push(indent + paint(detail, YELLOW, color));
      }
    }
  }
  return lines;
}

function quotaCompact(reports, now, color, width) {
  const lines = [rule(width, color)];
  reports.forEach((report) => {
    for (const title of wrap(providerTitle(report, false), width)) lines.push(paint(title, BOLD, color));
    if (report.skipped || report.windows.length === 0) {
      for (const detail of wrap(message(report, now), width - 2)) lines.push(GAP + paint(detail, report.error ? YELLOW : DIM, color));
      return;
    }
    for (const window of report.windows) {
      const used = finitePercent(window.usedPercent);
      const label = clean(window.label);
      const percentWidth = Math.max(4, displayWidth(percentText(used)));
      const barWidth = Math.min(BAR_WIDTH, width - 2 - displayWidth(label) - 2 - 1 - percentWidth);
      if (barWidth >= 4) lines.push(`${GAP}${label}${GAP}${usageCell(window, barWidth, percentWidth, color)}`);
      else for (const detail of wrap(`${label} · 已用 ${percentText(used)}`, width - 2)) lines.push(GAP + detail);
      for (const detail of wrap(`剩余 ${percentText(remaining(window))} · 重置 ${resetText(window, now)}`, width - 2)) {
        lines.push(GAP + paint(detail, DIM, color));
      }
    }
    if (report.error) for (const detail of wrap(`提示 · ${quotaError(report, now)}`, width - 2)) lines.push(GAP + paint(detail, YELLOW, color));
  });
  return lines;
}

function tokenRows(report) {
  const models = report.tokens?.models || [];
  if (models.length) return models;
  if (!report.tokens) return [{ model: "—", today: null, days7: null, days30: null }];
  return [{ model: "合计", today: report.tokens.today, days7: report.tokens.days7, days30: report.tokens.days30 }];
}

function usagePeriod(entry, key) {
  if (entry.usage?.[key]) return entry.usage[key];
  if (entry[key] === 0) return { cost_usd: 0, priced_tokens: 0, unpriced_tokens: 0, missing: [], input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  return null;
}

function detailTokens(entry, key, field) {
  const period = usagePeriod(entry, key);
  if (!period) return "—";
  const value = period[field];
  if (period.missing?.includes(field)) return value ? `${formatTokens(value)}+` : "—";
  return formatTokens(value);
}

function cacheHitRate(entry, key) {
  const period = usagePeriod(entry, key);
  const fields = ["input_tokens", "cache_read_tokens", "cache_write_tokens"];
  if (!period || period.unclassified_tokens > 0 || fields.some((field) => period[field] == null || period.missing?.includes(field))) return "—";
  const prompt = fields.reduce((sum, field) => sum + period[field], 0);
  return prompt ? `${(period.cache_read_tokens / prompt * 100).toFixed(1)}%` : "—";
}

function showCacheWrites(entry, details) {
  return details || ["today", "days7", "days30"].some((key) => {
    const period = usagePeriod(entry, key);
    return !period || period.cache_write_tokens !== 0 || period.missing?.includes("cache_write_tokens");
  });
}

export function formatCost(period) {
  if (!period) return "—";
  const partial = period.incomplete || period.unpriced_tokens > 0;
  if (partial && !period.priced_tokens) return "—";
  const value = period.cost_usd;
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01 && !partial) return "<$0.01";
  const amount = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${amount}${partial ? "+" : ""}`;
}

function metrics(entry, details, color = false) {
  const keys = ["today", "days7", "days30"];
  if (!details) {
    const writes = showCacheWrites(entry, false);
    return [
      { label: shortModel(entry.model), kind: "total", values: keys.map((key) =>
        paint(formatTokens(entry[key]), entry[key] === 0 ? DIM : null, color) + paint(" / ", DIM, color) +
        paint(formatCost(usagePeriod(entry, key)), BOLD + CYAN, color)),
      },
      { label: writes ? "  缓存读/写" : "  读缓存", kind: "detail", values: keys.map((key) =>
        detailTokens(entry, key, "cache_read_tokens") + (writes ? ` / ${detailTokens(entry, key, "cache_write_tokens")}` : "")),
      },
    ];
  }
  return [
    { label: shortModel(entry.model), values: keys.map((key) => formatTokens(entry[key])), kind: "total" },
    ...(details ? [
      { label: "  输入(未缓存)", values: keys.map((key) => detailTokens(entry, key, "input_tokens")), kind: "detail" },
      { label: "  输出", values: keys.map((key) => detailTokens(entry, key, "output_tokens")), kind: "detail" },
    ] : []),
    { label: "  读缓存", values: keys.map((key) => detailTokens(entry, key, "cache_read_tokens")), kind: "detail" },
    ...(showCacheWrites(entry, details) ? [{ label: "  写缓存", values: keys.map((key) => detailTokens(entry, key, "cache_write_tokens")), kind: "detail" }] : []),
    ...(details ? [{ label: "  命中率", values: keys.map((key) => cacheHitRate(entry, key)), kind: "detail" }] : []),
    { label: "  估算", values: keys.map((key) => formatCost(usagePeriod(entry, key))), kind: "cost" },
  ];
}

function tokenTable(reports, color, width, details) {
  const grouped = reports.map((report) => ({ report, rows: tokenRows(report) }));
  const allMetrics = grouped.flatMap(({ rows }) => rows.flatMap((entry) => metrics(entry, details)));
  const serviceWidth = Math.max(6, ...grouped.map(({ report }) => displayWidth(report.name)));
  const modelWidth = Math.max(
    displayWidth("估算 USD"), ...allMetrics.map((entry) => displayWidth(entry.label)),
  );
  const labels = ["今天", "近 7 天", "近 30 天"];
  const keys = ["today", "days7", "days30"];
  const totals = costTotals(reports);
  const totalValues = keys.map((key) => formatCost(totals[key]));
  const numberWidths = keys.map((key, index) => Math.max(
    8, displayWidth(labels[index]), displayWidth(totalValues[index]), ...allMetrics.map((entry) => displayWidth(entry.values[index])),
  ));
  const minimum = serviceWidth + modelWidth + numberWidths.reduce((sum, size) => sum + size, GAP.length * 4);
  if (minimum > width) return tokenCompact(grouped, color, width, labels, keys, details, totals);
  const headers = ["服务", "模型", ...labels.map((label) => details ? label : `${label} Token/USD`)];
  const boxedWidths = [serviceWidth, modelWidth, ...numberWidths].map((size, index) => Math.max(size, displayWidth(headers[index])));
  const boxed = boxedWidths.reduce((sum, size) => sum + size, boxedWidths.length * 3 + 1) <= width;
  const widths = boxed ? boxedWidths : [serviceWidth, modelWidth, ...numberWidths];
  const boundary = (left, middle, right) => paint(left + widths.map((size) => "─".repeat(size + 2)).join(middle) + right, DIM, color);
  const tableRow = (cells) => boxed ? paint("│", DIM, color) + cells.map((cell, index) =>
    " " + pad(cell, widths[index], index > 1 ? "right" : "left") + " ").join(paint("│", DIM, color)) + paint("│", DIM, color)
    : row(cells, widths, [2, 3, 4]);
  const lines = boxed
    ? [boundary("┌", "┬", "┐"), tableRow(headers.map((label) => paint(label, BOLD + CYAN, color))), boundary("├", "┼", "┤")]
    : [paint(row(["服务", "模型", ...labels], widths, [2, 3, 4]), DIM, color), rule(width, color)];
  for (const { report, rows } of grouped) {
    rows.forEach((entry, index) => {
      for (const metric of metrics(entry, details, color)) lines.push(tableRow([
        !index && metric.kind === "total" ? providerTitle(report, color, false) : "",
        paint((metric.kind === "total" ? "" : GAP) + clean(metric.label), metric.kind === "detail" ? DIM : null, color),
        ...metric.values.map((value) => paint(value, metric.kind === "cost" ? BOLD + CYAN : metric.kind === "detail" || value === "0" || value === "—" ? DIM : null, color)),
      ]));
    });
  }
  lines.push(boxed ? boundary("├", "┼", "┤") : rule(width, color),
    tableRow([paint("合计", BOLD, color), "估算 USD", ...totalValues.map((value) => paint(value, BOLD + CYAN, color))]));
  if (boxed) lines.push(boundary("└", "┴", "┘"));
  return lines;
}

function tokenCompact(grouped, color, width, labels, keys, details, totals) {
  const lines = [rule(width, color)];
  grouped.forEach(({ report, rows }) => {
    for (const title of wrap(report.name, width)) lines.push(paint(title, BOLD, color));
    for (const entry of rows) {
      for (const model of wrap(shortModel(entry.model), width - 2)) lines.push(GAP + model);
      keys.forEach((key, index) => {
        const summary = `${labels[index]}  ${formatTokens(entry[key])} · ${formatCost(usagePeriod(entry, key))}`;
        for (const detail of wrap(summary, width - 2)) lines.push(GAP + detail);
        const cache = `读缓存 ${detailTokens(entry, key, "cache_read_tokens")}` +
          (showCacheWrites(entry, details) ? ` · 写 ${detailTokens(entry, key, "cache_write_tokens")}` : "");
        for (const detail of wrap(cache, width - 4)) lines.push(GAP + GAP + paint(detail, DIM, color));
        if (details) for (const detail of wrap(`未缓存输入 ${detailTokens(entry, key, "input_tokens")} · 输出 ${detailTokens(entry, key, "output_tokens")}`, width - 4)) lines.push(GAP + GAP + paint(detail, DIM, color));
        if (details) for (const detail of wrap(`命中率 ${cacheHitRate(entry, key)}`, width - 4)) lines.push(GAP + GAP + paint(detail, DIM, color));
      });
    }
  });
  lines.push(rule(width, color));
  for (const title of wrap("合计 / 估算 USD", width)) lines.push(paint(title, BOLD, color));
  keys.forEach((key, index) => {
    for (const detail of wrap(`${labels[index]}  ${formatCost(totals[key])}`, width - 2)) lines.push(GAP + paint(detail, BOLD + CYAN, color));
  });
  return lines;
}

export function render(reports, { color = false, now = new Date(), width = 80, demo = false, ascii = false, details = false } = {}) {
  const contentWidth = Math.max(16, Math.min(96, Math.floor(Number(width) || 80) - 4));
  const stamp = `${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  const title = paint(demo ? "aiusage · 示例" : "aiusage", BOLD + CYAN, color);
  const header = contentWidth >= displayWidth(title) + displayWidth(stamp) + 1
    ? [pad(title, contentWidth - displayWidth(stamp)) + paint(stamp, DIM, color)]
    : [title, paint(stamp, DIM, color)];
  const lines = [...header, paint("套餐额度", BOLD, color)];
  if (reports.length) lines.push(...quotaTable(reports, now, color, contentWidth));
  else lines.push(rule(contentWidth, color), paint("暂无服务数据", DIM, color));
  const snapshots = reports.filter((report) => report.quota?.updated_at).map((report) => {
    const when = formatWhen(report.quota.updated_at, now)?.replace(/^今天 /, "");
    return `${report.name} ${when}${report.error ? " !" : ""}`;
  });
  if (snapshots.length) for (const note of wrap(`额度快照 · ${snapshots.join(" · ")}`, contentWidth)) lines.push(paint(note, DIM, color));
  lines.push("", paint("本机 Token", BOLD, color));
  if (reports.length) {
    lines.push(...tokenTable(reports, color, contentWidth, details));
    for (const note of wrap("Token 含缓存 · API 估算 USD，非套餐扣费", contentWidth)) lines.push(paint(note, DIM, color));
    if (details) for (const note of wrap(`读缓存是逐次请求累计命中量 · 价格 ${pricingInfo.checked_at}`, contentWidth)) lines.push(paint(note, DIM, color));
    const incomplete = reports.some((report) => report.tokens == null || Object.values(report.tokens.usage || {}).some((period) => period.unpriced_tokens > 0 || period.missing?.length));
    if (details || incomplete) for (const note of wrap("+ 已知部分；— 信息不足", contentWidth)) lines.push(paint(note, DIM, color));
  } else {
    lines.push(rule(contentWidth, color), paint("暂无本机 Token 记录", DIM, color));
  }
  const output = lines.map((line) => line ? GAP + line : "").join("\n") + "\n";
  return ascii ? output.replace(/━/gu, "#").replace(/─/gu, "-").replace(/[┌┬┐├┼┤└┴┘]/gu, "+").replace(/│/gu, "|").replace(/·/gu, "/").replace(/—/gu, "-") : output;
}

export function dumps(reports, now = new Date()) {
  return `${JSON.stringify(
    {
      generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      providers: reports.map((report) => report.toJSON()),
      pricing: pricingInfo,
      cost_totals: costTotals(reports),
      token_notes: {
        claude: "input + cache_creation + cache_read + output, last snapshot per request; message ID is the fallback identity",
        codex: "per-call usage only, never cumulative turn_token_usage/thread_token_usage; deduplicated by response_id when available",
        grok: "prompt_tokens + completion_tokens; cached prompt is already inside prompt_tokens",
        windows: "days_7 and days_30 include today",
        models: "models split the same totals; json counts stay raw, the terminal shows K, M, and B",
        breakdown: "usage.input_tokens excludes cached reads and writes; cache_write_short/long are subsets of cache_write_tokens; reasoning is already in output",
        cache_reads: "cache hits summed across requests, not unique cached content or storage size; hit rate = cache reads / (uncached input + cache reads + cache writes)",
        cache_write_lifetimes: "short/long: Claude 5m/1h; Codex 30m/12h. Grok has no separately billed cache-write category.",
        costs: "usage.cost_usd is the priced portion; unpriced_tokens and cost_reasons disclose gaps. missing lists partially observed counters. Costs use current standard global API rates, not subscription bills.",
      },
    },
    null,
    2,
  )}\n`;
}
