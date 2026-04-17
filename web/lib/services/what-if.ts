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
import { whatifReplays, substrateRecordings } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { analyzeReplay } from "@/lib/ai/substrate-replay";
import {
  isSubstrateConfigured,
  runSubstrateSimulate,
  SubstrateNotConfiguredError,
  type SubstrateRecordingShape,
  type RiskLevel,
} from "@/lib/services/substrate-runner";
import type { AIProvider } from "@/lib/ai/client";

// ── Types ──────────────────────────────────────────────────────────────────

export type WhatIfOutcome = "would_prevent" | "uncertain" | "would_not_prevent";

export interface WhatIfResult {
  outcome: WhatIfOutcome;
  /** 0–100. Backend's self-reported confidence (AI: model self-report;
   *  Substrate: 95 when matched, 70 otherwise). */
  confidence: number;
  /** 0–100. Lower = safer fix. */
  riskScore: number;
  /** Human-readable 2–3 sentence explanation. */
  analysis: string;
  /** Which backend produced the result. */
  mode: "ai_analysis" | "substrate_replay";
  /** True when the result came from the cache (skip AI cost on hit). */
  fromCache: boolean;
  /** ISO timestamp the cached row was originally computed. */
  computedAt: string;
  /** Substrate-only fields. Present iff mode === "substrate_replay". */
  substrate?: {
    /** True when the replayed I/O matched the original recording exactly. */
    matched: boolean;
    eventCountBefore: number;
    eventCountAfter: number;
    riskLevel: RiskLevel;
    blastRadius: {
      httpPaths: string[];
      dbTables: string[];
      filePaths: string[];
      totalSurfaces: number;
    };
    /** Recommendations from the substrate risk report (1–4 short strings). */
    recommendations: string[];
  };
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
  /**
   * Sesión 5B-1 — when present AND the substrate binary is configured,
   * runs the deterministic Substrate replay against the original recording
   * with this command instead of asking the AI. The command should run
   * the FIXED code (e.g. "node app.js" after the patches in fixFiles have
   * been applied to a checkout of the repo at fixCommitSha). When absent
   * or substrate unavailable, falls back to AI prediction.
   *
   * Sesión 5B-2 will add automatic repo checkout + fix application so
   * callers don't need to construct this manually.
   */
  substrateCommand?: string;
  /** Working directory for the substrate command. Defaults to the
   *  recording's recorded cwd. */
  substrateCwd?: string;
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
  // Try Substrate replay first — it's deterministic, uses real I/O
  // recordings, and produces structured blast-radius data the AI path
  // can't. Falls through to AI on any failure (binary missing, recording
  // not found, command rejected by guard, timeout, parse error).
  if (input.substrateCommand && isSubstrateConfigured()) {
    const substrateResult = await tryComputeSubstrate(input).catch(() => null);
    if (substrateResult) return substrateResult;
  }

  // AI fallback. Same scoring rubric as the pre-merge substrate_replay
  // gate so the dashboard doesn't show contradictory verdicts for the
  // same fix when the AI path takes over.
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
 * Pulls the most recent substrate recording for the session, materializes
 * it to .substrate file shape, runs `substrate simulate` with the fixed
 * command. Returns null on any failure so the caller falls back to AI.
 */
async function tryComputeSubstrate(input: WhatIfInput): Promise<Omit<WhatIfResult, "fromCache"> | null> {
  if (!input.substrateCommand) return null;

  const [rec] = await db
    .select({
      recordingId: substrateRecordings.recordingId,
      events: substrateRecordings.events,
      command: substrateRecordings.command,
      runtime: substrateRecordings.runtime,
      startedAt: substrateRecordings.startedAt,
      endedAt: substrateRecordings.endedAt,
    })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.sessionId, input.sessionId))
    .limit(1);

  if (!rec || !Array.isArray(rec.events) || rec.events.length === 0) return null;

  const recording: SubstrateRecordingShape = {
    meta: {
      id: rec.recordingId,
      started_at: (rec.startedAt ?? new Date()).toISOString(),
      ended_at: (rec.endedAt ?? new Date()).toISOString(),
      command: (rec.command ?? "node app.js").split(/\s+/),
      cwd: input.substrateCwd ?? process.cwd(),
      env: {},
      substrate_version: "0.1.0",
      runtime: rec.runtime ?? "node",
    },
    events: rec.events as unknown[],
  };

  try {
    const sim = await runSubstrateSimulate({
      recording,
      command: input.substrateCommand,
      cwd: input.substrateCwd,
      timeoutMs: 60_000,
    });

    return {
      outcome: substrateOutcome(sim.matched, sim.riskLevel),
      // Confidence is mechanical for substrate: deterministic match = 95,
      // mismatch = 70 (we know SOMETHING is different but the report tells
      // us specifically what). Higher than typical AI self-reports because
      // the underlying signal is concrete.
      confidence: sim.matched ? 95 : 70,
      riskScore: sim.riskScore,
      analysis: sim.recommendations[0] ?? (sim.matched
        ? "Substrate replay matched the original I/O sequence — fix preserves recorded behavior."
        : "Substrate replay diverged from the original — see blast radius for affected surfaces."),
      mode: "substrate_replay",
      computedAt: new Date().toISOString(),
      substrate: {
        matched: sim.matched,
        eventCountBefore: sim.eventCountBefore,
        eventCountAfter: sim.eventCountAfter,
        riskLevel: sim.riskLevel,
        blastRadius: sim.blastRadius,
        recommendations: sim.recommendations,
      },
    };
  } catch (e) {
    if (e instanceof SubstrateNotConfiguredError) return null;
    // Re-throw any unexpected error so the caller's catch can swallow it
    // and fall back to AI without us silently losing diagnostics.
    throw e;
  }
}

function substrateOutcome(matched: boolean, riskLevel: RiskLevel): WhatIfOutcome {
  if (matched && (riskLevel === "low" || riskLevel === "medium")) return "would_prevent";
  if (!matched && riskLevel === "critical") return "would_not_prevent";
  return "uncertain";
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
