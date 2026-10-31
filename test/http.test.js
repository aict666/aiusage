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

test("a stalled error body cannot hide HTTP 429 or its Retry-After", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false, status: 429, headers: new Headers({ "retry-after": "3600" }),
    body: { cancel: () => new Promise(() => {}) },
  }));
  await assert.rejects(httpJson("https://example.test", { timeoutMs: 5 }), (error) => {
    assert.equal(error.code, 429);
    assert.ok(error.retryAt >= Date.now() + 3590_000);
    return true;
  });
});

test("the deadline still settles a JSON response that ignores cancellation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: () => new Promise(() => {}) }));
  await assert.rejects(httpJson("https://example.test", { timeoutMs: 5 }), /请求超时/);
});

test("exiting live releases a request even when fetch does not observe the abort signal", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", () => new Promise(() => {}));
  const pending = httpJson("https://example.test", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
