// /admin/ops Code Intelligence v2 shadow stats endpoint.
//
// Phase 1.7 of CODE_INTELLIGENCE_V2_HANDOFF.md. Aggregates the
// `code_intel_shadow_log` table into the metrics the dashboard widget
// renders: per-engine sample count + p50/p95 latency, divergence rate,
// top diverging queries (last 24h).
//
// Admin-only. Read-only — no writes against the table.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";

import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

type SummaryRow = {
  total_calls: number;
  v1_p50_ms: number;
  v1_p95_ms: number;
  v2_p50_ms: number;
  v2_p95_ms: number;
  v1_errors: number;
  v2_errors: number;
  divergent_calls: number;
  empty_v2_calls: number;
} & Record<string, unknown>;

type DivergingQueryRow = {
  query: string;
  v1_top: string[];
  v2_top: string[];
  created_at: Date;
} & Record<string, unknown>;

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email || email !== process.env.ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 24h window keeps the percentile compute cheap. Phase 3 may extend
  // this once a daily aggregator is in place.
  const summary = await db.execute<SummaryRow>(sql`
    WITH window_rows AS (
      SELECT
        v1_duration_ms,
        v2_duration_ms,
        v1_error,
        v2_error,
        v1_top_fqns,
        v2_top_fqns,
        v2_result_count
      FROM code_intel_shadow_log
      WHERE created_at >= now() - interval '24 hours'
    )
    SELECT
      COUNT(*)::int                                                   AS total_calls,
      COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY v1_duration_ms), 0)::int AS v1_p50_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY v1_duration_ms), 0)::int AS v1_p95_ms,
      COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY v2_duration_ms), 0)::int AS v2_p50_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY v2_duration_ms), 0)::int AS v2_p95_ms,
      SUM(CASE WHEN v1_error IS NOT NULL THEN 1 ELSE 0 END)::int      AS v1_errors,
      SUM(CASE WHEN v2_error IS NOT NULL THEN 1 ELSE 0 END)::int      AS v2_errors,
      SUM(CASE WHEN v1_top_fqns::text != v2_top_fqns::text THEN 1 ELSE 0 END)::int AS divergent_calls,
      SUM(CASE WHEN v2_result_count = 0 THEN 1 ELSE 0 END)::int       AS empty_v2_calls
    FROM window_rows
  `);

  const divergingQueries = await db.execute<DivergingQueryRow>(sql`
    SELECT query,
           v1_top_fqns AS v1_top,
           v2_top_fqns AS v2_top,
           created_at
    FROM code_intel_shadow_log
    WHERE created_at >= now() - interval '24 hours'
      AND v1_top_fqns::text != v2_top_fqns::text
    ORDER BY created_at DESC
    LIMIT 5
  `);

  const summaryRow = readRows<SummaryRow>(summary)[0] ?? {
    total_calls: 0,
    v1_p50_ms: 0,
    v1_p95_ms: 0,
    v2_p50_ms: 0,
    v2_p95_ms: 0,
    v1_errors: 0,
    v2_errors: 0,
    divergent_calls: 0,
    empty_v2_calls: 0,
  };
  const divergingRows = readRows<DivergingQueryRow>(divergingQueries);

  const total = summaryRow.total_calls;
  const divergencePct =
    total > 0 ? Number(((summaryRow.divergent_calls / total) * 100).toFixed(2)) : 0;

  return NextResponse.json({
    windowHours: 24,
    totalCalls: total,
    v1: {
      p50Ms: summaryRow.v1_p50_ms,
      p95Ms: summaryRow.v1_p95_ms,
      errors: summaryRow.v1_errors,
    },
    v2: {
      p50Ms: summaryRow.v2_p50_ms,
      p95Ms: summaryRow.v2_p95_ms,
      errors: summaryRow.v2_errors,
      emptyResultCount: summaryRow.empty_v2_calls,
    },
    divergence: {
      count: summaryRow.divergent_calls,
      pct: divergencePct,
    },
    topDiverging: divergingRows.map((r) => ({
      query: r.query,
      v1Top: r.v1_top ?? [],
      v2Top: r.v2_top ?? [],
      createdAt: r.created_at,
    })),
  });
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
