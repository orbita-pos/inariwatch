// /admin/ops AI router receipts — 24h aggregation endpoint.
//
// Reads from `ai_router_receipts` (migration 0076) and returns a compact
// summary the dashboard widget renders. Admin-only — same auth pattern as
// the other /api/admin/* endpoints.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

// Drizzle's `db.execute<T>` constrains `T extends Record<string, unknown>`.
// Use type-aliased intersections so the row shapes index-signature cleanly
// without an open `[key: string]: unknown;` field on every interface.
type SubstrateRow = {
  substrate: string;
  count: number;
  p50_duration_ms: number;
  p95_duration_ms: number;
} & Record<string, unknown>;

type TaskRow = {
  task: string;
  count: number;
} & Record<string, unknown>;

type TotalsRow = {
  total: number;
  fallback_count: number;
} & Record<string, unknown>;

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email || email !== process.env.ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 24h window. Postgres `percentile_cont` gives p50/p95 in one pass.
  const substrateAgg = await db.execute<SubstrateRow>(sql`
    SELECT
      substrate,
      COUNT(*)::int AS count,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50_duration_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_duration_ms
    FROM ai_router_receipts
    WHERE created_at > now() - INTERVAL '24 hours'
    GROUP BY substrate
    ORDER BY count DESC
  `);

  const taskAgg = await db.execute<TaskRow>(sql`
    SELECT task, COUNT(*)::int AS count
    FROM ai_router_receipts
    WHERE created_at > now() - INTERVAL '24 hours'
    GROUP BY task
    ORDER BY count DESC
    LIMIT 5
  `);

  const totalsRow = await db.execute<TotalsRow>(sql`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END)::int AS fallback_count
    FROM ai_router_receipts
    WHERE created_at > now() - INTERVAL '24 hours'
  `);

  const substrateRows = readRows<SubstrateRow>(substrateAgg);
  const taskRows = readRows<TaskRow>(taskAgg);
  const totalsRows = readRows<TotalsRow>(totalsRow);
  const totals = totalsRows[0] ?? { total: 0, fallback_count: 0 };

  return NextResponse.json({
    windowHours: 24,
    total: totals.total ?? 0,
    bySubstrate: substrateRows.map((r) => ({
      substrate: r.substrate,
      count: r.count,
      p50DurationMs: r.p50_duration_ms,
      p95DurationMs: r.p95_duration_ms,
    })),
    topTasks: taskRows.map((r) => ({ task: r.task, count: r.count })),
    fallbackCount: totals.fallback_count ?? 0,
  });
}

/**
 * Drizzle's neon-http result is `{ rows: T[] }` — but the typings here vary
 * across driver versions. Normalize once.
 */
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
