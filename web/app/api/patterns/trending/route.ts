import { NextResponse } from "next/server";
import { db, errorPatterns, communityFixes } from "@/lib/db";
import { desc, sql, eq } from "drizzle-orm";

/**
 * GET /api/patterns/trending?days=7&limit=10&category=runtime_error
 *
 * Returns trending error patterns sorted by recent occurrence count.
 * Each pattern includes its top community fix.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(Number(searchParams.get("days")) || 7, 90);
  const limit = Math.min(Number(searchParams.get("limit")) || 10, 50);
  const category = searchParams.get("category");

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const categoryFilter = category
    ? sql`AND ${errorPatterns.category} = ${category}`
    : sql``;

  const patterns = await db.execute(sql`
    SELECT
      ep.id, ep.fingerprint, ep.pattern_text, ep.category,
      ep.framework, ep.language, ep.occurrence_count,
      ep.first_seen_at, ep.last_seen_at,
      (SELECT COUNT(*) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS fix_count,
      (SELECT COALESCE(SUM(cf.success_count), 0) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS total_success
    FROM error_patterns ep
    WHERE ep.last_seen_at >= ${since}
      ${categoryFilter}
    ORDER BY ep.occurrence_count DESC, ep.last_seen_at DESC
    LIMIT ${limit}
  `);

  const trending = await Promise.all(
    (patterns.rows ?? []).map(async (row: Record<string, unknown>) => {
      // Get top fix for this pattern
      const [topFix] = await db
        .select({
          id: communityFixes.id,
          fixApproach: communityFixes.fixApproach,
          fixDescription: communityFixes.fixDescription,
          successCount: communityFixes.successCount,
          totalApplications: communityFixes.totalApplications,
        })
        .from(communityFixes)
        .where(eq(communityFixes.patternId, row.id as string))
        .orderBy(desc(communityFixes.successCount))
        .limit(1);

      return {
        id: row.id as string,
        patternText: row.pattern_text as string,
        category: row.category as string,
        framework: row.framework as string | null,
        language: row.language as string | null,
        occurrenceCount: row.occurrence_count as number,
        fixCount: Number(row.fix_count),
        totalSuccess: Number(row.total_success),
        lastSeenAt: row.last_seen_at as string,
        topFix: topFix
          ? {
              id: topFix.id,
              fixApproach: topFix.fixApproach,
              fixDescription: topFix.fixDescription,
              successRate:
                topFix.totalApplications > 0
                  ? Math.round((topFix.successCount / topFix.totalApplications) * 100)
                  : 0,
            }
          : null,
      };
    })
  );

  return NextResponse.json({ trending, days, total: trending.length });
}
