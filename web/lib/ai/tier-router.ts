/**
 * Tier Router — classifies each remediation into Tier 0/1/2/3.
 *
 * ```
 *   Tier 0 → direct pattern_memory apply, no LLM
 *   Tier 1 → single-shot gpt-5-nano with category-specialized template
 *   Tier 2 → current single-shot gpt-5.4 (Fase 3 production path)
 *   Tier 3 → multi-agent fan-out (Fase 7)
 * ```
 *
 * Fase 6 ships the classifier + persistence only. Actual routing
 * (dispatching to Tier 0 or Tier 1 handlers) is gated behind
 * `TIER_ROUTER_MODE='live'`, which is NOT flipped in this phase —
 * see `docs/tier-router-rollout.md` for the promotion playbook.
 *
 * Flag states:
 *   'off'    → routeTier returns null; zero LLM calls; pipeline byte-identical.
 *   'shadow' → classifier runs; tier_used + pattern_match_score are persisted
 *              to remediation_sessions; caller MUST ignore returned tier and
 *              keep the existing single-shot path.
 *   'live'   → caller may dispatch based on returned tier. Reserved for Fase 6.1.
 *
 * Safety:
 *   - Classifier errors / malformed output → fall through to heuristic rules.
 *   - Heuristic latency is ~0ms (pure function over features).
 *   - Circuit breaker: 3 classifier errors in 60s → shadow skips the LLM call
 *     and uses heuristic only for 60s. Distinct from pattern-memory's breaker.
 */

import { sql } from "drizzle-orm";
import { db, remediationSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import { callAI } from "./client";
import { resolveModelForPhase } from "./models";
import { lookupPattern, type PatternMatch, type PatternInputAlert } from "./pattern-memory";

// ── Flag ────────────────────────────────────────────────────────────────────

export type TierRouterMode = "off" | "shadow" | "live";

export function getTierRouterMode(): TierRouterMode {
  const v = process.env.TIER_ROUTER_MODE;
  if (v === "shadow" || v === "live") return v;
  return "off";
}

// ── Public types ────────────────────────────────────────────────────────────

export type Tier = 0 | 1 | 2 | 3;

export type ErrorCategory =
  | "TypeError"
  | "ReferenceError"
  | "Runtime"
  | "Network"
  | "DB"
  | "Auth"
  | "Other";

export type RouterFeatures = {
  errorCategory: ErrorCategory;
  severity: "low" | "medium" | "high" | "critical";
  stackDepth: number;
  stackTopFrameUserCode: boolean;
  affectedFileCount: number;
  patternMatchScore: number;        // best match ∈ [0,1]; 0 if no match
  patternMatchSuccessCount: number; // success_count of best match; 0 if none
  patternMatchHealth: number;       // post_merge_health_score of best; 0 if none
  hasSubstrateRecording: boolean;
  hasCaptureBreadcrumbs: boolean;
  hasGitContext: boolean;
  priorRemediationsForFingerprint: number;
};

export type ClassificationResult = {
  tier: Tier;
  reason: string;
  confidence: number;       // [0, 1]; self-reported by model or derived by heuristic
  usedFallback: boolean;    // true when heuristic rules produced the answer
  latencyMs: number;
  featuresSnapshot: RouterFeatures;
};

// ── Constants ───────────────────────────────────────────────────────────────

const LOW_CONFIDENCE_THRESHOLD = 0.6;
const TIER_0_PROMOTION_CONFIDENCE = 0.92;
const TIER_0_PROMOTION_SUCCESS_COUNT = 3;
const TIER_0_PROMOTION_HEALTH = 0.95;
const CLASSIFIER_TIMEOUT_MS = 8_000;
const CIRCUIT_TRIP_COUNT = 3;
const CIRCUIT_OPEN_WINDOW_MS = 60_000;

// ── Circuit breaker ─────────────────────────────────────────────────────────

type ErrSample = { at: number };
let recentErrors: ErrSample[] = [];
let circuitOpenUntil = 0;

function noteClassifierError(): void {
  const now = Date.now();
  recentErrors = recentErrors.filter((e) => now - e.at <= CIRCUIT_OPEN_WINDOW_MS);
  recentErrors.push({ at: now });
  if (recentErrors.length >= CIRCUIT_TRIP_COUNT) {
    circuitOpenUntil = now + CIRCUIT_OPEN_WINDOW_MS;
    recentErrors = [];
  }
}

function circuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

export function __resetTierRouterCircuit(): void {
  recentErrors = [];
  circuitOpenUntil = 0;
}

// ── Feature extraction ──────────────────────────────────────────────────────

type AlertRow = {
  id: string;
  title: string;
  body: string;
  severity: string;
  fingerprint: string | null;
  source_integrations: string[] | null;
  session_id: string | null;
};

type SessionRow = {
  id: string;
  project_id: string;
  alert_id: string;
  context: unknown;
  repo: string | null;
};

/**
 * Derive a deterministic feature vector. No LLM calls. Shares the
 * pattern_memory lookup result with the caller so tier handlers can reuse it.
 */
export async function extractRouterFeatures(
  alert: Pick<AlertRow, "id" | "title" | "body" | "severity" | "fingerprint" | "source_integrations" | "session_id">,
  patternMatches: PatternMatch[],
  sessionContext: unknown,
  priorRemediationsForFingerprint: number,
): Promise<RouterFeatures> {
  const errorCategory = classifyErrorCategory(alert.title, alert.body);
  const stack = extractStackLines(alert.body);
  const severity = normalizeSeverity(alert.severity);
  const best = patternMatches[0];
  const ctx = (sessionContext && typeof sessionContext === "object"
    ? (sessionContext as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  return {
    errorCategory,
    severity,
    stackDepth: stack.length,
    stackTopFrameUserCode: stack.length > 0 ? isUserCodeFrame(stack[0]) : false,
    affectedFileCount: countAffectedFiles(stack),
    patternMatchScore: best?.score ?? 0,
    patternMatchSuccessCount: best?.successCount ?? 0,
    patternMatchHealth: best?.postMergeHealth ?? 0,
    hasSubstrateRecording: Boolean(ctx.substrateRecordingId ?? ctx.replaySessionId ?? alert.session_id),
    hasCaptureBreadcrumbs: Array.isArray(ctx.breadcrumbs) && (ctx.breadcrumbs as unknown[]).length > 0,
    hasGitContext: Boolean(ctx.git ?? ctx.commitSha ?? ctx.branch),
    priorRemediationsForFingerprint,
  };
}

function classifyErrorCategory(title: string, body: string): ErrorCategory {
  const haystack = `${title}\n${body.slice(0, 2000)}`;
  if (/\bTypeError\b/.test(haystack)) return "TypeError";
  if (/\bReferenceError\b/.test(haystack)) return "ReferenceError";
  if (/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|Network Error)\b/i.test(haystack)) return "Network";
  if (/\b(PostgresError|SQLSTATE|deadlock|relation.*does not exist|duplicate key value|Neon)\b/i.test(haystack)) return "DB";
  if (/\b(401|403|Unauthorized|Forbidden|invalid_token|jwt expired|missing authentication)\b/i.test(haystack)) return "Auth";
  if (/\b(SyntaxError|RangeError|URIError|EvalError)\b/.test(haystack)) return "Runtime";
  return "Other";
}

function normalizeSeverity(s: string): RouterFeatures["severity"] {
  const v = s.toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high" || v === "error") return "high";
  if (v === "medium" || v === "warning" || v === "warn") return "medium";
  return "low";
}

function extractStackLines(body: string): string[] {
  if (!body) return [];
  const lines = body.split("\n");
  const stack: string[] = [];
  for (const line of lines) {
    if (/^\s*at\s+/.test(line)) stack.push(line.trim());
  }
  return stack;
}

function isUserCodeFrame(frame: string): boolean {
  if (/node_modules/.test(frame)) return false;
  if (/react-dom\.production/.test(frame)) return false;
  if (/\.next\/(server|static)\//.test(frame)) return false;
  return /\.(tsx?|jsx?|mjs|cjs)(:|\s|$)/.test(frame);
}

function countAffectedFiles(stack: string[]): number {
  const files = new Set<string>();
  for (const frame of stack) {
    const m = frame.match(/\(([^)]+):\d+:\d+\)|at\s+([^\s(]+\.(?:tsx?|jsx?|mjs|cjs)):\d+:\d+/);
    const candidate = m?.[1] ?? m?.[2];
    if (candidate && !candidate.includes("node_modules")) files.add(candidate);
  }
  return files.size;
}

// ── Classifier (gpt-5-nano) with structured prompt ──────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are the tier router for an autonomous code remediation system.

Given features describing a production error, you decide which tier should attempt the fix:

  Tier 0 — the exact same fix pattern worked before for this project (success_count >= 3, post-merge health >= 0.95, pattern match >= 0.92). Apply the stored patch directly, no LLM reasoning needed.

  Tier 1 — a simple, well-categorized error (null-check, missing import, obvious type error). A cheap single-shot model with a specialized template should handle it.

  Tier 2 — requires reading code, understanding context, generating a non-obvious fix. The default flagship single-shot pipeline (the current production path).

  Tier 3 — complex, multi-file, or needs multiple competing hypotheses. Fan out to multiple sub-agents.

Respond with a single JSON object, nothing else, exactly:

{"tier": 0|1|2|3, "reason": "<=80 chars>", "confidence": 0.0-1.0}

confidence is YOUR certainty in the decision. If you are unsure, pick a lower tier (2) with low confidence rather than risking Tier 0. Never respond with prose, markdown, or code fences.`;

function buildClassifierUserMessage(features: RouterFeatures): string {
  return [
    `error_category: ${features.errorCategory}`,
    `severity: ${features.severity}`,
    `stack_depth: ${features.stackDepth}`,
    `stack_top_user_code: ${features.stackTopFrameUserCode}`,
    `affected_file_count: ${features.affectedFileCount}`,
    `pattern_match_score: ${features.patternMatchScore.toFixed(3)}`,
    `pattern_match_success_count: ${features.patternMatchSuccessCount}`,
    `pattern_match_health: ${features.patternMatchHealth.toFixed(3)}`,
    `has_substrate_recording: ${features.hasSubstrateRecording}`,
    `has_capture_breadcrumbs: ${features.hasCaptureBreadcrumbs}`,
    `has_git_context: ${features.hasGitContext}`,
    `prior_remediations_for_fingerprint: ${features.priorRemediationsForFingerprint}`,
  ].join("\n");
}

/** Parse + validate the classifier's JSON response. Tolerates surrounding
 *  whitespace and ```json fences (in case the model disobeys instructions). */
export function parseClassifierResponse(raw: string): { tier: Tier; reason: string; confidence: number } | null {
  if (!raw) return null;
  let candidate = raw.trim();
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) candidate = fenceMatch[1].trim();
  try {
    const obj = JSON.parse(candidate) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    const tier = o.tier;
    const reason = o.reason;
    const confidence = o.confidence;
    if (tier !== 0 && tier !== 1 && tier !== 2 && tier !== 3) return null;
    if (typeof reason !== "string" || reason.length === 0) return null;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
    const clampedConfidence = Math.max(0, Math.min(1, confidence));
    return {
      tier: tier as Tier,
      reason: reason.slice(0, 200),
      confidence: clampedConfidence,
    };
  } catch {
    return null;
  }
}

/**
 * Invoke gpt-5-nano with the features. Returns null on any failure —
 * caller falls back to the heuristic. Never throws.
 */
export async function classifyTier(
  features: RouterFeatures,
  log: {
    userId: string;
    projectId: string;
    alertId: string;
    remediationSessionId: string;
  },
): Promise<ClassificationResult> {
  const started = Date.now();

  // Circuit open → skip the model, go straight to heuristic.
  if (circuitOpen()) {
    const h = heuristicClassify(features);
    return {
      tier: h.tier,
      reason: `${h.reason} (classifier circuit open)`,
      confidence: h.confidence,
      usedFallback: true,
      latencyMs: Date.now() - started,
      featuresSnapshot: features,
    };
  }

  const apiKey = process.env.PLATFORM_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const h = heuristicClassify(features);
    return {
      tier: h.tier,
      reason: `${h.reason} (no api key)`,
      confidence: h.confidence,
      usedFallback: true,
      latencyMs: Date.now() - started,
      featuresSnapshot: features,
    };
  }

  const model = resolveModelForPhase("classify", "openai");

  let raw: string;
  try {
    raw = await callAI(
      apiKey,
      CLASSIFIER_SYSTEM_PROMPT,
      [{ role: "user", content: buildClassifierUserMessage(features) }],
      {
        model,
        provider: "openai",
        maxTokens: 120,
        timeout: CLASSIFIER_TIMEOUT_MS,
        log: {
          userId: log.userId,
          projectId: log.projectId,
          alertId: log.alertId,
          remediationSessionId: log.remediationSessionId,
          feature: "remediation",
          phase: "classify",
          modelTier: "nano",
          isPlatformKey: true,
        },
      },
    );
  } catch {
    noteClassifierError();
    const h = heuristicClassify(features);
    return {
      tier: h.tier,
      reason: `${h.reason} (classifier error)`,
      confidence: h.confidence,
      usedFallback: true,
      latencyMs: Date.now() - started,
      featuresSnapshot: features,
    };
  }

  const parsed = parseClassifierResponse(raw);
  if (!parsed) {
    noteClassifierError();
    const h = heuristicClassify(features);
    return {
      tier: h.tier,
      reason: `${h.reason} (malformed output)`,
      confidence: h.confidence,
      usedFallback: true,
      latencyMs: Date.now() - started,
      featuresSnapshot: features,
    };
  }

  if (parsed.confidence < LOW_CONFIDENCE_THRESHOLD) {
    const h = heuristicClassify(features);
    return {
      tier: h.tier,
      reason: `${h.reason} (low-conf override: ${parsed.tier})`,
      confidence: h.confidence,
      usedFallback: true,
      latencyMs: Date.now() - started,
      featuresSnapshot: features,
    };
  }

  return {
    tier: parsed.tier,
    reason: parsed.reason,
    confidence: parsed.confidence,
    usedFallback: false,
    latencyMs: Date.now() - started,
    featuresSnapshot: features,
  };
}

// ── Heuristic fallback ──────────────────────────────────────────────────────

/**
 * Deterministic rule-based tier choice used when:
 *   - TIER_ROUTER_MODE='off' (never called in this case — defense-in-depth)
 *   - Classifier errors, times out, or returns malformed output
 *   - Classifier self-reports confidence < 0.6
 *   - Circuit breaker is open
 */
export function heuristicClassify(features: RouterFeatures): {
  tier: Tier;
  reason: string;
  confidence: number;
} {
  // Tier 0: strong pattern match with proven track record.
  if (
    features.patternMatchScore >= TIER_0_PROMOTION_CONFIDENCE &&
    features.patternMatchSuccessCount >= TIER_0_PROMOTION_SUCCESS_COUNT &&
    features.patternMatchHealth >= TIER_0_PROMOTION_HEALTH
  ) {
    return {
      tier: 0,
      reason: "strong pattern match, proven track record",
      confidence: 0.9,
    };
  }

  // Tier 3: complex, needs multi-agent hypothesis space.
  if (
    features.affectedFileCount >= 4 ||
    features.stackDepth >= 25 ||
    features.priorRemediationsForFingerprint >= 3
  ) {
    return {
      tier: 3,
      reason: "multi-file or repeated failure — needs fan-out",
      confidence: 0.75,
    };
  }

  // Tier 1: simple, well-categorized error, no prior tried remediations.
  if (
    (features.errorCategory === "TypeError" || features.errorCategory === "ReferenceError") &&
    features.affectedFileCount <= 1 &&
    features.stackTopFrameUserCode &&
    features.priorRemediationsForFingerprint === 0
  ) {
    return {
      tier: 1,
      reason: "simple categorized error, single-file user code",
      confidence: 0.7,
    };
  }

  // Default: Tier 2 (current production path).
  return {
    tier: 2,
    reason: "default single-shot flagship path",
    confidence: 0.65,
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Called from `remediate.ts` at session start. Returns null when
 * TIER_ROUTER_MODE='off'. Otherwise: runs pattern_memory lookup, extracts
 * features, calls the classifier (with heuristic fallback), persists
 * `tier_used` + `pattern_match_score` to `remediation_sessions`.
 *
 * In 'shadow': caller ignores the returned tier and keeps single-shot.
 * In 'live' (Fase 6.1): caller may dispatch to tier handlers.
 *
 * Never throws. On any unexpected error, persists `tier_used='legacy'` to
 * mark the attempt and returns null so the caller proceeds with single-shot.
 */
export async function routeTier(
  alertId: string,
  sessionId: string,
): Promise<ClassificationResult | null> {
  const mode = getTierRouterMode();
  if (mode === "off") return null;

  try {
    const session = await loadSession(sessionId);
    if (!session) return null;
    const alert = await loadAlert(alertId);
    if (!alert) return null;

    const priorCount = alert.fingerprint
      ? await countPriorRemediations(alert.fingerprint, session.project_id, session.id)
      : 0;

    const patternMatches = alert.fingerprint
      ? await lookupPattern(
          toPatternInputAlert(alert),
          { projectId: session.project_id, limit: 5, minScore: 0.6 },
          { userId: await resolveSessionUserId(sessionId), remediationSessionId: sessionId },
        )
      : [];

    const features = await extractRouterFeatures(
      alert,
      patternMatches,
      session.context,
      priorCount,
    );

    const result = await classifyTier(features, {
      userId: (await resolveSessionUserId(sessionId)) ?? "",
      projectId: session.project_id,
      alertId: alert.id,
      remediationSessionId: sessionId,
    });

    await persistRoute(sessionId, result);
    return result;
  } catch {
    // Best-effort: mark the session as 'legacy' so telemetry can tell this
    // session ran pre-router-wire-up vs. crashed-router.
    try {
      await db
        .update(remediationSessions)
        .set({ tierUsed: "legacy", updatedAt: new Date() })
        .where(eq(remediationSessions.id, sessionId));
    } catch {
      // ignore
    }
    return null;
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function loadAlert(alertId: string): Promise<AlertRow | null> {
  try {
    const res = await db.execute<AlertRow>(sql`
      SELECT id, title, body, severity, fingerprint,
             source_integrations, session_id
      FROM alerts
      WHERE id = ${alertId}::uuid
      LIMIT 1
    `);
    const rows = Array.isArray(res) ? res : ((res as { rows?: AlertRow[] }).rows ?? []);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function loadSession(sessionId: string): Promise<SessionRow | null> {
  try {
    const res = await db.execute<SessionRow>(sql`
      SELECT id, project_id, alert_id, context, repo
      FROM remediation_sessions
      WHERE id = ${sessionId}::uuid
      LIMIT 1
    `);
    const rows = Array.isArray(res) ? res : ((res as { rows?: SessionRow[] }).rows ?? []);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function resolveSessionUserId(sessionId: string): Promise<string | null> {
  try {
    const res = await db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM remediation_sessions
      WHERE id = ${sessionId}::uuid
      LIMIT 1
    `);
    const rows = Array.isArray(res) ? res : ((res as { rows?: { user_id: string }[] }).rows ?? []);
    return rows[0]?.user_id ?? null;
  } catch {
    return null;
  }
}

async function countPriorRemediations(
  fingerprint: string,
  projectId: string,
  excludeSessionId: string,
): Promise<number> {
  try {
    const res = await db.execute<{ count: string | number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM remediation_sessions
      WHERE fingerprint = ${fingerprint}
        AND project_id = ${projectId}::uuid
        AND id <> ${excludeSessionId}::uuid
    `);
    const rows = Array.isArray(res) ? res : ((res as { rows?: { count: string | number }[] }).rows ?? []);
    const raw = rows[0]?.count ?? 0;
    return typeof raw === "number" ? raw : parseInt(String(raw), 10) || 0;
  } catch {
    return 0;
  }
}

async function persistRoute(sessionId: string, result: ClassificationResult): Promise<void> {
  try {
    await db
      .update(remediationSessions)
      .set({
        tierUsed: String(result.tier),
        patternMatchScore: result.featuresSnapshot.patternMatchScore,
        updatedAt: new Date(),
      })
      .where(eq(remediationSessions.id, sessionId));
  } catch {
    // Telemetry write failures never propagate.
  }
}

function toPatternInputAlert(a: AlertRow): PatternInputAlert {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    fingerprint: a.fingerprint,
    sourceIntegrations: a.source_integrations ?? [],
  };
}

// ── Promotion gate helper (used by Tier 0 handler once wired) ───────────────

export function meetsTier0PromotionGate(match: PatternMatch): boolean {
  return (
    match.score >= TIER_0_PROMOTION_CONFIDENCE &&
    match.successCount >= TIER_0_PROMOTION_SUCCESS_COUNT &&
    (match.postMergeHealth ?? 0) >= TIER_0_PROMOTION_HEALTH
  );
}
