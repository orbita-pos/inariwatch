/**
 * What-If service — answers "what would have happened if this fix had
 * been deployed when this session ran?"
 *
 * Architecture (Sesión 5A — AI prediction backend):
 *   1. Cache check on (session_id, fix_commit_sha) — deterministic key
 *      because fix code at sha=X always produces the same outcome
 *   2. On miss: pull the session's Substrate recording + the fix's file
 *      changes, ask the AI analyst (existing analyzeReplay infra) to
 *      predict whether the fix prevents the recorded crash
 *   3. Store result in whatif_replays so future requests are O(1)
 *
 * Sesión 5B+ swap: replace the AI prediction with real Substrate
 * execution (clone repo at fix sha, sandbox-run with recorded inputs,
 * diff outputs). The cache and shape stay the same — UI consumers
 * don't need to change. The `mode` field on the result tells callers
 * which backend produced it.
 *
 * Why a separate service from substrate-replay.ts:
 *   - substrate-replay analyzes a fix BEFORE merge (gate 6/7 of the 17)
 *   - what-if answers the post-incident question for the dashboard ("did
 *     this fix actually solve the user's problem?") — same machinery,
 *     different audience and different cache lifetime (forever vs per-merge)
 */

import { db } from "@/lib/db";
import { whatifReplays } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { analyzeReplay } from "@/lib/ai/substrate-replay";
import type { AIProvider } from "@/lib/ai/client";

// ── Types ──────────────────────────────────────────────────────────────────

export type WhatIfOutcome = "would_prevent" | "uncertain" | "would_not_prevent";

export interface WhatIfResult {
  outcome: WhatIfOutcome;
  /** 0–100. AI's self-reported confidence in the outcome. */
  confidence: number;
  /** 0–100. Lower = safer fix. Inverse of "would the fix introduce new risk". */
  riskScore: number;
  /** Human-readable 2–3 sentence explanation. */
  analysis: string;
  /** Which backend produced the result. Future-proofing for Sesión 5B. */
  mode: "ai_analysis" | "substrate_replay";
  /** True when the result came from the cache (skip AI cost on hit). */
  fromCache: boolean;
  /** ISO timestamp the cached row was originally computed. */
  computedAt: string;
}

export interface WhatIfInput {
  sessionId: string;
  /** Cache invalidation key. Same fix at same commit = same outcome. */
  fixCommitSha: string;
  /** Soft FK — surfaces the remediation in the cache row for ops drilldown. */
  remediationId?: string;
  /** Required for the analyzeReplay call. */
  alertId: string;
  projectId: string;
  diagnosis: string;
  fixFiles: { path: string; content: string }[];
  /** Caller resolves the API key (handles BYOK + platform key cascade). */
  apiKey: string;
  provider: AIProvider;
  model: string;
  userId: string;
  isPlatformKey?: boolean;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns a cached result when one exists for (sessionId, fixCommitSha),
 * otherwise computes a fresh one and stores it. Idempotent across calls
 * with identical inputs — no risk of double-billing the AI.
 */
export async function getOrComputeWhatIf(input: WhatIfInput): Promise<WhatIfResult | null> {
  const cached = await readCache(input.sessionId, input.fixCommitSha);
  if (cached) return cached;

  const computed = await compute(input);
  if (!computed) return null;

  await writeCache(input, computed);
  return { ...computed, fromCache: false };
}

/**
 * Pure cache-only lookup. The API endpoint uses this to expose a
 * "show me what we already have" surface that never spends AI tokens.
 * Returns null on miss — callers decide whether to escalate to compute.
 */
export async function readCache(
  sessionId: string,
  fixCommitSha: string,
): Promise<WhatIfResult | null> {
  const [row] = await db
    .select({
      result: whatifReplays.result,
      computedAt: whatifReplays.computedAt,
    })
    .from(whatifReplays)
    .where(and(
      eq(whatifReplays.sessionId, sessionId),
      eq(whatifReplays.fixCommitSha, fixCommitSha),
    ))
    .limit(1);

  if (!row) return null;
  const stored = row.result as Omit<WhatIfResult, "fromCache" | "computedAt">;

  // Bump last_accessed_at fire-and-forget — drives any future LRU sweep
  // without paying for the write on the response path. Errors swallowed
  // because failure here only loses bookkeeping, not correctness.
  db.update(whatifReplays)
    .set({ lastAccessedAt: new Date() })
    .where(and(
      eq(whatifReplays.sessionId, sessionId),
      eq(whatifReplays.fixCommitSha, fixCommitSha),
    ))
    .catch(() => {});

  return {
    ...stored,
    fromCache: true,
    computedAt: row.computedAt.toISOString(),
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

async function compute(input: WhatIfInput): Promise<Omit<WhatIfResult, "fromCache"> | null> {
  // analyzeReplay does the heavy lifting — pulls the recording, formats
  // it for the AI analyst, calls the model, parses the JSON response.
  // Reusing it keeps the AI prompt + scoring rubric consistent with the
  // pre-merge gate (substrate_replay) so the dashboard doesn't show
  // contradictory verdicts for the same fix.
  const result = await analyzeReplay(
    input.projectId,
    input.alertId,
    input.diagnosis,
    input.fixFiles,
    input.apiKey,
    input.provider,
    input.model,
    {
      userId: input.userId,
      isPlatformKey: input.isPlatformKey,
    },
    input.sessionId,
  );

  if (!result) return null;

  return {
    outcome: deriveOutcome(result.passed, result.confidence, result.riskScore),
    confidence: result.confidence,
    riskScore: result.riskScore,
    analysis: result.analysis,
    mode: "ai_analysis",
    computedAt: new Date().toISOString(),
  };
}

/**
 * Map analyzeReplay's binary `passed` + numeric scores to a 3-state
 * outcome the UI can show with distinct iconography. Confidence floor
 * of 60 prevents low-signal AI judgments from claiming success.
 */
function deriveOutcome(passed: boolean, confidence: number, riskScore: number): WhatIfOutcome {
  if (passed && confidence >= 60 && riskScore <= 40) return "would_prevent";
  if (!passed && confidence >= 60) return "would_not_prevent";
  return "uncertain";
}

async function writeCache(
  input: WhatIfInput,
  result: Omit<WhatIfResult, "fromCache">,
): Promise<void> {
  // ON CONFLICT DO NOTHING — a concurrent compute (rare but possible
  // when two reviewers click What-If simultaneously) shouldn't error.
  // First writer wins; subsequent reads pick up the same row.
  try {
    await db
      .insert(whatifReplays)
      .values({
        sessionId: input.sessionId,
        fixCommitSha: input.fixCommitSha,
        fixId: input.remediationId ?? null,
        result,
        status: "ready",
      })
      .onConflictDoNothing({
        target: [whatifReplays.sessionId, whatifReplays.fixCommitSha],
      });
  } catch {
    // Cache write failure shouldn't fail the request. The user gets
    // their fresh result; only the cache miss will repeat next time.
  }
}
