import { createReadStream, existsSync, lstatSync, openSync, readSync, closeSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJson, readJson, writePrivateJson } from "./files.js";
import { quotaCacheDirectory } from "./quota-cache.js";

const INDEX_VERSION = 1;
const HEAD_BYTES = 64;
const RETENTION_MS = 35 * 86_400_000;
const memoryIndexes = new Map();

export function walkJsonl(root) {
  const files = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files;
}

function readPrefixHex(path, length) {
  if (length <= 0) return "";
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const count = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, count).toString("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Ignore close errors. */ }
    }
  }
}

function decodeLine(buffer, isAtFileStart) {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
  const text = buffer.subarray(0, end).toString("utf8");
  return isAtFileStart ? text.replace(/^\uFEFF/u, "") : text;
}

export async function readJsonlRange(path, startOffset, endSize, onCommittedLine, onTrailingLine, signal) {
  if (signal?.aborted || endSize <= 0 || startOffset >= endSize) {
    return { committedOffset: startOffset, headHex: null, aborted: Boolean(signal?.aborted) };
  }
  const stream = createReadStream(path, { start: startOffset, end: endSize - 1 });
  const closed = new Promise((resolve) => stream.once("close", resolve));
  const abort = () => stream.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  let carry = Buffer.alloc(0);
  let committedOffset = startOffset;
  const headChunks = startOffset === 0 ? [] : null;
  let headCollected = 0;

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (headChunks && headCollected < HEAD_BYTES) {
        const slice = chunk.subarray(0, Math.min(chunk.length, HEAD_BYTES - headCollected));
        headChunks.push(Buffer.from(slice));
        headCollected += slice.length;
      }
      let searchFrom = 0;
      while (searchFrom < chunk.length) {
        const nlIndex = chunk.indexOf(0x0a, searchFrom);
        if (nlIndex === -1) {
          const rest = chunk.subarray(searchFrom);
          carry = carry.length === 0 ? Buffer.from(rest) : Buffer.concat([carry, rest]);
          break;
        }
        const segment = chunk.subarray(searchFrom, nlIndex);
        const lineBuffer = carry.length === 0 ? segment : Buffer.concat([carry, segment]);
        const lineOffset = committedOffset;
        const rawBytes = carry.length + segment.length + 1;
        carry = Buffer.alloc(0);
        committedOffset += rawBytes;
        onCommittedLine(decodeLine(lineBuffer, lineOffset === 0));
        searchFrom = nlIndex + 1;
      }
    }
    if (!signal?.aborted && carry.length > 0 && onTrailingLine) {
      onTrailingLine(decodeLine(carry, committedOffset === 0));
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
    await closed;
  }

  return {
    committedOffset,
    headHex: headChunks ? Buffer.concat(headChunks, headCollected).toString("hex") : null,
    aborted: Boolean(signal?.aborted),
  };
}

function loadIndex(cacheDir) {
  if (memoryIndexes.has(cacheDir)) return memoryIndexes.get(cacheDir);
  const indexPath = join(cacheDir, "token-index-v1.json");
  let index = { version: INDEX_VERSION, files: {} };
  try {
    if (existsSync(indexPath)) {
      const parsed = readJson(indexPath);
      if (parsed?.version === INDEX_VERSION && parsed.files && typeof parsed.files === "object") {
        index = parsed;
      }
    }
  } catch {
    index = { version: INDEX_VERSION, files: {} };
  }
  memoryIndexes.set(cacheDir, index);
  return index;
}

function saveIndex(cacheDir, index, nowMs) {
  try {
    const cutoff = nowMs - RETENTION_MS;
    for (const [key, entry] of Object.entries(index.files)) {
      if (!entry || typeof entry.mtimeMs !== "number" || entry.mtimeMs < cutoff) {
        delete index.files[key];
      }
    }
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writePrivateJson(join(cacheDir, "token-index-v1.json"), index);
  } catch {
    // Unwritable or disabled cache directories must never break local token reads.
  }
}

export class TokenScanSession {
  constructor(now = new Date(), cacheDir = quotaCacheDirectory()) {
    this.nowMs = now instanceof Date ? now.getTime() : Number(now);
    this.cacheDir = cacheDir;
    this.index = loadIndex(cacheDir);
    this.dirty = false;
  }

  async scanFile(provider, path, adapter, signal) {
    if (signal?.aborted) return null;
    let info;
    try {
      info = lstatSync(path);
    } catch {
      return null;
    }
    if (!info.isFile() || info.size === 0) return null;

    const key = `${provider}\0${path}`;
    const existing = this.index.files[key];
    let canResume = false;
    if (existing && typeof existing.offset === "number" && existing.offset >= 0 && existing.offset <= info.size) {
      const sameInode = !info.ino || !existing.ino || info.ino === existing.ino;
      if (sameInode) {
        if (info.size === existing.offset && info.mtimeMs === existing.mtimeMs) {
          return adapter.materialize(existing.state, []);
        }
        const prefixLen = typeof existing.headHex === "string" ? existing.headHex.length / 2 : 0;
        if (prefixLen === 0 || readPrefixHex(path, prefixLen) === existing.headHex) {
          canResume = true;
        }
      }
    }

    const baseState = canResume ? adapter.clone(existing.state) : adapter.empty();
    const startOffset = canResume ? existing.offset : 0;
    if (startOffset === info.size) {
      existing.mtimeMs = info.mtimeMs;
      this.dirty = true;
      return adapter.materialize(baseState, []);
    }

    const trailingItems = [];
    const { committedOffset, headHex, aborted } = await readJsonlRange(
      path,
      startOffset,
      info.size,
      (line) => adapter.consume(baseState, line, false),
      (line) => adapter.consume(baseState, line, true, trailingItems),
      signal,
    );

    if (aborted) return null;

    let resolvedHead = startOffset === 0 ? (headHex ?? "") : (existing?.headHex ?? "");
    const targetHeadLen = Math.min(HEAD_BYTES, committedOffset);
    if (resolvedHead.length / 2 < targetHeadLen) {
      resolvedHead = readPrefixHex(path, targetHeadLen) ?? resolvedHead;
    }

    if (committedOffset > startOffset || !existing) {
      this.index.files[key] = {
        ino: info.ino || 0,
        mtimeMs: info.mtimeMs,
        offset: committedOffset,
        headHex: resolvedHead,
        state: adapter.compact ? adapter.compact(baseState, this.nowMs - RETENTION_MS) : baseState,
      };
      this.dirty = true;
    }

    return adapter.materialize(baseState, trailingItems);
  }

  flush(aborted = false) {
    if (!aborted && this.dirty) {
      saveIndex(this.cacheDir, this.index, this.nowMs);
      this.dirty = false;
    }
  }
}
