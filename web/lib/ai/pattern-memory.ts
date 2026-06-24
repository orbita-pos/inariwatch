/**
 * Pattern Memory — per-project (error_fingerprint → successful fix) index.
 *
 * Schema SSOT: `web/lib/db/migrations/0069_telemetry_foundation.sql:152-208`
 * (table `pattern_memory`, HNSW cosine index, UNIQUE(project_id, error_fingerprint)).
 * Fase 6 only adds the service layer — no new migration.
 *
 * Flag model:
 *   PATTERN_MEMORY_READ_ENABLED  (default: false) — gates `lookupPattern`.
 *   PATTERN_MEMORY_WRITE_ENABLED (default: true)  — gates `writePattern`.
 *   PATTERN_MEMORY_KILL_SWITCH   (default: unset) — emergency read-disable.
 *
 * Circuit breaker: if read latency exceeds 500ms more than 5 times in the
 * last 60s, reads short-circuit to [] for the next 60s. In-memory counter
 * scoped to the current Vercel/Node instance — not Redis-backed because a
 * cold-start reset is an acceptable failure mode here (pattern reads are
 * a perf optimization, not correctness).
 *
 * All DB failures are non-throwing: `lookupPattern` returns [], `writePattern`
 * returns `{ action: 'skipped', reason: ... }`. The caller (remediate.ts)
 * must always be safe to proceed without pattern memory.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { Alert, RemediationSession } from "@/lib/db/schema";
import { aiUsageLogs } from "@/lib/db/schema";
import { embedQuery, LOCAL_EMBED_KEY } from "@/lib/code-intelligence/embeddings";
import { getRedis } from "@/lib/redis";

// ── Flag helpers ────────────────────────────────────────────────────────────

function readEnabled(): boolean {
  if (process.env.PATTERN_MEMORY_KILL_SWITCH === "true") return false;
  return process.env.PATTERN_MEMORY_READ_ENABLED === "true";
}
function writeEnabled(): boolean {
  // Default ON — pattern accumulation is cheap and wanted from day 1.
  return process.env.PATTERN_MEMORY_WRITE_ENABLED !== "false";
}

// ── Types + guards (codebase convention is hand-rolled validation; zod is
//    not a dep, so we keep it that way for one service file) ────────────────

export type PatternMatch = {
  patternId: string;
  score: number;               // cosine similarity ∈ [0, 1]
  fixStrategy: string | null;
  filesTouched: string[];
  successCount: number;
  confidence: number | null;
  postMergeHealth: number | null;
  fromCommunity: false;
};

export type LookupOptions = {
  projectId: string;
  limit?: number;
  minScore?: number;
  includeDisabled?: boolean;
};

type LookupOptionsResolved = Required<LookupOptions>;

export type WriteOutcome = {
  postMergeHealthScore: number;
  fixStrategy?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function resolveLookupOptions(opts: LookupOptions): LookupOptionsResolved {
  if (!UUID_RE.test(opts.projectId)) {
    throw new TypeError(`lookupPattern: projectId is not a valid UUID`);
  }
  return {
    projectId: opts.projectId,
    limit: Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10))),
    minScore: clamp01(opts.minScore ?? 0.88),
    includeDisabled: opts.includeDisabled ?? false,
  };
}

export type WriteResult =
  | { action: "inserted"; patternId: string }
  | { action: "updated"; patternId: string; newSuccessCount: number }
  | {
      action: "skipped";
      reason:
        | "flag_off"
        | "health_below_threshold"
        | "no_fingerprint"
        | "no_project"
        | "circuit_open"
        | "pattern_disabled"
        | "embedding_failed"
        | "db_error";
    };

export type DisableReason =
  | "three_consecutive_fails"
  | "critical_regression"
  | "manual";

// Input alert shape — validates against the real Alert columns
// (title, body, sourceIntegrations, fingerprint). No `stack` column in
// the schema — stack traces are embedded in `body` by convention.
export type PatternInputAlert = Pick<
  Alert,
  "id" | "title" | "body" | "fingerprint" | "sourceIntegrations"
>;

export type PatternInputSession = Pick<
  RemediationSession,
  | "id"
  | "projectId"
  | "alertId"
  | "userId"
  | "fingerprint"
  | "fileChanges"
  | "confidenceScore"
  | "context"
>;

// ── Constants ───────────────────────────────────────────────────────────────

const WRITE_HEALTH_THRESHOLD = 0.9;
const READ_LATENCY_SLO_MS = 500;
const CIRCUIT_OPEN_WINDOW_MS = 60_000;
const CIRCUIT_TRIP_COUNT = 5;
const DECAY_IDLE_WEEKS_FLOOR = 12;
const DECAY_MIN_CONFIDENCE = 0.1;
const DISABLE_FAIL_TTL_DAYS = 30;

// ── Circuit breaker (in-process) ────────────────────────────────────────────

type SlowSample = { at: number };
let slowReads: SlowSample[] = [];
let circuitOpenUntil = 0;

function noteSlowRead(): void {
  const now = Date.now();
  slowReads = slowReads.filter((s) => now - s.at <= CIRCUIT_OPEN_WINDOW_MS);
  slowReads.push({ at: now });
  if (slowReads.length >= CIRCUIT_TRIP_COUNT) {
    circuitOpenUntil = now + CIRCUIT_OPEN_WINDOW_MS;
    slowReads = [];
  }
}

function circuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

// Exposed for tests only — clear in-process breaker state.
export function __resetPatternMemoryCircuit(): void {
  slowReads = [];
  circuitOpenUntil = 0;
}

// ── Embedding text (shared between lookup + write) ──────────────────────────

/**
 * Canonical text representation fed to the embedding model. Symmetric between
 * `lookupPattern` (query) and `writePattern` (document) so scores reflect
 * real similarity, not encoding drift.
 *
 * Fields:
 *   integration — gives provider context (e.g. "sentry" biases toward stack
 *                 shape; "capture" toward runtime context).
 *   title       — one-line summary; highest signal token-wise.
 *   body        — stack trace + message; tail-truncated to 4kB so a rare
 *                 huge body doesn't eclipse title/integration weight.
 *   fingerprint — included as a literal so identical fingerprints always
 *                 produce identical queries (exact-match fast path via the
 *                 UNIQUE index before vector distance even runs).
 */
export function buildEmbeddingText(alert: PatternInputAlert): string {
  const integration = (alert.sourceIntegrations ?? [])[0] ?? "unknown";
  const title = alert.title ?? "";
  const body = (alert.body ?? "").slice(0, 4096);
  const fingerprint = alert.fingerprint ?? "none";
  return [
    `[INTEGRATION] ${integration}`,
    `[TITLE] ${title}`,
    `[BODY] ${body}`,
    `[FINGERPRINT] ${fingerprint}`,
  ].join("\n");
}

// ── Embedding key resolver ──────────────────────────────────────────────────

function resolveEmbeddingKey(): string {
  return (
    process.env.VOYAGE_API_KEY ||
    process.env.PLATFORM_AI_KEY ||
    process.env.OPENAI_API_KEY ||
    LOCAL_EMBED_KEY
  );
}

// ── ai_usage_logs helper (non-throwing) ─────────────────────────────────────

type PatternOpPhase =
  | "pattern_lookup"
  | "pattern_write"
  | "pattern_disable"
  | "pattern_disable_conflict";

async function logPatternOp(params: {
  userId: string | null;
  projectId: string | null;
  alertId: string | null;
  remediationSessionId: string | null;
  phase: PatternOpPhase;
  durationMs: number;
  error?: string | null;
  patternId?: string | null;
  score?: number | null;
  matchCount?: number | null;
}): Promise<void> {
  if (!params.userId) return; // aiUsageLogs.userId is NOT NULL — skip silently
  try {
    await db.insert(aiUsageLogs).values({
      userId: params.userId,
      projectId: params.projectId,
      alertId: params.alertId,
      remediationSessionId: params.remediationSessionId,
      feature: "remediation",
      provider: "internal",
      model: "pgvector",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: "0",
      isPlatformKey: true,
      error: params.error ?? null,
      durationMs: params.durationMs,
      phase: params.phase,
      modelTier: "nano",
      // Encode pattern-specific signal into the `response` free-text column
      // so the admin drilldown can render it without a schema change.
      response: JSON.stringify({
        patternId: params.patternId ?? null,
        score: params.score ?? null,
        matchCount: params.matchCount ?? null,
      }),
    });
  } catch {
    // Telemetry must never fail the caller.
  }
}

// ── lookupPattern ───────────────────────────────────────────────────────────

/**
 * kNN search on `pattern_memory.embedding` with cosine distance.
 *
 * Returns [] and skips the DB round-trip when any of:
 *  - `PATTERN_MEMORY_READ_ENABLED=false` or kill switch is set
 *  - circuit breaker is open
 *  - embedding generation fails
 *
 * Never throws. Writes one `ai_usage_logs` row per call with
 * `phase='pattern_lookup'` for observability (latency + matchCount).
 */
export async function lookupPattern(
  alert: PatternInputAlert,
  opts: LookupOptions,
  meta: {
    userId: string | null;
    remediationSessionId: string | null;
  } = { userId: null, remediationSessionId: null },
): Promise<PatternMatch[]> {
  const parsed = resolveLookupOptions(opts);
  const started = Date.now();

  if (!readEnabled()) return [];
  if (circuitOpen()) return [];

  const key = resolveEmbeddingKey();
  const text = buildEmbeddingText(alert);
  const embedding = await embedQuery(text, key);
  if (!embedding) {
    await logPatternOp({
      userId: meta.userId,
      projectId: parsed.projectId,
      alertId: alert.id,
      remediationSessionId: meta.remediationSessionId,
      phase: "pattern_lookup",
      durationMs: Date.now() - started,
      error: "embedding_failed",
      matchCount: 0,
    });
    return [];
  }

  const vec = `[${embedding.join(",")}]`;
  const disabledClause = parsed.includeDisabled
    ? sql.raw("")
    : sql`AND disabled_at IS NULL`;

  let rows: Array<{
    id: string;
    distance: number;
    fix_strategy: string | null;
    files_touched: unknown;
    success_count: number;
    confidence: number | null;
    post_merge_health_score: number | null;
  }> = [];

  try {
    const result = await db.execute<{
      id: string;
      distance: number;
      fix_strategy: string | null;
      files_touched: unknown;
      success_count: number;
      confidence: number | null;
      post_merge_health_score: number | null;
    }>(sql`
      SELECT
        id,
        (embedding <=> ${vec}::vector) AS distance,
        fix_strategy,
        files_touched,
        success_count,
        confidence,
        post_merge_health_score
      FROM pattern_memory
      WHERE project_id = ${parsed.projectId}::uuid
        AND embedding IS NOT NULL
        ${disabledClause}
      ORDER BY distance ASC
      LIMIT ${parsed.limit}
    `);
    rows = Array.isArray(result) ? result : (result as { rows?: typeof rows }).rows ?? [];
  } catch {
    // DB failure — degrade silently.
    const elapsed = Date.now() - started;
    if (elapsed > READ_LATENCY_SLO_MS) noteSlowRead();
    await logPatternOp({
      userId: meta.userId,
      projectId: parsed.projectId,
      alertId: alert.id,
      remediationSessionId: meta.remediationSessionId,
      phase: "pattern_lookup",
      durationMs: elapsed,
      error: "db_error",
      matchCount: 0,
    });
    return [];
  }

  const elapsed = Date.now() - started;
  if (elapsed > READ_LATENCY_SLO_MS) noteSlowRead();

  // pgvector cosine distance is in [0, 2]. Convert to similarity in [0, 1].
  const matches: PatternMatch[] = [];
  for (const r of rows) {
    const score = Math.max(0, Math.min(1, 1 - r.distance / 2));
    if (score < parsed.minScore) continue;
    const files = Array.isArray(r.files_touched) ? (r.files_touched as string[]) : [];
    matches.push({
      patternId: r.id,
      score,
      fixStrategy: r.fix_strategy,
      filesTouched: files,
      successCount: r.success_count,
      confidence: r.confidence,
      postMergeHealth: r.post_merge_health_score,
      fromCommunity: false,
    });
  }

  await logPatternOp({
    userId: meta.userId,
    projectId: parsed.projectId,
    alertId: alert.id,
    remediationSessionId: meta.remediationSessionId,
    phase: "pattern_lookup",
    durationMs: elapsed,
    matchCount: matches.length,
    score: matches[0]?.score ?? null,
  });

  return matches;
}

// ── writePattern ────────────────────────────────────────────────────────────

type ExistingPattern = {
  id: string;
  success_count: number;
  post_merge_health_score: number | null;
  disabled_at: Date | string | null;
};

/**
 * Idempotent upsert. On conflict against UNIQUE(project_id, error_fingerprint):
 *   - if existing row is disabled → returns { action: 'skipped', reason: 'pattern_disabled' }
 *     and logs `phase='pattern_disable_conflict'` for operator visibility.
 *     No auto-revive: disabled patterns stay disabled until manual re-enable.
 *   - otherwise → increments success_count, updates last_used_at = now(),
 *     updates post_merge_health_score = greatest(old, new), updates
 *     updated_at = now().
 */
export async function writePattern(
  session: PatternInputSession,
  outcome: WriteOutcome,
): Promise<WriteResult> {
  if (!writeEnabled()) return { action: "skipped", reason: "flag_off" };

  // Defensive: outcome.postMergeHealthScore must be a number ∈ [0, 1] or the
  // caller has a bug (post-merge-monitor is the only call site). Clamp and
  // pass-through so we don't silently drop writes on floating-point noise.
  const healthClamped = clamp01(outcome.postMergeHealthScore);
  if (healthClamped < WRITE_HEALTH_THRESHOLD) {
    return { action: "skipped", reason: "health_below_threshold" };
  }
  const parsedOutcome: WriteOutcome = {
    postMergeHealthScore: healthClamped,
    fixStrategy: outcome.fixStrategy,
  };
  if (!session.fingerprint) return { action: "skipped", reason: "no_fingerprint" };
  if (!session.projectId) return { action: "skipped", reason: "no_project" };

  const started = Date.now();
  const alert = await loadAlertForEmbedding(session.alertId);
  if (!alert) return { action: "skipped", reason: "no_project" }; // orphan session

  const key = resolveEmbeddingKey();
  const text = buildEmbeddingText(alert);
  const embedding = await embedQuery(text, key);
  if (!embedding) return { action: "skipped", reason: "embedding_failed" };

  const vec = `[${embedding.join(",")}]`;
  const filesTouched = extractFileList(session.fileChanges);
  const confidence = normalizeConfidence(session.confidenceScore);

  try {
    // Probe for an existing row first. Cheaper than running the upsert and
    // parsing RETURNING when we need to branch on `disabled_at`.
    const existingRes = await db.execute<ExistingPattern>(sql`
      SELECT id, success_count, post_merge_health_score, disabled_at
      FROM pattern_memory
      WHERE project_id = ${session.projectId}::uuid
        AND error_fingerprint = ${session.fingerprint}
      LIMIT 1
    `);
    const existingRows = Array.isArray(existingRes)
      ? existingRes
      : ((existingRes as { rows?: ExistingPattern[] }).rows ?? []);
    const existing = existingRows[0];

    if (existing?.disabled_at) {
      await logPatternOp({
        userId: session.userId ?? null,
        projectId: session.projectId,
        alertId: session.alertId,
        remediationSessionId: session.id,
        phase: "pattern_disable_conflict",
        durationMs: Date.now() - started,
        patternId: existing.id,
      });
      return { action: "skipped", reason: "pattern_disabled" };
    }

    if (existing) {
      const newHealth = Math.max(
        existing.post_merge_health_score ?? 0,
        parsedOutcome.postMergeHealthScore,
      );
      const newSuccessCount = existing.success_count + 1;
      await db.execute(sql`
        UPDATE pattern_memory
        SET
          success_count = ${newSuccessCount},
          last_used_at = now(),
          post_merge_health_score = ${newHealth},
          confidence = ${confidence},
          fix_strategy = COALESCE(${parsedOutcome.fixStrategy ?? null}, fix_strategy),
          files_touched = ${JSON.stringify(filesTouched)}::jsonb,
          embedding = ${vec}::vector,
          updated_at = now()
        WHERE id = ${existing.id}::uuid
      `);
      await logPatternOp({
        userId: session.userId ?? null,
        projectId: session.projectId,
        alertId: session.alertId,
        remediationSessionId: session.id,
        phase: "pattern_write",
        durationMs: Date.now() - started,
        patternId: existing.id,
      });
      return { action: "updated", patternId: existing.id, newSuccessCount };
    }

    const insertRes = await db.execute<{ id: string }>(sql`
      INSERT INTO pattern_memory (
        project_id, error_fingerprint, embedding, fix_strategy,
        files_touched, success_count, last_used_at, confidence,
        post_merge_health_score, created_at, updated_at
      ) VALUES (
        ${session.projectId}::uuid,
        ${session.fingerprint},
        ${vec}::vector,
        ${parsedOutcome.fixStrategy ?? null},
        ${JSON.stringify(filesTouched)}::jsonb,
        1,
        now(),
        ${confidence},
        ${parsedOutcome.postMergeHealthScore},
        now(),
        now()
      )
      RETURNING id
    `);
    const inserted = Array.isArray(insertRes)
      ? insertRes[0]
      : ((insertRes as { rows?: { id: string }[] }).rows ?? [])[0];
    const newId = inserted?.id ?? "";

    await logPatternOp({
      userId: session.userId ?? null,
      projectId: session.projectId,
      alertId: session.alertId,
      remediationSessionId: session.id,
      phase: "pattern_write",
      durationMs: Date.now() - started,
      patternId: newId,
    });
    return { action: "inserted", patternId: newId };
  } catch (err) {
    await logPatternOp({
      userId: session.userId ?? null,
      projectId: session.projectId,
      alertId: session.alertId,
      remediationSessionId: session.id,
      phase: "pattern_write",
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : "unknown",
    });
    return { action: "skipped", reason: "db_error" };
  }
}

// ── decayPattern ────────────────────────────────────────────────────────────

/**
 * Exponential decay: confidence *= 0.9^(weeksIdle - 12), floored at 0.1.
 * Idempotent — running twice the same week produces the same result (we
 * compute from last_used_at, not the previous decay run).
 *
 * Returns the before/after confidence + weeksIdle so the weekly cron
 * (Fase 9) can log aggregate decay effectiveness.
 */
export async function decayPattern(
  patternId: string,
): Promise<{ oldConfidence: number; newConfidence: number; weeksIdle: number }> {
  const res = await db.execute<{
    confidence: number | null;
    last_used_at: Date | string | null;
  }>(sql`
    SELECT confidence, last_used_at
    FROM pattern_memory
    WHERE id = ${patternId}::uuid
    LIMIT 1
  `);
  const rows = Array.isArray(res)
    ? res
    : ((res as { rows?: Array<{ confidence: number | null; last_used_at: Date | string | null }> }).rows ?? []);
  const row = rows[0];
  if (!row || row.confidence === null || !row.last_used_at) {
    return { oldConfidence: row?.confidence ?? 0, newConfidence: row?.confidence ?? 0, weeksIdle: 0 };
  }

  const lastUsedMs = new Date(row.last_used_at).getTime();
  const weeksIdle = Math.max(
    0,
    Math.floor((Date.now() - lastUsedMs) / (7 * 24 * 60 * 60 * 1000)),
  );
  if (weeksIdle <= DECAY_IDLE_WEEKS_FLOOR) {
    return { oldConfidence: row.confidence, newConfidence: row.confidence, weeksIdle };
  }

  const decayed = row.confidence * Math.pow(0.9, weeksIdle - DECAY_IDLE_WEEKS_FLOOR);
  const newConfidence = Math.max(DECAY_MIN_CONFIDENCE, decayed);
  if (newConfidence === row.confidence) {
    return { oldConfidence: row.confidence, newConfidence, weeksIdle };
  }

  await db.execute(sql`
    UPDATE pattern_memory
    SET confidence = ${newConfidence}, updated_at = now()
    WHERE id = ${patternId}::uuid
  `);
  return { oldConfidence: row.confidence, newConfidence, weeksIdle };
}

// ── disablePattern ──────────────────────────────────────────────────────────

/**
 * Sets `disabled_at = now()` with the reason recorded in `ai_usage_logs`.
 * Idempotent — if already disabled, returns { disabled: false, alreadyDisabled: true }.
 *
 * Counter integration: `escalation-engine.ts` increments
 * `pattern:fail:{id}` in Redis on each post-merge regression attributed to
 * this pattern (TTL 30d). On reaching 3, it calls this function with
 * reason='three_consecutive_fails'. A single critical regression fires
 * immediately with reason='critical_regression'.
 */
export async function disablePattern(
  patternId: string,
  reason: DisableReason,
): Promise<{ disabled: boolean; alreadyDisabled: boolean }> {
  const res = await db.execute<{ disabled_at: Date | string | null }>(sql`
    SELECT disabled_at FROM pattern_memory WHERE id = ${patternId}::uuid LIMIT 1
  `);
  const rows = Array.isArray(res)
    ? res
    : ((res as { rows?: Array<{ disabled_at: Date | string | null }> }).rows ?? []);
  const existing = rows[0];
  if (!existing) return { disabled: false, alreadyDisabled: false };
  if (existing.disabled_at) return { disabled: false, alreadyDisabled: true };

  await db.execute(sql`
    UPDATE pattern_memory
    SET disabled_at = now(), updated_at = now()
    WHERE id = ${patternId}::uuid
  `);

  // Best-effort Redis cleanup of the failure counter.
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`pattern:fail:${patternId}`);
    } catch {
      // ignore
    }
  }

  await logPatternOp({
    userId: null,
    projectId: null,
    alertId: null,
    remediationSessionId: null,
    phase: "pattern_disable",
    durationMs: 0,
    patternId,
    error: reason,
  });

  return { disabled: true, alreadyDisabled: false };
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function loadAlertForEmbedding(
  alertId: string,
): Promise<PatternInputAlert | null> {
  try {
    const res = await db.execute<PatternInputAlert>(sql`
      SELECT id, title, body, fingerprint, source_integrations AS "sourceIntegrations"
      FROM alerts
      WHERE id = ${alertId}::uuid
      LIMIT 1
    `);
    const rows = Array.isArray(res)
      ? res
      : ((res as { rows?: PatternInputAlert[] }).rows ?? []);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function extractFileList(fileChanges: unknown): string[] {
  if (!Array.isArray(fileChanges)) return [];
  const out: string[] = [];
  for (const fc of fileChanges) {
    if (fc && typeof fc === "object" && "path" in fc && typeof (fc as { path: unknown }).path === "string") {
      out.push((fc as { path: string }).path);
    }
  }
  return out;
}

function normalizeConfidence(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isFinite(raw)) return null;
  // confidence_score in remediation_sessions is a 0-100 integer. pattern_memory
  // expects [0, 1]. Normalize — clamping to handle legacy rows that saved 0-1.
  const v = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, v));
}

// Internal — exported only for the 30d TTL constant in escalation-engine.ts.
export const PATTERN_FAIL_TTL_SECONDS = DISABLE_FAIL_TTL_DAYS * 24 * 60 * 60;

// ── recordPatternRegression ─────────────────────────────────────────────────

/**
 * Called from `escalation-engine.triggerEscalation` when a post-merge
 * regression fires. Fase 6: future-ready no-op — nothing sets
 * `checkpointData.patternIdUsed` yet (Tier 0 handler is stubbed). Once the
 * Tier 0 handler ships in Fase 6.1 and writes that field on direct-apply,
 * this function starts doing work automatically without a code change.
 *
 * Behavior once active:
 *   - Look up the most-recent `remediation_sessions` for this alert that
 *     carries `checkpointData.patternIdUsed`.
 *   - If severity is 'critical' → disablePattern(patternId, 'critical_regression').
 *   - Otherwise → INCR `pattern:fail:{patternId}` (TTL 30d). On reaching 3,
 *     disablePattern(patternId, 'three_consecutive_fails').
 *
 * Never throws. All failures swallow silently — escalation must proceed.
 */
export async function recordPatternRegression(
  alertId: string,
  severity: string,
): Promise<void> {
  try {
    const res = await db.execute<{ checkpoint_data: unknown }>(sql`
      SELECT checkpoint_data
      FROM remediation_sessions
      WHERE alert_id = ${alertId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const rows = Array.isArray(res)
      ? res
      : ((res as { rows?: Array<{ checkpoint_data: unknown }> }).rows ?? []);
    const cp = rows[0]?.checkpoint_data;
    if (!cp || typeof cp !== "object") return;
    const patternId = (cp as Record<string, unknown>).patternIdUsed;
    if (typeof patternId !== "string" || !UUID_RE.test(patternId)) return;

    const isCritical = String(severity).toLowerCase() === "critical";
    if (isCritical) {
      await disablePattern(patternId, "critical_regression");
      return;
    }

    const redis = getRedis();
    if (!redis) return; // no counter available — fall back to next regression
    const key = `pattern:fail:${patternId}`;
    const count = await redis.incr(key);
    await redis.expire(key, PATTERN_FAIL_TTL_SECONDS);
    if (count >= 3) {
      await disablePattern(patternId, "three_consecutive_fails");
    }
  } catch {
    // best-effort only
  }
}
