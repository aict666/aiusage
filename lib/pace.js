import { parseTime } from "./time.js";

export function inferWindowSeconds(label, explicitSeconds = null) {
  if (Number.isFinite(explicitSeconds) && explicitSeconds > 0) return Math.round(explicitSeconds);
  if (typeof label !== "string") return null;
  const text = label.trim();
  if (text.includes("5 小时") || /\b5\s*h\b/iu.test(text)) return 5 * 3600;
  if (text.includes("7 天") || text.includes("每周") || text.endsWith("周") || /\bweekly\b/iu.test(text)) return 7 * 86400;
  return null;
}

export function computeWindowPace(window, now = new Date()) {
  if (!window || window.usedPercent == null || !Number.isFinite(Number(window.usedPercent))) return null;
  const resetDate = parseTime(window.resetsAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!resetDate || !Number.isFinite(resetDate.getTime()) || !Number.isFinite(nowMs)) return null;
  const durationSeconds = inferWindowSeconds(window.label, window.windowSeconds);
  if (!durationSeconds) return null;

  const durationMs = durationSeconds * 1000;
  const remainingMs = resetDate.getTime() - nowMs;
  if (remainingMs <= 0 || remainingMs > durationMs + 5 * 60_000) return null;

  const elapsedMs = Math.max(0, durationMs - Math.min(durationMs, remainingMs));
  const used = Math.max(0, Math.min(100, Number(window.usedPercent)));
  const elapsedPercent = Number(((elapsedMs / durationMs) * 100).toFixed(1));
  const deltaPercent = Number((used - elapsedPercent).toFixed(1));

  if (used >= 100) {
    const ratio = elapsedPercent >= 0.5 ? Number((used / elapsedPercent).toFixed(2)) : null;
    return {
      window_seconds: durationSeconds,
      elapsed_percent: elapsedPercent,
      delta_percent: deltaPercent,
      ratio,
      exhausts_at: new Date(nowMs).toISOString(),
      status: "exhausted",
    };
  }

  // Avoid noisy early-window ratios until meaningful time or quota (>=25%) is consumed.
  const minElapsedMs = used >= 25 ? 60_000 : Math.max(10 * 60_000, durationMs * 0.05);
  if (elapsedMs < minElapsedMs) {
    return {
      window_seconds: durationSeconds,
      elapsed_percent: elapsedPercent,
      delta_percent: deltaPercent,
      ratio: null,
      exhausts_at: null,
      status: "on_track",
    };
  }

  const ratio = elapsedPercent > 0 ? Number((used / elapsedPercent).toFixed(2)) : null;
  let exhaustsAt = null;
  let status = deltaPercent <= -12 ? "comfortable" : "on_track";

  // Require meaningful consumption (>=25% used and >=8% ahead of schedule) before warning,
  // so small day-1 bursts (e.g. 11% used on day 1 of a week) never trigger false alarms.
  if (used >= 25 && deltaPercent >= 8) {
    const ratePerMs = used / elapsedMs;
    const msUntilExhausted = (100 - used) / ratePerMs;
    if (Number.isFinite(msUntilExhausted) && msUntilExhausted < remainingMs * 0.95) {
      exhaustsAt = new Date(nowMs + Math.round(msUntilExhausted)).toISOString();
      const urgent = used >= 50 && ((ratio != null && ratio >= 1.6) || used >= 80 || msUntilExhausted <= 24 * 3_600_000);
      status = urgent ? "critical" : "ahead";
    }
  }

  return {
    window_seconds: durationSeconds,
    elapsed_percent: elapsedPercent,
    delta_percent: deltaPercent,
    ratio,
    exhausts_at: exhaustsAt,
    status,
  };
}
