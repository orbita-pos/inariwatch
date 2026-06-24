/**
 * Fase 3 — worker-side model router.
 *
 * Mirror of web/lib/ai/models.ts `resolveModelForPhase`. The worker
 * package is isolated (no @/lib imports) so the mapping is duplicated
 * here. Keep in sync with the web version whenever phase targets change;
 * the web tests in web/lib/ai/__tests__/models-phase.test.ts are the
 * canonical spec.
 *
 * Only OpenAI gets the full GPT-5 family treatment. Every other
 * provider falls back to the currently-passed exploreModel / fixModel,
 * so BYOK users experience no behavior change in Fase 3.
 */

import type { AIProvider } from "./ai-client.js";

export type RemediationPhase = "classify" | "triage" | "explore" | "fix" | "final";

const PHASE_MODELS_OPENAI: Record<RemediationPhase, string> = {
  classify: "gpt-5-nano",   // catalog only in Fase 3; Fase 6 wires the tier router
  triage:   "gpt-5-mini",
  explore:  "gpt-5-mini",
  fix:      "gpt-5.4",
  final:    "gpt-5.4",
};

/**
 * Resolve the model to use for a specific phase. For non-OpenAI providers
 * the caller is expected to pass the models it already uses — this helper
 * returns `null` there, signaling "keep whatever you were going to use".
 */
export function resolveModelForPhase(
  phase: RemediationPhase,
  provider: AIProvider,
): string | null {
  if (provider === "openai") return PHASE_MODELS_OPENAI[phase];
  return null;
}

/**
 * Reasoning effort for a phase (mirror of web/lib/ai/openai-config.ts
 * `effortForPhase`). Kept here so the worker doesn't import from web.
 */
export function effortForPhase(
  phase: RemediationPhase,
): "minimal" | "low" | "medium" | "high" {
  switch (phase) {
    case "classify": return "minimal";
    case "triage":   return "minimal";
    case "explore":  return "low";
    case "fix":      return "medium";
    case "final":    return "high";
  }
}
