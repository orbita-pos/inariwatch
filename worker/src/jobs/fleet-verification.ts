/**
 * Fleet Verification Job — VAR Gate 12 ("What-If Across Fleet").
 *
 * Runs a single What-If replay against up to N sessions that share the
 * alert's fingerprint. Produces aggregate pass/fail counts the web UI
 * uses to render the Fleet Verification card and the auto-merge gate
 * reads to decide whether to auto-merge.
 *
 * Runs on the `low` BullMQ queue (concurrency 3, limiter 30/min) and
 * uses runWhatIf() directly — no HTTP round-trip to /worker/whatif.
 *
 * Concurrency inside one run is capped at WHATIF_CONCURRENCY (=2) so
 * the combined load on the Hetzner box stays bounded. The endpoint's
 * MAX_WHATIF_CONCURRENT=2 covers simultaneous fleet jobs or mixed
 * single/fleet callers; this internal cap covers the serial-vs-parallel
 * choice inside ONE fleet run.
 *
 * Flow:
 *   1. Look up the run row that the web API already inserted
 *   2. Query top N sessions sharing the fingerprint (recency-ordered,
 *      must have a substrate_recording + a resolvable session_id)
 *   3. For each session, runWhatIf({ sessionId, remediationId, token })
 *   4. After each finishes, update the run row's counters in place
 *   5. Flip status to 'completed' on the last one
 *
 * Failure model: one session's error doesn't abort the run. We record
 * its error code in session_results and bump count_errored. The whole
 * run only fails if the initial DB lookups throw.
 */

import { eq, and, desc, isNotNull, inArray, sql as dsql } from "drizzle-orm";
import {
  db,
  alerts,
  remediationSessions,
  replaySessions,
  substrateRecordings,
  fleetVerificationRuns,
  whatifReplays,
} from "../db.js";
import { runWhatIf } from "../whatif/handler.js";

/** How many parallel What-If runs inside ONE fleet job. Matches the
 *  endpoint's MAX_WHATIF_CONCURRENT so we don't queue inside ourselves. */
const WHATIF_CONCURRENCY = Number(process.env.FLEET_WHATIF_CONCURRENCY ?? 2);

/** Max sessions per fleet run. More = slower, cheaper per-session signal.
 *  100 is the sweet spot for marketing narrative ("protects 90+ of 100")
 *  without multi-hour wall time. Overridable per workspace in a future
 *  pass — for now every workspace gets the same cap. */
const DEFAULT_MAX_SESSIONS = 100;

// ── Types ──────────────────────────────────────────────────────────────────

export interface FleetJobInput {
  runId: string;
  githubToken?: string;
}

interface SessionResult {
  sessionId: string;
  outcome: "matched" | "uncertain" | "would_not_prevent" | "errored";
  riskScore?: number;
  errorCode?: string;
  durationMs: number;
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function runFleetVerification({ runId, githubToken }: FleetJobInput): Promise<void> {
  const [run] = await db
    .select({
      id: fleetVerificationRuns.id,
      alertId: fleetVerificationRuns.alertId,
      remediationId: fleetVerificationRuns.remediationId,
      fixCommitSha: fleetVerificationRuns.fixCommitSha,
      fingerprint: fleetVerificationRuns.fingerprint,
      status: fleetVerificationRuns.status,
    })
    .from(fleetVerificationRuns)
    .where(eq(fleetVerificationRuns.id, runId))
    .limit(1);

  if (!run) {
    console.warn(`[fleet-verification] run ${runId} not found — skipping`);
    return;
  }
  if (run.status !== "running") {
    // The web API sets status='running' before enqueue. A 'completed'
    // row here means a duplicate job fired (BullMQ retries, double-click
    // on the UI, etc). Skip cleanly — the existing row is authoritative.
    console.log(`[fleet-verification] ${runId} already ${run.status}, skipping`);
    return;
  }

  const [alert] = await db
    .select({ projectId: alerts.projectId, sessionId: alerts.sessionId })
    .from(alerts)
    .where(eq(alerts.id, run.alertId))
    .limit(1);

  if (!alert) {
    await failRun(runId, "alert-not-found");
    return;
  }

  // Pick the candidate sessions.
  const candidates = await pickCandidateSessions({
    projectId: alert.projectId,
    fingerprint: run.fingerprint,
    excludeSessionId: alert.sessionId,
    limit: DEFAULT_MAX_SESSIONS,
  });

  if (candidates.length === 0) {
    // No siblings to verify. Mark completed with zero counts — the UI
    // handles this as "single-session-only fix" rather than an error.
    await db
      .update(fleetVerificationRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        sessionsTotal: 0,
      })
      .where(eq(fleetVerificationRuns.id, runId));
    console.log(`[fleet-verification] ${runId}: no candidate sessions (singleton alert)`);
    return;
  }

  // Refresh the total in case the initial estimate was stale.
  await db
    .update(fleetVerificationRuns)
    .set({ sessionsTotal: candidates.length })
    .where(eq(fleetVerificationRuns.id, runId));

  const counters = { matched: 0, uncertain: 0, wouldNotPrevent: 0, errored: 0 };
  const results: SessionResult[] = [];

  // Process with bounded concurrency. Using a simple rolling-window
  // pattern — no external dep needed.
  await runWithConcurrency(candidates, WHATIF_CONCURRENCY, async (sessionId) => {
    const started = Date.now();
    let sessionResult: SessionResult;

    try {
      // Cache short-circuit. Fleet verification frequently runs against
      // sessions that already had an individual What-If computed (a user
      // clicked "Run What-If" on that session earlier). Re-running would
      // reproduce the same outcome — deterministic replay — so we
      // consult whatif_replays before spending a clone + substrate cycle.
      const cached = await readWhatIfCache(sessionId, run.fixCommitSha);
      if (cached) {
        const durationMs = Date.now() - started;
        const classified = classifyOutcome(cached);
        counters[classified]++;
        sessionResult = {
          sessionId,
          outcome: classified === "wouldNotPrevent" ? "would_not_prevent" : classified,
          riskScore: cached.riskScore,
          durationMs,
        };
      } else {
        const outcome = await runWhatIf({
          sessionId,
          remediationId: run.remediationId,
          githubToken,
        });
        const durationMs = Date.now() - started;

        if (outcome.ok) {
          const classified = classifyOutcome(outcome.result);
          counters[classified]++;
          sessionResult = {
            sessionId,
            outcome: classified === "wouldNotPrevent" ? "would_not_prevent" : classified,
            riskScore: outcome.result.riskScore,
            durationMs,
          };
        } else {
          counters.errored++;
          sessionResult = {
            sessionId,
            outcome: "errored",
            errorCode: outcome.error.code,
            durationMs,
          };
        }
      }
    } catch (err) {
      counters.errored++;
      sessionResult = {
        sessionId,
        outcome: "errored",
        errorCode: err instanceof Error ? err.message.slice(0, 120) : "unknown",
        durationMs: Date.now() - started,
      };
    }

    results.push(sessionResult);

    // Persist progress AFTER each session — the UI polls this during the
    // run. Using a JSONB append (jsonb_build_array || existing) avoids
    // re-sending the entire array on every update which would be O(N²).
    await db
      .update(fleetVerificationRuns)
      .set({
        sessionsAttempted: results.length,
        countMatched: counters.matched,
        countUncertain: counters.uncertain,
        countWouldNotPrevent: counters.wouldNotPrevent,
        countErrored: counters.errored,
        sessionResults: dsql`session_results || ${JSON.stringify([sessionResult])}::jsonb`,
      })
      .where(eq(fleetVerificationRuns.id, runId));
  });

  await db
    .update(fleetVerificationRuns)
    .set({
      status: "completed",
      completedAt: new Date(),
    })
    .where(eq(fleetVerificationRuns.id, runId));

  console.log(
    `[fleet-verification] ${runId}: done ${counters.matched}/${candidates.length} matched, ${counters.errored} errored`,
  );
}

/**
 * Fast path: pull a cached What-If result for this (session, fix) pair.
 * Returns null on miss, on any DB error (we'd rather lose the cache
 * optimization than fail the whole fleet run), or when the stored
 * result isn't a substrate_replay shape. The shape narrowing is
 * intentional — we only short-circuit when we have the exact fields
 * classifyOutcome() reads. AI-analysis cache rows also live in this
 * table but don't expose `riskLevel`, so they don't apply here.
 */
async function readWhatIfCache(
  sessionId: string,
  fixCommitSha: string,
): Promise<{ matched: boolean; riskLevel: "low" | "medium" | "high" | "critical"; riskScore: number } | null> {
  try {
    const [row] = await db
      .select({ result: whatifReplays.result })
      .from(whatifReplays)
      .where(
        and(
          eq(whatifReplays.sessionId, sessionId),
          eq(whatifReplays.fixCommitSha, fixCommitSha),
          eq(whatifReplays.status, "ready"),
        ),
      )
      .limit(1);

    if (!row) return null;
    const stored = row.result as { mode?: string; substrate?: { matched?: boolean; riskLevel?: string }; riskScore?: number };
    if (stored.mode !== "substrate_replay") return null;
    const s = stored.substrate;
    if (!s || typeof s.matched !== "boolean") return null;
    const riskLevel = s.riskLevel as "low" | "medium" | "high" | "critical" | undefined;
    if (!riskLevel || !["low", "medium", "high", "critical"].includes(riskLevel)) return null;
    return {
      matched: s.matched,
      riskLevel,
      riskScore: typeof stored.riskScore === "number" ? stored.riskScore : 0,
    };
  } catch {
    return null;
  }
}

async function failRun(runId: string, reason: string): Promise<void> {
  await db
    .update(fleetVerificationRuns)
    .set({ status: "failed", completedAt: new Date(), error: reason })
    .where(eq(fleetVerificationRuns.id, runId));
  console.error(`[fleet-verification] ${runId} failed: ${reason}`);
}

// ── Candidate picking ─────────────────────────────────────────────────────

interface PickInput {
  projectId: string;
  fingerprint: string;
  excludeSessionId: string | null;
  limit: number;
}

async function pickCandidateSessions({
  projectId,
  fingerprint,
  excludeSessionId,
  limit,
}: PickInput): Promise<string[]> {
  // Why replay_sessions instead of alerts: the alerts table has a partial
  // UNIQUE(project_id, fingerprint) dedup index, so 1 fingerprint = 1
  // alert row. The "same error across many sessions" signal actually
  // lives in `replay_sessions.error_fingerprints` — a text[] column
  // where /api/replay/ingest pushes each fingerprint seen during that
  // session. That's the authoritative source for fleet verification.
  //
  // Step 1: collect replay sessions whose error_fingerprints contains
  //   our fingerprint, scoped to the project, recency-ordered.
  // Step 2: keep only session_ids that actually have a substrate_recording
  //   (otherwise What-If would no_recording — wasted worker time).

  const relatedSessions = await db
    .select({
      sessionId: replaySessions.sessionId,
    })
    .from(replaySessions)
    .where(
      and(
        eq(replaySessions.projectId, projectId),
        dsql`${replaySessions.errorFingerprints} @> ARRAY[${fingerprint}]::text[]`,
      ),
    )
    .orderBy(desc(replaySessions.startedAt))
    .limit(limit * 2);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const row of relatedSessions) {
    if (!row.sessionId) continue;
    if (row.sessionId === excludeSessionId) continue;
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    unique.push(row.sessionId);
    if (unique.length >= limit) break;
  }

  if (unique.length === 0) return [];

  // Filter to sessions that actually have a substrate_recording.
  const withRecording = await db
    .select({ sessionId: substrateRecordings.sessionId })
    .from(substrateRecordings)
    .where(
      and(
        inArray(substrateRecordings.sessionId, unique),
        isNotNull(substrateRecordings.sessionId),
      ),
    );

  const recordable = new Set(
    withRecording.map((r) => r.sessionId).filter((s): s is string => !!s),
  );
  return unique.filter((s) => recordable.has(s));
}

// ── Internals ─────────────────────────────────────────────────────────────

type OutcomeCategory = "matched" | "uncertain" | "wouldNotPrevent";

function classifyOutcome(result: { matched: boolean; riskLevel: "low" | "medium" | "high" | "critical" }): OutcomeCategory {
  if (result.matched && (result.riskLevel === "low" || result.riskLevel === "medium")) {
    return "matched";
  }
  if (!result.matched && result.riskLevel === "critical") {
    return "wouldNotPrevent";
  }
  return "uncertain";
}

/**
 * Rolling-window concurrency without a dep. Kicks off up to `limit`
 * workers in parallel; each picks the next item off the queue as it
 * finishes. Returns when all items are processed.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const next = async (): Promise<void> => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  };
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
}
