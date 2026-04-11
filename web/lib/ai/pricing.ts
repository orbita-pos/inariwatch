/**
 * AI model pricing table — USD per 1M tokens.
 *
 * Sourced from provider pricing pages as of April 2026. Update when
 * providers change rates. This file is the single source of truth for
 * cost calculation in the usage dashboard.
 *
 * Format: [input per 1M, output per 1M, cached input per 1M?]
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cached input tokens (prompt caching hit) — null if N/A */
  cachedInput?: number;
}

// ── OpenAI ──────────────────────────────────────────────────────────────────
export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-5 family (2026)
  "gpt-5.4":      { input: 1.25, output: 10.00, cachedInput: 0.125 },
  "gpt-5":        { input: 1.25, output: 10.00, cachedInput: 0.125 },
  "gpt-5-mini":   { input: 0.25, output: 2.00,  cachedInput: 0.025 },
  "gpt-5-nano":   { input: 0.05, output: 0.40,  cachedInput: 0.005 },

  // GPT-4.1 family
  "gpt-4.1":      { input: 2.00, output: 8.00,  cachedInput: 1.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60,  cachedInput: 0.20 },
  "gpt-4.1-nano": { input: 0.05, output: 0.20,  cachedInput: 0.025 },

  // GPT-4o family (legacy but still widely used)
  "gpt-4o":       { input: 2.50, output: 10.00, cachedInput: 1.25 },
  "gpt-4o-mini":  { input: 0.15, output: 0.60,  cachedInput: 0.075 },

  // Reasoning models
  "o4-mini":      { input: 1.10, output: 4.40,  cachedInput: 0.275 },
  "o3":           { input: 2.00, output: 8.00,  cachedInput: 1.00 },
  "o1":           { input: 15.00, output: 60.00 },
  "o1-mini":      { input: 1.10, output: 4.40 },
};

// ── Anthropic Claude ────────────────────────────────────────────────────────
export const CLAUDE_PRICING: Record<string, ModelPricing> = {
  // Claude 4.6 (2026)
  "claude-opus-4-6":   { input: 5.00, output: 25.00, cachedInput: 0.50 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00, cachedInput: 0.30 },
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00, cachedInput: 0.10 },
  "claude-haiku-4-5": { input: 1.00, output: 5.00, cachedInput: 0.10 },

  // Legacy 4.5
  "claude-opus-4-5":   { input: 5.00, output: 25.00, cachedInput: 0.50 },
  "claude-sonnet-4-5": { input: 3.00, output: 15.00, cachedInput: 0.30 },

  // Legacy 3.5
  "claude-3-5-haiku-20241022":  { input: 0.80, output: 4.00,  cachedInput: 0.08 },
  "claude-3-5-sonnet-20241022": { input: 3.00, output: 15.00, cachedInput: 0.30 },
};

// ── Google Gemini ───────────────────────────────────────────────────────────
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  "gemini-3.1-pro":        { input: 2.00, output: 12.00 },
  "gemini-3-pro":          { input: 2.00, output: 12.00 },
  "gemini-2.5-pro":        { input: 1.25, output: 10.00 },
  "gemini-2.5-flash":      { input: 0.30, output: 2.50 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.0-flash":      { input: 0.10, output: 0.40 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.30 },
  // Legacy 1.5
  "gemini-1.5-pro":        { input: 1.25, output: 5.00 },
  "gemini-1.5-flash":      { input: 0.075, output: 0.30 },
};

// ── DeepSeek ─────────────────────────────────────────────────────────────────
export const DEEPSEEK_PRICING: Record<string, ModelPricing> = {
  "deepseek-chat":     { input: 0.28, output: 0.42, cachedInput: 0.028 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cachedInput: 0.055 },
};

// ── Groq (hosted open models) ───────────────────────────────────────────────
export const GROQ_PRICING: Record<string, ModelPricing> = {
  "llama-3.1-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant":    { input: 0.05, output: 0.08 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-4-scout":           { input: 0.11, output: 0.34 },
  "llama-4-maverick":        { input: 0.50, output: 0.77 },
  "mixtral-8x7b-32768":      { input: 0.24, output: 0.24 },
  "kimi-k2":                 { input: 1.00, output: 3.00 },
};

// ── Grok (xAI) ──────────────────────────────────────────────────────────────
export const GROK_PRICING: Record<string, ModelPricing> = {
  "grok-2-mini-1212": { input: 0.30, output: 0.50 },
  "grok-2-1212":      { input: 2.00, output: 10.00 },
  "grok-3-beta":      { input: 3.00, output: 15.00 },
  "grok-4":           { input: 3.00, output: 15.00 },
};

// ── Combined lookup ─────────────────────────────────────────────────────────

const ALL_PRICING: Record<string, ModelPricing> = {
  ...OPENAI_PRICING,
  ...CLAUDE_PRICING,
  ...GEMINI_PRICING,
  ...DEEPSEEK_PRICING,
  ...GROQ_PRICING,
  ...GROK_PRICING,
};

/**
 * Get pricing for a model by ID. Returns a default (zeroed) if unknown —
 * unknown models are rare and we don't want to crash the usage logger.
 */
export function getModelPricing(modelId: string): ModelPricing {
  return (
    ALL_PRICING[modelId] ?? {
      input: 0,
      output: 0,
    }
  );
}

/**
 * Compute the USD cost of an AI call given token counts.
 *
 * @param modelId  Model identifier (e.g. "gpt-4o-mini")
 * @param inputTokens  Total input tokens (includes any cached input)
 * @param outputTokens Output tokens
 * @param cachedInputTokens  Portion of input that was a cache hit (optional)
 */
export function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): number {
  const pricing = getModelPricing(modelId);

  // Cached tokens billed at discounted rate; non-cached at full rate.
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  const freshInputCost = (freshInput / 1_000_000) * pricing.input;
  const cachedInputCost =
    pricing.cachedInput != null
      ? (cachedInputTokens / 1_000_000) * pricing.cachedInput
      : (cachedInputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return freshInputCost + cachedInputCost + outputCost;
}

/**
 * Format cost for display. Returns "$0.00" for values < 1 cent, up to
 * 4 decimal places for small values.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
