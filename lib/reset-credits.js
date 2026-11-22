import { httpJson } from "./http.js";

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function claudeResetCredits(data, now = Date.now()) {
  const block = data.cedar_ember;
  if (!block || !Array.isArray(block.grants)) return null;
  // A surface rejection is not an authoritative empty inventory.
  if (block.ineligible_reason === "surface") return null;
  const credits = block.grants.filter((g) => g && count(g.resets_left) > 0 && !g.paused &&
    (!g.ends_at || (timestamp(g.ends_at) && Date.parse(g.ends_at) > now))).map((g) => ({
      count: g.resets_left, expires_at: timestamp(g.ends_at), starts_at: timestamp(g.starts_at),
      label: typeof g.label === "string" ? g.label : null,
    }));
  return { count: credits.reduce((sum, c) => sum + c.count, 0), credits, error: null };
}

export function codexResetCredits(summary, details = null, now = Date.now()) {
  const source = Array.isArray(details) ? details : details?.credits;
  const credits = Array.isArray(source) ? source.filter((c) => c &&
    (!c.reset_type || c.reset_type === "codex_rate_limits") && (!c.status || c.status === "available") &&
    (!c.expires_at || (timestamp(c.expires_at) && Date.parse(c.expires_at) > now)))
    .map((c) => ({ count: 1, expires_at: timestamp(c.expires_at), label: typeof c.title === "string" ? c.title : null })) : [];
  return {
    count: Array.isArray(source) ? credits.length : count(summary?.available_count),
    applicable_count: count(summary?.applicable_available_count), credits, error: null,
  };
}

// ConsumerUiSvc uses gRPC-Web, with tokens at field 10, validity_end at
// field 30, and protobuf Timestamp.seconds at field 1. Redemption IDs are
// deliberately never retained. Unknown protobuf fields are skipped.
function fields(bytes) {
  let offset = 0;
  const result = [];
  const invalid = () => { throw new Error("Grok 重置卡响应格式无效"); };
  const varint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) invalid();
      const b = bytes[offset++];
      if (i === 9 && b > 1) invalid();
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return value;
    }
    invalid();
  };
  while (offset < bytes.length) {
    const tag = Number(varint()), wire = tag & 7, number = Math.floor(tag / 8);
    if (!number) invalid();
    if (wire === 0) result.push([number, varint()]);
    else {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : invalid();
      if (!Number.isSafeInteger(length) || offset + length > bytes.length) invalid();
      if (wire === 2) result.push([number, bytes.subarray(offset, offset + length)]);
      offset += length;
    }
  }
  return result;
}

export function parseGrokResetCredits(input, now = Date.now()) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Grok 重置卡响应格式无效");
  const credits = [];
  let offset = 0, sawData = false;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) throw new Error("Grok 重置卡响应不完整");
    const flag = bytes[offset], length = bytes.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + length > bytes.length) throw new Error("Grok 重置卡响应不完整");
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (flag === 128) {
      const status = payload.toString().match(/(?:^|\r?\n)grpc-status:\s*(\d+)/i);
      if (!status || status[1] !== "0") throw new Error("Grok 重置卡查询被拒绝");
    } else if (flag === 0) {
      sawData = true;
      for (const [number, token] of fields(payload)) {
        if (number !== 10 || !Buffer.isBuffer(token)) continue;
        const expiry = fields(token).find(([n, v]) => n === 30 && Buffer.isBuffer(v))?.[1];
        const seconds = expiry && fields(expiry).find(([n, v]) => n === 1 && typeof v === "bigint")?.[1];
        const date = seconds == null ? null : new Date(Number(seconds) * 1000);
        if (date && !Number.isFinite(date.getTime())) throw new Error("Grok 重置卡过期时间无效");
        if (!date || date.getTime() > now) credits.push({ count: 1, expires_at: date?.toISOString() || null });
      }
    } else throw new Error("Grok 重置卡响应格式无效");
  }
  if (!sawData) throw new Error("Grok 重置卡响应缺少数据");
  return { count: credits.length, credits: credits.slice(0, 64), error: null };
}

export async function fetchGrokResetCredits(key, signal) {
  const bytes = await httpJson("https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets", {
    signal, responseType: "bytes", body: new Uint8Array(5),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/grpc-web+proto", "x-grpc-web": "1", Origin: "https://grok.com" },
  });
  return parseGrokResetCredits(bytes);
}

export async function optionalResetCredits(load, fallback = null) {
  try { return await load(); }
  catch (error) {
    if (error.name === "AbortError") throw error;
    return { count: null, credits: [], ...fallback, error: error.message };
  }
}
