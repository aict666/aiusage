export function tokenCount(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function writes(total, short, long) {
  short = tokenCount(short);
  long = tokenCount(long);
  total = tokenCount(total);
  if (total == null || (total === 0 && (short || long))) total = (short || 0) + (long || 0);
  if (total === 0) return { total, short: 0, long: 0 };
  if (short == null && long != null) short = total - long;
  if (long == null && short != null) long = total - short;
  if (short == null || long == null || short < 0 || long < 0 || short + long !== total) return { total, short: null, long: null };
  return { total, short, long };
}

function normalized({ total, prompt, input, output, read, write, reasoning = null }) {
  const known = [input, output, read, write.total].reduce((sum, value) => sum + (value || 0), 0);
  return {
    total: total ?? known,
    prompt_tokens: prompt,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: read,
    cache_write_tokens: write.total,
    cache_write_short_tokens: write.short,
    cache_write_long_tokens: write.long,
    reasoning_tokens: tokenCount(reasoning),
    unclassified_tokens: Math.max(0, (total ?? known) - known),
    valid: (total == null || known <= total) && (input == null || input >= 0),
  };
}

export function claudeUsage(usage) {
  const declaredWrite = tokenCount(usage.cache_creation_input_tokens) || Object.values(usage.cache_creation || {}).reduce((sum, value) => sum + (tokenCount(value) || 0), 0);
  const write = writes(declaredWrite,
    usage.cache_creation?.ephemeral_5m_input_tokens, usage.cache_creation?.ephemeral_1h_input_tokens);
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const read = tokenCount(usage.cache_read_input_tokens);
  const prompt = (input || 0) + (read || 0) + write.total;
  return normalized({ input, output, read, write, prompt, total: prompt + (output || 0), reasoning: usage.output_tokens_details?.thinking_tokens });
}

export function codexUsage(usage) {
  const prompt = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const details = usage.input_tokens_details;
  const read = tokenCount(usage.cached_input_tokens ?? details?.cached_tokens);
  const ttl = usage.cache_write_input_tokens_details ?? details?.cache_write_tokens_details;
  const write = writes(usage.cache_write_input_tokens ?? details?.cache_write_tokens, ttl?.ttl_30m_tokens, ttl?.ttl_12h_tokens);
  const input = prompt == null || read == null ? null : prompt - read - write.total;
  return normalized({
    total: tokenCount(usage.total_tokens) ?? (prompt == null || output == null ? null : prompt + output),
    prompt, input, output, read, write, reasoning: usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens,
  });
}

export function grokUsage(usage) {
  const prompt = tokenCount(usage.prompt_tokens);
  const output = tokenCount(usage.completion_tokens);
  const read = tokenCount(usage.cached_prompt_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  return normalized({
    total: (prompt || 0) + (output || 0), prompt,
    input: prompt == null || read == null ? null : prompt - read,
    output, read, write: { total: 0, short: 0, long: 0 }, reasoning: usage.reasoning_tokens,
  });
}
