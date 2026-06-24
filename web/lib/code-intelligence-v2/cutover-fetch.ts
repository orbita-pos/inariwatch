/**
 * Code Intelligence v2 — Phase 3.3 cutover input fetcher.
 *
 * Reads raw rows from `code_intel_remediation_ab` + `code_intel_shadow_log`
 * and shapes them into the `ComputeMetricsInput` the pure lib expects.
 * Used by both the CLI eval script and the admin endpoint so they're
 * guaranteed to agree.
 */

import { db, codeIntelRemediationAb, codeIntelShadowLog } from "@/lib/db";
import { sql } from "drizzle-orm";

import type { ComputeMetricsInput } from "./cutover-eval";
import { CUTOVER_WINDOW_HOURS } from "./cutover-criteria";

interface FetchOpts {
  windowHours?: number;
}

export async function fetchCutoverInputs(opts: FetchOpts = {}): Promise<ComputeMetricsInput> {
  const windowHours = opts.windowHours ?? CUTOVER_WINDOW_HOURS;
  const interval = `${windowHours} hours`;
  type AbRow = { engine: string; turn_count: number; success: boolean } & Record<string, unknown>;
  type ShadowRow = { divergent: boolean; v2_timed_out: boolean } & Record<string, unknown>;

  const abResult = await db.execute<AbRow>(sql`
    SELECT engine, turn_count, success
    FROM code_intel_remediation_ab
    WHERE created_at >= now() - ${interval}::interval
  `);
  const shadowResult = await db.execute<ShadowRow>(sql`
    SELECT (v1_top_fqns::text != v2_top_fqns::text) AS divergent,
           v2_timed_out
    FROM code_intel_shadow_log
    WHERE created_at >= now() - ${interval}::interval
  `);

  // Touch schema imports so the lockdown rule keeps them as live references.
  void codeIntelRemediationAb;
  void codeIntelShadowLog;

  const abRows = readRows<AbRow>(abResult);
  const shadowRows = readRows<ShadowRow>(shadowResult);
  return {
    ab: abRows
      .filter((r) => r.engine === "v1" || r.engine === "v2")
      .map((r) => ({
        engine: r.engine as "v1" | "v2",
        turnCount: Number(r.turn_count) | 0,
        success: !!r.success,
      })),
    shadow: shadowRows.map((r) => ({
      divergent: !!r.divergent,
      v2TimedOut: !!r.v2_timed_out,
    })),
  };
}

function readRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in (result as Record<string, unknown>) &&
    Array.isArray((result as { rows: unknown[] }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
