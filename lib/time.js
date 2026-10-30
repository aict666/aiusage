import { estimateCost } from "./pricing.js";

const WINDOWS = ["today", "days7", "days30"];
const USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_short_tokens", "cache_write_long_tokens"];

function emptyUsage() {
  return {
    ...Object.fromEntries(USAGE_FIELDS.map((key) => [key, 0])),
    unclassified_tokens: 0, cost_usd: 0, priced_tokens: 0, unpriced_tokens: 0,
    missing: new Set(), cost_reasons: new Set(),
  };
}

function emptyPeriods() {
  return Object.fromEntries(WINDOWS.map((key) => [key, emptyUsage()]));
}

function serializePeriods(periods) {
  return Object.fromEntries(WINDOWS.map((key) => {
    const value = periods[key];
    return [key, { ...value, cost_usd: Number(value.cost_usd.toFixed(8)), missing: [...value.missing].sort(), cost_reasons: [...value.cost_reasons].sort() }];
  }));
}

export function parseTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const stamp = value > 10_000_000_000 ? value : value * 1000;
    return new Date(stamp);
  }
  const text = String(value);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizePercent(value) {
  if (value == null) return null;
  const number = Number(value);
  if (number >= 0 && number <= 1) return number * 100;
  return number;
}

export class TokenBuckets {
  constructor(now = new Date(), provider = null) {
    this.todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    this.weekStart = new Date(now.getTime() - 7 * 86400000);
    this.monthStart = new Date(now.getTime() - 30 * 86400000);
    this.today = 0;
    this.week = 0;
    this.month = 0;
    this.models = new Map();
    this.provider = provider;
    this.usage = emptyPeriods();
  }

  add(moment, amount, model = null, usage = null) {
    if (!moment || !Number.isFinite(moment.getTime()) || amount == null || !Number.isSafeInteger(amount) || amount < 0 || moment < this.monthStart) return;
    const value = Math.trunc(amount);
    this.month += value;
    const week = moment >= this.weekStart;
    const today = moment >= this.todayStart;
    if (week) this.week += value;
    if (today) this.today += value;
    const key = model || "未知";
    let row = this.models.get(key);
    if (!row) {
      row = { today: 0, days7: 0, days30: 0, usage: emptyPeriods() };
      this.models.set(key, row);
    }
    row.days30 += value;
    if (week) row.days7 += value;
    if (today) row.today += value;
    const detail = usage?.valid && usage.total === value ? usage : null;
    const estimate = usage && !detail ? { usd: null, reason: "inconsistent_usage" }
      : detail ? estimateCost(this.provider, model, detail) : { usd: value === 0 ? 0 : null, reason: "incomplete_usage" };
    const windows = ["days30", ...(week ? ["days7"] : []), ...(today ? ["today"] : [])];
    for (const periods of [this.usage, row.usage]) for (const window of windows) {
      const target = periods[window];
      for (const key of USAGE_FIELDS) {
        if (detail?.[key] != null) target[key] += detail[key];
        else if (value) target.missing.add(key);
      }
      target.unclassified_tokens += detail?.unclassified_tokens ?? value;
      if (estimate.usd != null) {
        target.cost_usd += estimate.usd;
        target.priced_tokens += value;
      } else {
        target.unpriced_tokens += value;
        target.cost_reasons.add(estimate.reason);
      }
    }
  }

  totals() {
    const models = [...this.models.entries()]
      .map(([model, row]) => ({ model, ...row, usage: serializePeriods(row.usage) }))
      .filter((row) => row.today || row.days7 || row.days30)
      .sort((a, b) => b.days30 - a.days30 || b.days7 - a.days7 || a.model.localeCompare(b.model));
    return { today: this.today, days7: this.week, days30: this.month, models, usage: serializePeriods(this.usage) };
  }
}
