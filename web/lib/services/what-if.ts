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
  /**
   * Sesión 5B-2 — GitHub token for cloning the repo from the Hetzner
   * worker. When set together with `WORKER_URL`, the worker becomes the
   * preferred compute path: it handles clone + patch + entry-point
   * detection + substrate simulate on localhost (no Vercel timeout).
   * When unset or worker unavailable, the local substrate or AI paths
   * handle the request.
   */
  githubToken?: string;
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
  // Sesión 5B-2: when the Hetzner worker is configured, delegate the full
  // substrate pipeline to it. The worker clones the repo at the fix
  // commit, applies fileChanges, detects the entry point, and runs
  // substrate simulate — all on localhost, no Vercel timeout. We only
  // need a remediationId + github token; the worker handles the rest.
  if (isWorkerConfigured() && input.remediationId && input.githubToken) {
    const workerResult = await tryComputeViaWorker(input).catch(() => null);
    if (workerResult) return workerResult;
  }

  // Local substrate path — used in dev and as a fallback when the caller
  // already knows the substrateCommand (e.g. manually constructed in
  // tests or self-hosted). Same scoring/shape as the worker path.
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
 * True iff WORKER_URL is set to an https:// or localhost url. We reject
 * plain http:// to non-localhost — the token travels in the request body
 * and would be exposed on the wire otherwise.
 */
function isWorkerConfigured(): boolean {
  const url = process.env.WORKER_URL;
  if (!url) return false;
  return url.startsWith("https://") || url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1");
}

/**
 * Call the Hetzner worker's /worker/whatif endpoint. The worker handles
 * clone + patch + entry-point detection + substrate simulate, returning
 * the same substrate response shape the local runner produces. Returns
 * null for recoverable worker failures (no_recording, no_entry_point,
 * substrate_not_configured) so the caller can fall back to AI. Throws
 * on infrastructure failures (5xx, network, auth) — those are surfaced
 * via the outer catch in compute().
 *
 * Contract with the worker handler:
 *   - 200 → WhatIfResponse (substrate result shape)
 *   - 4xx with code in FALLBACK_CODES → null (AI fallback)
 *   - 4xx with other code → throw (caller decides; real bug)
 *   - 5xx → throw (infra issue; AI fallback via outer catch)
 */
async function tryComputeViaWorker(input: WhatIfInput): Promise<Omit<WhatIfResult, "fromCache"> | null> {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!workerUrl || !secret || !input.remediationId || !input.githubToken) return null;

  // 120s matches the worker's internal budget (clone 30s + detect 1s +
  // substrate 90s). A lower timeout would abort legitimate replays; a
  // higher one delays the AI fallback users are waiting for.
  const res = await fetch(`${workerUrl}/worker/whatif`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: input.sessionId,
      remediationId: input.remediationId,
      githubToken: input.githubToken,
    }),
    signal: AbortSignal.timeout(130_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ code: "unknown", error: `HTTP ${res.status}` })) as {
      code?: string; error?: string;
    };
    // Codes the worker returns when the inputs aren't there — AI can
    // handle these. Anything else (auth, 5xx) surfaces as a thrown error
    // so we don't silently lose signal.
    const FALLBACK_CODES = new Set([
      "no_recording",
      "no_entry_point",
      "no_fix_commit",
      "substrate_not_configured",
      "substrate_timeout",
      "substrate_failed",
      "clone_failed",
      "remediation_not_found",
    ]);
    if (err.code && FALLBACK_CODES.has(err.code)) return null;
    throw new Error(`worker/whatif ${res.status}: ${err.error ?? "unknown"}`);
  }

  const data = await res.json() as {
    matched: boolean;
    eventCountBefore: number;
    eventCountAfter: number;
    riskScore: number;
    riskLevel: "low" | "medium" | "high" | "critical";
    blastRadius: {
      httpPaths: string[];
      dbTables: string[];
      filePaths: string[];
      totalSurfaces: number;
    };
    recommendations: string[];
    detectedCommand: string;
    commandSource: string;
  };

  return {
    outcome: substrateOutcome(data.matched, data.riskLevel),
    confidence: data.matched ? 95 : 70,
    riskScore: data.riskScore,
    analysis: data.recommendations[0] ?? (data.matched
      ? `Substrate replay matched the original I/O sequence (command: ${data.detectedCommand}) — fix preserves recorded behavior.`
      : `Substrate replay diverged from the original (command: ${data.detectedCommand}, source: ${data.commandSource}) — see blast radius for affected surfaces.`),
    mode: "substrate_replay",
    computedAt: new Date().toISOString(),
    substrate: {
      matched: data.matched,
      eventCountBefore: data.eventCountBefore,
      eventCountAfter: data.eventCountAfter,
      riskLevel: data.riskLevel,
      blastRadius: data.blastRadius,
      recommendations: data.recommendations,
    },
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
