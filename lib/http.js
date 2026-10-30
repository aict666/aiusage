export function retryAfterTime(value, now = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : null;
}

export async function httpJson(url, { headers = {}, body = null, signal, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: body == null ? "GET" : "POST", headers, body, signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? "登录已过期" : `HTTP ${response.status}`);
      error.code = response.status;
      error.retryAt = retryAfterTime(response.headers.get("retry-after"));
      // Do not include an HTML challenge or credential response in the dashboard/cache.
      await response.body?.cancel();
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (signal?.aborted) {
      const cancelled = new Error("已停止刷新");
      cancelled.name = "AbortError";
      throw cancelled;
    }
    if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
    if (error.code) throw error;
    throw new Error(`网络失败：${error.message}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
