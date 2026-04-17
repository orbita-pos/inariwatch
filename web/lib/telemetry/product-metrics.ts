/**
 * VAR product telemetry — fire-and-forget event emitter.
 *
 * Every new VAR feature emits at least one event here so we can measure
 * adoption and progress through the 17-gate roadmap. Backed by the
 * `product_metrics` table (migration 0057).
 *
 * Design rules:
 *   - emit() never throws. Telemetry MUST NEVER break a user request.
 *   - emit() never blocks. We don't await DB inserts on hot paths.
 *   - DB inserts are best-effort. If Postgres is down, the event is
 *     dropped — acceptable for a metrics signal, not for billing.
 *   - Event names use snake_case: <feature>_<action>. See VAR_EVENTS
 *     for the canonical list (extend as features ship).
 *
 * Usage:
 *   import { productMetrics, VAR_EVENTS } from "@/lib/telemetry/product-metrics"
 *   productMetrics.emit(VAR_EVENTS.SESSION_ID_PROPAGATED, {
 *     organizationId: org.id,
 *     metadata: { sdk_version: "0.8.0" },
 *   })
 */

import { db, productMetrics as productMetricsTable } from "@/lib/db";

/**
 * Canonical event names. Extend as features ship — keeps grep-ability and
 * reduces typos. Free-form strings are still allowed but discouraged.
 */
export const VAR_EVENTS = {
  // Q1 — FullTrace foundation
  SESSION_ID_PROPAGATED: "session_id_propagated",
  SESSION_ID_RECEIVED: "session_id_received",
  SESSION_CORRELATED_TO_ALERT: "session_correlated_to_alert",
  SESSION_CORRELATED_TO_SUBSTRATE: "session_correlated_to_substrate",

  // Q1 — What-If
  WHATIF_REPLAY_REQUESTED: "whatif_replay_requested",
  WHATIF_REPLAY_CACHE_HIT: "whatif_replay_cache_hit",
  WHATIF_REPLAY_COMPUTED: "whatif_replay_computed",
  WHATIF_REPLAY_FAILED: "whatif_replay_failed",

  // Q2 — Gates (added as we build them)
  GATE_PASSED: "gate_passed",
  GATE_FAILED: "gate_failed",

  // Q2 — Progressive rollout
  ROLLOUT_PROMOTED: "rollout_promoted",
  ROLLOUT_AUTO_REVERTED: "rollout_auto_reverted",

  // Q3 — EAP chain
  EAP_CHAIN_PUBLISHED: "eap_chain_published",

  // Cross-quarter — autonomous mode (graduated trust)
  FIX_HUMAN_APPROVED: "fix_human_approved",
  FIX_AUTONOMOUS_MERGED: "fix_autonomous_merged",
  TRUST_LEVEL_PROMOTED: "trust_level_promoted",
} as const;

export type VarEvent = typeof VAR_EVENTS[keyof typeof VAR_EVENTS];

export interface EmitOptions {
  organizationId?: string | null;
  userId?: string | null;
  /** Numeric measurement (latency ms, cost, count, etc.) */
  valueNumeric?: number;
  /** Categorical tag (env name, fix id, etc.) — keep short */
  valueText?: string;
  /** Arbitrary structured context. Stays small (<2KB) for query speed. */
  metadata?: Record<string, unknown>;
}

const inFlight = new Set<Promise<unknown>>();

/**
 * Fire-and-forget. Returns immediately. The DB insert runs in background
 * and is tracked in `inFlight` so tests can `await flushMetrics()`.
 *
 * Errors are swallowed silently — telemetry failures must never propagate
 * to the request handler. If you need confirmed delivery, this is the wrong tool.
 */
function emit(event: VarEvent | string, opts: EmitOptions = {}): void {
  const promise = (async () => {
    try {
      await db.insert(productMetricsTable).values({
        event,
        organizationId: opts.organizationId ?? null,
        userId: opts.userId ?? null,
        valueNumeric: opts.valueNumeric ?? null,
        valueText: opts.valueText ?? null,
        metadata: opts.metadata ?? null,
      });
    } catch {
      // Telemetry must never break the caller. We considered console.warn
      // here but in serverless that just adds noise to log searches.
    }
  })();

  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise));
}

/**
 * Wait for all pending emits to flush. Test helper — do not call from
 * production code (it defeats the purpose of fire-and-forget).
 */
async function flushMetrics(): Promise<void> {
  await Promise.allSettled(Array.from(inFlight));
}

export const productMetrics = {
  emit,
  flushMetrics,
};
