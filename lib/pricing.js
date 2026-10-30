export const pricingInfo = {
  currency: "USD",
  checked_at: "2026-10-30",
  basis: "Current standard global API token prices, applied per request; not subscription billing. Excludes tools, taxes, speed-tier premiums and regional premiums.",
  sources: {
    Claude: "https://platform.claude.com/docs/en/about-claude/pricing",
    Codex: "https://developers.openai.com/api/docs/pricing",
    Grok: "https://docs.x.ai/developers/pricing",
  },
};

// USD per million tokens. Cache write rates are total rates, not surcharges.
const claude = (input, output, read = input * 0.1, longContext = null) => ({
  input, output, read, writeShort: input * 1.25, writeLong: input * 2, longContext,
});
const openai = (input, output, read, writes = true, longContext = true) => ({
  input, output, read, writeShort: writes ? input * 1.25 : null, writeLong: writes ? input * 2.5 : null,
  longContext: longContext ? { threshold: 272_000, inclusive: false, input: 2, output: 1.5 } : null,
});
const grok = (input, output, read) => ({
  input, output, read, writeShort: null, writeLong: null,
  longContext: { threshold: 200_000, inclusive: true, input: 2, output: 2 },
});

const prices = {
  Claude: {
    "claude-opus-5-5": claude(4, 20, 0.2),
    "claude-sonnet-5-5": claude(2, 10, 0.1),
    "claude-haiku-5-5": claude(0.1, 0.5, 0.01, { threshold: 100_000, inclusive: false, input: 5, output: 5 }),
    "claude-fable-5-1": claude(10, 50, 0.25),
    "claude-mythos-5-1": claude(10, 50, 0.25),
    "claude-fable-5": claude(10, 50),
    "claude-mythos-5": claude(10, 50),
    "claude-opus-5": claude(5, 25),
    "claude-opus-4-8": claude(5, 25),
    "claude-opus-4-7": claude(5, 25),
    "claude-opus-4-6": claude(5, 25),
    "claude-opus-4-5": claude(5, 25),
    "claude-opus-4-1": claude(15, 75),
    "claude-opus-4": claude(15, 75),
    "claude-sonnet-5": claude(2, 10),
    "claude-sonnet-4-6": claude(3, 15),
    "claude-sonnet-4-5": { ...claude(3, 15), maxPrompt: 200_000 },
    "claude-sonnet-4": { ...claude(3, 15), maxPrompt: 200_000 },
    "claude-haiku-4-5": claude(1, 5),
    "claude-3-5-haiku": claude(0.8, 4),
  },
  Codex: {
    "gpt-6.1-sol": openai(2, 10, 0.1),
    "gpt-6.1-terra": openai(1, 5, 0.05),
    "gpt-6-astra": openai(10, 50, 1),
    "gpt-6-sol": openai(2, 10, 0.2),
    "gpt-6-luna": openai(0.1, 0.5, 0.01),
    "gpt-5.6-sol": openai(4, 20, 0.4),
    "gpt-5.6-terra": openai(2, 12, 0.2),
    "gpt-5.6-luna": openai(0.2, 1.2, 0.02),
    "gpt-5.5": openai(5, 30, 0.5, false),
    "gpt-5.4": openai(2.5, 15, 0.25, false),
    "gpt-5.4-mini": openai(0.75, 4.5, 0.075, false, false),
    "gpt-5.4-nano": openai(0.2, 1.25, 0.02, false, false),
    "gpt-5.2": openai(1.75, 14, 0.175, false, false),
    "gpt-5.1": openai(1.25, 10, 0.125, false, false),
    "gpt-5": openai(1.25, 10, 0.125, false, false),
  },
  Grok: {
    "grok-4.7": grok(2, 6, 0.5),
    "grok-4.6": grok(2, 6, 0.5),
    "grok-4.5": grok(2, 6, 0.3),
    "grok-4.3": grok(1.25, 2.5, 0.2),
    "grok-4.20-multi-agent-0309": grok(1.25, 2.5, 0.2),
    "grok-4.20-0309-reasoning": grok(1.25, 2.5, 0.2),
    "grok-4.20-0309-non-reasoning": grok(1.25, 2.5, 0.2),
    "grok-build-0.1": grok(1, 2, 0.2),
  },
};

export function modelPrice(provider, model) {
  if (typeof model !== "string") return null;
  // Only strip a dated snapshot suffix. Never infer an unknown model's price from its family.
  const key = model.replace(/(?:-\d{8}|-\d{4}-\d{2}-\d{2})$/u, "");
  return prices[provider]?.[model] || prices[provider]?.[key] || null;
}

export function estimateCost(provider, model, usage) {
  if (usage.total === 0) return { usd: 0, reason: null };
  const price = modelPrice(provider, model);
  if (!price) return { usd: null, reason: "unknown_model_price" };
  if (!usage.valid || usage.unclassified_tokens || [usage.input_tokens, usage.output_tokens, usage.cache_read_tokens].some((value) => value == null || value < 0)) {
    return { usd: null, reason: "incomplete_usage" };
  }
  if (usage.cache_write_tokens && (usage.cache_write_short_tokens == null || usage.cache_write_long_tokens == null)) {
    return { usd: null, reason: "unknown_cache_write_lifetime" };
  }
  if ((usage.cache_write_short_tokens && price.writeShort == null) || (usage.cache_write_long_tokens && price.writeLong == null)) {
    return { usd: null, reason: "unknown_cache_write_price" };
  }
  if (price.longContext && usage.prompt_tokens == null) return { usd: null, reason: "unknown_prompt_length" };
  if (price.maxPrompt && usage.prompt_tokens > price.maxPrompt) return { usd: null, reason: "unsupported_prompt_length" };
  const long = price.longContext && (price.longContext.inclusive ? usage.prompt_tokens >= price.longContext.threshold : usage.prompt_tokens > price.longContext.threshold);
  const inputMultiplier = long ? price.longContext.input : 1;
  const outputMultiplier = long ? price.longContext.output : 1;
  const input = usage.input_tokens * price.input + usage.cache_read_tokens * price.read +
    (usage.cache_write_short_tokens || 0) * (price.writeShort || 0) + (usage.cache_write_long_tokens || 0) * (price.writeLong || 0);
  return { usd: (input * inputMultiplier + usage.output_tokens * price.output * outputMultiplier) / 1_000_000, reason: null };
}

export function costTotals(reports) {
  return Object.fromEntries(["today", "days7", "days30"].map((key) => {
    const parts = reports.map((report) => report.tokens?.usage?.[key]);
    return [key, {
      cost_usd: Number(parts.reduce((sum, part) => sum + (part?.cost_usd || 0), 0).toFixed(8)),
      priced_tokens: parts.reduce((sum, part) => sum + (part?.priced_tokens || 0), 0),
      unpriced_tokens: parts.reduce((sum, part) => sum + (part?.unpriced_tokens || 0), 0),
      incomplete: parts.some((part, index) => !part ? reports[index].tokens?.[key] !== 0 : part.unpriced_tokens > 0),
    }];
  }));
}
