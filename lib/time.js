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
  }

  add(moment, amount) {
    if (!moment || amount == null || moment < this.monthStart) return;
    const value = Math.trunc(amount);
    this.month += value;
    if (moment >= this.weekStart) this.week += value;
    if (moment >= this.todayStart) this.today += value;
  }

  totals() {
    return { today: this.today, days7: this.week, days30: this.month };
  }
}
