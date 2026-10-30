import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configHome, readJson, writePrivateJson } from "./files.js";

export const MIN_QUOTA_INTERVAL = 10 * 60_000;
const LOCK_TIMEOUT = 120_000;
const EMPTY = { plan: null, windows: [], skipped: false };

export function quotaCacheDirectory({ env = process.env, homeDir = homedir(), platform = process.platform } = {}) {
  if (env.AIUSAGE_CACHE_DIR) return configHome("AIUSAGE_CACHE_DIR", ".cache/aiusage", { env, homeDir, platform });
  if (platform === "win32") return join(env.LOCALAPPDATA || join(homeDir, "AppData", "Local"), "aiusage", "Cache");
  if (platform === "darwin") return join(homeDir, "Library", "Caches", "aiusage");
  return join(env.XDG_CACHE_HOME || join(homeDir, ".cache"), "aiusage");
}

function readState(path) {
  try {
    const state = readJson(path);
    if (state.version !== 1 || !Number.isFinite(state.nextAttemptAt) || !Number.isFinite(state.lastAttemptAt) ||
        !Number.isInteger(state.failures) || state.failures < 0 ||
        (state.result && !Array.isArray(state.result.windows))) throw new Error("额度缓存格式无效");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export class QuotaCache {
  constructor({ directory = quotaCacheDirectory(), interval = MIN_QUOTA_INTERVAL, offline = false, background = false, now = Date.now, random = Math.random } = {}) {
    if (!Number.isFinite(interval) || interval < MIN_QUOTA_INTERVAL) throw new Error("额度刷新间隔至少 600 秒");
    Object.assign(this, { directory, interval, offline, background, now, random });
    this.pending = new Map();
  }

  snapshot(state, { cached = true, status = null, error = null } = {}) {
    return {
      ...(state?.result || EMPTY),
      error: error || state?.error || null,
      quota: {
        updated_at: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null,
        next_refresh_at: state?.nextAttemptAt ? new Date(Math.max(state.nextAttemptAt, state.lastAttemptAt + this.interval)).toISOString() : null,
        cached, status: status || (this.offline ? "offline" : state?.error ? "backoff" : state?.pending ? "updating" : "ok"),
      },
    };
  }

  cachePath(name, scope) {
    const key = createHash("sha256").update(`${name}\0${scope}`).digest("hex").slice(0, 24);
    return join(this.directory, key);
  }

  async get(name, load, scope = "") {
    if (!this.background || this.offline) return this.refresh(name, load, scope);
    const key = this.cachePath(name, scope);
    let task = this.pending.get(key);
    if (!task) {
      task = this.refresh(name, load, scope);
      this.pending.set(key, task);
      task.then(() => this.pending.delete(key), () => this.pending.delete(key));
    }
    // Fast cache/error results can complete immediately. Slow HTTP never holds up
    // local token collection or the next live repaint.
    const ready = await Promise.race([task, Promise.resolve(null)]);
    if (ready) return ready;
    try {
      return this.snapshot(readState(`${key}.json`));
    } catch (error) {
      return this.snapshot(null, { status: "cache-error", error: `额度缓存不可用：${error.message}` });
    }
  }

  drain() {
    return Promise.allSettled(this.pending.values());
  }

  async refresh(name, load, scope = "") {
    const key = this.cachePath(name, scope);
    const path = `${key}.json`;
    const lock = `${key}.lock`;
    let state;
    let locked = false;
    try {
      state = readState(path);
      const now = this.now();
      if (this.offline || (state && now < Math.max(state.nextAttemptAt, state.lastAttemptAt + this.interval))) return this.snapshot(state);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      try {
        mkdirSync(lock, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Expired locks only: never allow two active instances to poll together.
        if (now - statSync(lock).mtimeMs <= LOCK_TIMEOUT) return this.snapshot(readState(path), { status: "updating" });
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock, { mode: 0o700 });
      }
      locked = true;
      // Recheck after acquiring the cross-process lock.
      state = readState(path);
      if (state && now < Math.max(state.nextAttemptAt, state.lastAttemptAt + this.interval)) return this.snapshot(state);
      const jitter = () => Math.floor(Math.max(0, Math.min(1, this.random())) * 60_000);
      // Reserve a cooldown before any network/auth request, including across crashes.
      const reserved = { version: 1, failures: 0, ...state, pending: true, lastAttemptAt: now, nextAttemptAt: now + this.interval + jitter() };
      writePrivateJson(path, reserved);
      try {
        const [plan, windows] = await load();
        state = { ...reserved, pending: false, result: { plan, windows, skipped: false }, updatedAt: this.now(), error: null, failures: 0 };
        state.nextAttemptAt = this.now() + this.interval + jitter();
      } catch (error) {
        if (error.name === "AbortError") return this.snapshot(reserved);
        const skipped = error.message === "未登录";
        const failures = skipped ? 0 : (reserved.failures || 0) + 1;
        const floor = error.code === 429 ? 30 * 60_000 : [401, 403].includes(error.code) ? 60 * 60_000 : this.interval;
        const delay = skipped ? this.interval : Math.max(this.interval, Math.min(6 * 3600_000, floor * 2 ** Math.min(failures - 1, 8)));
        state = {
          ...reserved, pending: false, failures,
          result: skipped ? { ...EMPTY, skipped: true } : reserved.result,
          updatedAt: skipped ? null : reserved.updatedAt,
          error: skipped ? null : error.message,
          nextAttemptAt: Math.max(this.now() + delay + jitter(), Number(error.retryAt) || 0),
        };
      }
      writePrivateJson(path, state);
      return this.snapshot(state, { cached: Boolean(state.error) });
    } catch (error) {
      // A broken/unwritable cache must not turn every local refresh into an API call.
      return this.snapshot(state, { status: "cache-error", error: `额度缓存不可用：${error.message}` });
    } finally {
      if (locked) rmSync(lock, { recursive: true, force: true });
    }
  }
}
