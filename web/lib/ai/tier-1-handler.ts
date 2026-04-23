/**
 * Tier 1 handler — single-shot gpt-5-nano with category-specialized template.
 *
 * **Not wired in Fase 6.** Shipped as a type-complete stub so that
 * activation in Fase 6.1 is a body-only edit.
 *
 * Contract (for Fase 6.1 implementation):
 *   - Input: the remediation session + feature vector + a context object
 *     that carries the same fields remediate.ts already gathers (diagnosis,
 *     repo access token, recent files).
 *   - Output: a `FileChange[]` ready for the existing push pipeline.
 *   - Template selection: `categoryTemplate[features.errorCategory]` —
 *     each template is a prompt + expected JSON output shape.
 *   - Fallback: any failure returns { ok: false } so the caller promotes
 *     to Tier 2 (the current production single-shot flagship path).
 */

import type { RemediationSession } from "@/lib/db/schema";
import type { RouterFeatures } from "./tier-router";
import { TierHandlerNotWiredError, type FileChange } from "./tier-0-handler";

export type Tier1Context = {
  /** Diagnosis text already produced by the first pass of remediate.ts. */
  diagnosis: string;
  /** GitHub token for reading context files (not writing — writes go through
   *  the normal push pipeline). */
  githubToken: string;
  /** Canonical `owner/repo` resolved by remediate.ts. */
  repo: string;
  /** Base branch for fix branch creation. */
  baseBranch: string;
};

export type Tier1Result =
  | { ok: true; fileChanges: FileChange[] }
  | { ok: false; skipped: "no_template" | "model_error" | "malformed_output" | "empty_fix" };

export async function runTier1(
  _session: Pick<RemediationSession, "id" | "projectId" | "alertId" | "userId">,
  _features: RouterFeatures,
  _context: Tier1Context,
): Promise<Tier1Result> {
  throw new TierHandlerNotWiredError(1);
}
