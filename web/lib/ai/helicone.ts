/**
 * Helicone proxy integration — observability for all AI calls.
 *
 * When HELICONE_API_KEY is set, all AI provider calls are routed through
 * Helicone's proxy URLs. This adds zero latency (50-80ms overhead) but
 * gives us:
 *   - Per-call cost, latency, token usage
 *   - Per-feature attribution (auto-analyze vs remediate vs chat)
 *   - Per-tier attribution (Groq vs GPT-4o-mini vs Sonnet)
 *   - Cache hit visibility (Helicone-side cache for tier 0)
 *
 * If HELICONE_API_KEY is not set, falls back to direct provider URLs.
 * Backward-compatible — zero behavior change without the env var.
 */

import type { AIProvider } from "./client";

const HELICONE_KEY = process.env.HELICONE_API_KEY ?? "";

/**
 * Returns the Helicone proxy URL for a provider, or null if Helicone is
 * not configured. Caller falls back to the direct provider URL.
 */
export function heliconeBaseUrl(provider: AIProvider): string | null {
  if (!HELICONE_KEY) return null;
  switch (provider) {
    case "openai":   return "https://oai.helicone.ai/v1";
    case "claude":   return "https://anthropic.helicone.ai";
    case "groq":     return "https://groq.helicone.ai/openai/v1";
    case "grok":     return "https://gateway.helicone.ai/v1"; // Helicone gateway for xAI
    case "deepseek": return "https://gateway.helicone.ai/v1";
    case "gemini":   return null; // Gemini not natively supported; use direct
    default:         return null;
  }
}

/**
 * Returns Helicone-specific headers for attribution + caching.
 * Includes: auth, feature, tier, userId, alertId, projectId, cache toggle.
 *
 * Pass `cacheEnabled: true` for tier 0 (Groq) where same-fingerprint
 * requests are very common and cheap to cache.
 */
export function heliconeHeaders(ctx: {
  feature?: string;
  tier?: number;
  userId?: string | null;
  alertId?: string | null;
  projectId?: string | null;
  remediationSessionId?: string | null;
  cacheEnabled?: boolean;
}): Record<string, string> {
  if (!HELICONE_KEY) return {};

  const headers: Record<string, string> = {
    "Helicone-Auth": `Bearer ${HELICONE_KEY}`,
  };

  if (ctx.feature) headers["Helicone-Property-Feature"] = ctx.feature;
  if (ctx.tier !== undefined) headers["Helicone-Property-Tier"] = String(ctx.tier);
  if (ctx.userId) headers["Helicone-Property-UserId"] = ctx.userId;
  if (ctx.alertId) headers["Helicone-Property-AlertId"] = ctx.alertId;
  if (ctx.projectId) headers["Helicone-Property-ProjectId"] = ctx.projectId;
  if (ctx.remediationSessionId) headers["Helicone-Property-SessionId"] = ctx.remediationSessionId;

  if (ctx.cacheEnabled) {
    headers["Helicone-Cache-Enabled"] = "true";
    headers["Helicone-Cache-Bucket-Max-Size"] = "10";
    headers["Cache-Control"] = "max-age=3600"; // 1h cache TTL
  }

  return headers;
}

export const heliconeEnabled = !!HELICONE_KEY;
