/**
 * Circuit breaker for auto-merge gates.
 *
 * If a gate fails consistently (e.g., staging server down), the circuit opens
 * and the gate is bypassed to prevent blocking all remediations.
 *
 * States: CLOSED (normal) → OPEN (bypassed) → HALF_OPEN (testing) → CLOSED
 */

import { db, gateTelemetry } from "@/lib/db";
import { eq, and, gte, desc, sql } from "drizzle-orm";

export type CircuitState = "closed" | "open" | "half_open";

/** All valid gate names — use this type to prevent typos in gate references */
export type GateName =
  | "auto_merge_enabled"
  | "ci_passed"
  | "confidence"
  | "lines_changed"
  | "self_review"
  | "substrate_simulate"
  | "eap_chain_verified"
  | "prediction_safe"
  | "security_scan"
  | "substrate_replay"
  | "e2e_staging";

const FAILURE_THRESHOLD = 5; // consecutive failures to trip
const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours
const RECOVERY_MS = 15 * 60 * 1000; // 15 min cooldown before half_open
/** Max gates the circuit breaker can bypass simultaneously before forcing draft_pr */
export const MAX_SIMULTANEOUS_BYPASSES = 2;

/** Gates that NEVER get bypassed by the circuit breaker */
const NON_BYPASSABLE_GATES = new Set<GateName>([
  "ci_passed",
  "security_scan",
  "self_review",
  "auto_merge_enabled",
]);

// ── Record gate result ──────────────────────────────────────────────────────

export async function recordGateResult(
  projectId: string,
  gateName: string,
  passed: boolean,
  errorReason?: string,
  durationMs?: number,
): Promise<void> {
  await db.insert(gateTelemetry).values({
    projectId,
    gateName,
    result: passed,
    errorReason: errorReason ?? null,
    durationMs: durationMs ?? null,
  });
}

// ── Get circuit state ───────────────────────────────────────────────────────

export async function getCircuitState(
  projectId: string,
  gateName: string,
): Promise<CircuitState> {
  // Non-bypassable gates are always closed
  if (NON_BYPASSABLE_GATES.has(gateName as GateName)) return "closed";

  const since = new Date(Date.now() - LOOKBACK_MS);

  // Get last N results for this gate
  const recent = await db.select({ result: gateTelemetry.result, checkedAt: gateTelemetry.checkedAt })
    .from(gateTelemetry)
    .where(and(
      eq(gateTelemetry.projectId, projectId),
      eq(gateTelemetry.gateName, gateName),
      gte(gateTelemetry.checkedAt, since),
    ))
    .orderBy(desc(gateTelemetry.checkedAt))
    .limit(FAILURE_THRESHOLD + 1);

  if (recent.length < FAILURE_THRESHOLD) return "closed";

  // Check if the last N are all failures
  const lastN = recent.slice(0, FAILURE_THRESHOLD);
  const allFailed = lastN.every((r) => !r.result);
  if (!allFailed) return "closed";

  // Circuit is tripped — check if recovery period has elapsed
  const lastFailure = new Date(lastN[0].checkedAt);
  const elapsed = Date.now() - lastFailure.getTime();

  if (elapsed >= RECOVERY_MS) {
    return "half_open"; // Allow one probe attempt
  }

  return "open"; // Still in cooldown
}

/** Check if a gate should be bypassed due to circuit breaker */
export async function shouldBypassGate(
  projectId: string,
  gateName: string,
): Promise<{ bypass: boolean; state: CircuitState }> {
  const state = await getCircuitState(projectId, gateName);
  return { bypass: state === "open", state };
}

// ── Gate Telemetry Queries (dashboard data) ─────────────────────────────────

export interface GateStats {
  gate: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  circuitBreakerTrips: number;
}

export async function getGateStats(
  projectId: string,
  sinceDays: number = 14,
): Promise<GateStats[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const rows = await db.select({
    gateName: gateTelemetry.gateName,
    total: sql<number>`count(*)::int`,
    passed: sql<number>`count(*) filter (where ${gateTelemetry.result} = true)::int`,
    failed: sql<number>`count(*) filter (where ${gateTelemetry.result} = false)::int`,
  })
    .from(gateTelemetry)
    .where(and(
      eq(gateTelemetry.projectId, projectId),
      gte(gateTelemetry.checkedAt, since),
    ))
    .groupBy(gateTelemetry.gateName);

  return rows.map((r) => ({
    gate: r.gateName,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    passRate: r.total > 0 ? r.passed / r.total : 1,
    circuitBreakerTrips: 0, // computed separately if needed
  }));
}

export async function getGateBottlenecks(projectId: string): Promise<GateStats[]> {
  const stats = await getGateStats(projectId);
  return stats
    .filter((s) => s.total >= 3) // need enough data
    .sort((a, b) => a.passRate - b.passRate)
    .slice(0, 3);
}

export async function getProjectHealthScore(projectId: string): Promise<number> {
  const stats = await getGateStats(projectId);
  if (stats.length === 0) return 100; // no data = healthy

  // Gate pass rate (40%)
  const totalGateChecks = stats.reduce((s, g) => s + g.total, 0);
  const totalGatePassed = stats.reduce((s, g) => s + g.passed, 0);
  const gatePassRate = totalGateChecks > 0 ? totalGatePassed / totalGateChecks : 1;

  // CI pass rate (30%) — from ci_passed gate specifically
  const ciGate = stats.find((s) => s.gate === "ci_passed");
  const ciPassRate = ciGate && ciGate.total > 0 ? ciGate.passed / ciGate.total : 1;

  // Auto-merge ratio (30%) — from auto_merge_enabled gate
  const mergeGate = stats.find((s) => s.gate === "auto_merge_enabled");
  const mergeRate = mergeGate && mergeGate.total > 0 ? mergeGate.passed / mergeGate.total : 0.5;

  return Math.round((gatePassRate * 40 + ciPassRate * 30 + mergeRate * 30));
}
