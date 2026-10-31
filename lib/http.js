export function retryAfterTime(value, now = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : null;
}

export async function httpJson(url, { headers = {}, body = null, signal, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const cancelled = () => Object.assign(new Error("已停止刷新"), { name: "AbortError" });
  if (signal?.aborted) throw cancelled();
  let abort, timeout;
  const interrupted = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(cancelled()); };
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`请求超时（${timeoutMs / 1000} 秒）`));
    }, timeoutMs);
  });
  signal?.addEventListener("abort", abort, { once: true });
  const request = async () => {
    const response = await fetch(url, {
      method: body == null ? "GET" : "POST", headers, body, signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? "登录已过期" : `HTTP ${response.status}`);
      error.code = response.status;
      error.retryAt = retryAfterTime(response.headers.get("retry-after"));
      // Do not include an HTML challenge or credential response in the dashboard/cache.
      // Releasing an error body must not hold up the status/Retry-After result.
      try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* Keep the HTTP error. */ }
      throw error;
    }
    return await response.json();
  };
  try {
    // Bound the entire operation, including response JSON/body processing, even
    // when a runtime's pending promise does not settle after signal.abort().
    return await Promise.race([request(), interrupted]);
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
    if (error.code) throw error;
    throw new Error(`网络失败：${error.message}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
