import assert from "node:assert/strict";
import test from "node:test";
import { httpJson, retryAfterTime } from "../lib/http.js";

test("Retry-After accepts seconds, dates, zero and invalid values", () => {
  const now = Date.parse("2026-10-30T07:00:00Z");
  assert.equal(retryAfterTime("120", now), now + 120_000);
  assert.equal(retryAfterTime("Fri, 30 Oct 2026 08:00:00 GMT", now), now + 3600_000);
  assert.equal(retryAfterTime("0", now), now);
  for (const value of [null, "", "invalid"]) assert.equal(retryAfterTime(value, now), null);
});

test("HTTP throttling is returned once with Retry-After and no automatic retries", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => { reads++; return new Response("private error details", { status: 429, headers: { "retry-after": "3600" } }); });
  const now = Date.now();
  await assert.rejects(httpJson("https://example.test"), (error) => {
    assert.equal(error.code, 429);
    assert.equal(error.message, "HTTP 429");
    assert.ok(error.retryAt >= now + 3600_000);
    return true;
  });
  assert.equal(reads, 1);
});

test("stopping live aborts an in-flight HTTP request promptly", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const pending = httpJson("https://example.test", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("a stalled provider is aborted at the request deadline", async (t) => {
  t.mock.method(globalThis, "fetch", (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: 20 })), { once: true });
  }));
  await assert.rejects(httpJson("https://example.test", { timeoutMs: 5 }), /请求超时/);
});
