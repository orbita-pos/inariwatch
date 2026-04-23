/**
 * Tier 0 handler — direct pattern_memory apply, no LLM.
 *
 * **Not wired in Fase 6.** Shipped as a type-complete stub so that
 * activation in Fase 6.1 is a body-only edit (no signature changes,
 * no caller updates). Throws `TierHandlerNotWiredError` if invoked.
 *
 * Contract (for Fase 6.1 implementation):
 *   - Input: the remediation session + the winning pattern match.
 *   - Output: a `FileChange[]` ready to be pushed by the existing
 *     apply-patch / push pipeline in `remediate.ts`.
 *   - Gate: caller MUST check `meetsTier0PromotionGate(match)` first.
 *   - Telemetry: log to ai_usage_logs with phase='tier_0_apply'.
 *   - Fallback: on any failure, return { skipped: reason } and let the
 *     caller fall through to Tier 1 or Tier 2.
 */

import type { RemediationSession } from "@/lib/db/schema";
import type { PatternMatch } from "./pattern-memory";

export type FileChange = { path: string; content: string };

export type Tier0Result =
  | { ok: true; fileChanges: FileChange[] }
  | { ok: false; skipped: "gate_failed" | "no_cached_diff" | "apply_failed" };

export class TierHandlerNotWiredError extends Error {
  constructor(tier: 0 | 1) {
    super(`Tier ${tier} handler is not wired until Fase 6.1`);
    this.name = "TierHandlerNotWiredError";
  }
}

export async function runTier0(
  _session: Pick<RemediationSession, "id" | "projectId" | "alertId" | "repo" | "baseBranch">,
  _match: PatternMatch,
): Promise<Tier0Result> {
  throw new TierHandlerNotWiredError(0);
}
