/**
 * OpenAI provider options — hardcoded defaults that matter for the
 * Responses API path (GPT-5.x family).
 *
 * Pattern lifted from vercel-labs/open-agents packages/agent/models.ts.
 * Three settings that are non-obvious and bite you in production:
 *
 * 1. `store: false` — we never want OpenAI to persist our prompts/responses
 *    server-side. InariLens is the canonical SSOT; OpenAI is compute only.
 *    This matches the public privacy policy.
 *
 * 2. `include: ["reasoning.encrypted_content"]` — required companion to
 *    `store: false` when using reasoning models across multiple turns.
 *    Without this, the second turn errors with "Item rs_... not found"
 *    because the API discards the reasoning item from turn 1. The
 *    encrypted blob lets us forward the reasoning context server-side
 *    without OpenAI persisting it.
 *
 * 3. `textVerbosity: "low"` — GPT-5.4 is noticeably more verbose than
 *    prior GPT-5 versions. Without this clamp the agent adds preamble
 *    and recap that wastes output tokens (= money + latency).
 */

export interface OpenAIProviderOptions {
  store: boolean;
  include: string[];
  textVerbosity?: "low" | "medium" | "high";
}

const GPT_5_MODEL_PREFIXES = ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4"] as const;

/**
 * Returns true when the model is part of the GPT-5.x reasoning family.
 * These models MUST use the Responses API — Chat Completions is deprecated
 * for reasoning models as of GPT-5.4 and tool_use stops working reliably.
 */
export function isGPT5Family(model: string): boolean {
  const lower = model.toLowerCase();
  return GPT_5_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Returns the canonical provider options for a given OpenAI model.
 * Safe to pass even for non-GPT-5 models — the Chat Completions path
 * ignores these fields.
 */
export function getOpenAIProviderOptions(modelId: string): OpenAIProviderOptions {
  const base: OpenAIProviderOptions = {
    store: false,
    include: ["reasoning.encrypted_content"],
  };

  // gpt-5.4 specifically clamped to low verbosity — the rest of the family
  // uses default verbosity. (gpt-5, gpt-5.1, gpt-5.2, gpt-5.3 did not have
  // the verbosity regression that 5.4 did.)
  if (modelId.toLowerCase().startsWith("gpt-5.4")) {
    base.textVerbosity = "low";
  }

  return base;
}

// ── Reasoning effort policy ─────────────────────────────────────────────────

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * Pick a reasoning effort level based on which phase of the agent loop
 * the call is serving. Every agent turn passes this through the adapter
 * to the Responses API.
 *
 * Rationale (from Cognition / Devin lessons + OpenAI's GPT-5.x guide):
 *   - minimal : classification, extraction, dispatch (no exploration)
 *   - low     : exploration turns — read_file, search_code, list_directory.
 *               The model shouldn't spend 5K reasoning tokens deciding to
 *               run a grep.
 *   - medium  : fix generation — the default for agentic code work.
 *   - high    : retry after failure — give the model room to reconsider
 *               and try a different approach.
 *
 * Review ops (self-review, security-scan) use "low" because they're
 * analyzing an already-generated fix, not reasoning about it from scratch.
 */
export function effortForPhase(
  phase: "classify" | "explore" | "fix" | "retry" | "review",
): ReasoningEffort {
  switch (phase) {
    case "classify": return "minimal";
    case "explore":  return "low";
    case "fix":      return "medium";
    case "retry":    return "high";
    case "review":   return "low";
  }
}

/**
 * Turn-based effort dial for the main remediation loop.
 *
 * The fix model runs at `medium` until the last few turns, where it
 * bumps to `high` — giving it more reasoning budget to land the fix
 * before the turn cap. This pairs naturally with the explore/fix model
 * cascade (mini for early turns, full for final turns).
 */
export function effortForTurn(turn: number, maxTurns: number): ReasoningEffort {
  if (turn <= Math.floor(maxTurns * 0.6)) return "low";      // exploration
  if (turn <= maxTurns - 3) return "medium";                  // fix
  return "high";                                               // final retries
}
