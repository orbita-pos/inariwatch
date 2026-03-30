import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/community/fixes
 *
 * Public API — no auth required. CORS open for external consumption.
 *
 * Query params:
 *   category         — runtime_error | build_error | ci_error | infrastructure | unknown
 *   framework        — nextjs | express | node | ...
 *   language         — typescript | javascript | python | ...
 *   min_success_rate — integer 0–100, filters by minimum success rate
 *   sort             — success_rate (default) | occurrences | recent
 *   limit            — max 100, default 50
 *   offset           — pagination offset, default 0
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const category        = searchParams.get("category");
  const framework       = searchParams.get("framework");
  const language        = searchParams.get("language");
  const minSuccessRate  = Math.max(0, Math.min(100, Number(searchParams.get("min_success_rate")) || 0));
  const sortBy          = searchParams.get("sort") || "success_rate";
  const limit           = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 50));
  const offset          = Math.max(0, Number(searchParams.get("offset")) || 0);

  const categoryFilter  = category       ? sql`AND ep.category  = ${category}`   : sql``;
  const frameworkFilter = framework      ? sql`AND ep.framework = ${framework}`   : sql``;
  const languageFilter  = language       ? sql`AND ep.language  = ${language}`   : sql``;
  const successFilter   = minSuccessRate > 0
    ? sql`AND cf.total_applications > 0 AND ROUND(cf.success_count::numeric / cf.total_applications * 100) >= ${minSuccessRate}`
    : sql``;

  const orderClause =
    sortBy === "occurrences" ? sql`ORDER BY ep.occurrence_count DESC, sr DESC`  :
    sortBy === "recent"      ? sql`ORDER BY cf.created_at DESC`                 :
                               sql`ORDER BY sr DESC, cf.total_applications DESC`;

  const [rows, countRow] = await Promise.all([
    db.execute(sql`
      SELECT
        cf.id,
        cf.fix_approach,
        cf.fix_description,
        cf.files_changed_summary,
        cf.avg_confidence,
        cf.success_count,
        cf.failure_count,
        cf.total_applications,
        cf.created_at,
        ep.id            AS pattern_id,
        ep.fingerprint,
        ep.pattern_text,
        ep.category,
        ep.framework,
        ep.language,
        ep.occurrence_count,
        CASE WHEN cf.total_applications > 0
          THEN ROUND(cf.success_count::numeric / cf.total_applications * 100)::int
          ELSE 0
        END AS sr
      FROM community_fixes cf
      JOIN error_patterns ep ON ep.id = cf.pattern_id
      WHERE 1=1
        ${categoryFilter}
        ${frameworkFilter}
        ${languageFilter}
        ${successFilter}
      ${orderClause}
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM community_fixes cf
      JOIN error_patterns ep ON ep.id = cf.pattern_id
      WHERE 1=1
        ${categoryFilter}
        ${frameworkFilter}
        ${languageFilter}
        ${successFilter}
    `),
  ]);

  const total = Number((countRow.rows[0] as { total: number })?.total ?? 0);

  const fixes = (rows.rows ?? []).map((r: Record<string, unknown>) => ({
    id:                 r.id,
    successRate:        Number(r.sr),
    totalApplications:  Number(r.total_applications),
    successCount:       Number(r.success_count),
    failureCount:       Number(r.failure_count),
    fixApproach:        r.fix_approach,
    fixDescription:     r.fix_description,
    filesChangedSummary:r.files_changed_summary,
    avgConfidence:      r.avg_confidence !== null ? Number(r.avg_confidence) : null,
    createdAt:          r.created_at,
    pattern: {
      id:             r.pattern_id,
      fingerprint:    r.fingerprint,
      patternText:    r.pattern_text,
      category:       r.category,
      framework:      r.framework,
      language:       r.language,
      occurrenceCount:Number(r.occurrence_count),
    },
  }));

  return NextResponse.json({ fixes, total, limit, offset }, { headers: CORS });
}
