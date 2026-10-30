export const BAR_WIDTH = 20;

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
  constructor(now = new Date()) {
    this.todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    this.weekStart = new Date(now.getTime() - 7 * 86400000);
    this.monthStart = new Date(now.getTime() - 30 * 86400000);
    this.today = 0;
    this.week = 0;
    this.month = 0;
    this.models = new Map();
  }

  add(moment, amount, model = null) {
    if (!moment || amount == null || moment < this.monthStart) return;
    const value = Math.trunc(amount);
    this.month += value;
    const week = moment >= this.weekStart;
    const today = moment >= this.todayStart;
    if (week) this.week += value;
    if (today) this.today += value;
    const key = model || "未知";
    let row = this.models.get(key);
    if (!row) {
      row = { today: 0, days7: 0, days30: 0 };
      this.models.set(key, row);
    }
    row.days30 += value;
    if (week) row.days7 += value;
    if (today) row.today += value;
  }

  totals() {
    const models = [...this.models.entries()]
      .map(([model, row]) => ({ model, ...row }))
      .filter((row) => row.today || row.days7 || row.days30)
      .sort((a, b) => b.days30 - a.days30 || b.days7 - a.days7 || a.model.localeCompare(b.model));
    return { today: this.today, days7: this.week, days30: this.month, models };
  }
}
