import { NextResponse } from "next/server";
import { db, errorPatterns, communityFixes } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Overview aggregates
    const overviewResult = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM error_patterns) AS total_patterns,
        (SELECT COUNT(*) FROM community_fixes) AS total_fixes,
        (SELECT COALESCE(SUM(total_applications), 0) FROM community_fixes) AS total_applications,
        (SELECT COALESCE(SUM(success_count), 0) FROM community_fixes) AS total_success,
        (SELECT COALESCE(AVG(avg_confidence), 0) FROM community_fixes WHERE total_applications > 0) AS avg_confidence
    `);

    const ov = (overviewResult.rows?.[0] ?? {}) as Record<string, unknown>;
    const totalApps = Number(ov.total_applications ?? 0);
    const totalSuccess = Number(ov.total_success ?? 0);

    // Top 10 most successful patterns (min 3 applications)
    const topSuccessful = await db.execute(sql`
      SELECT
        ep.pattern_text, ep.category, ep.occurrence_count,
        cf.fix_approach, cf.success_count, cf.total_applications,
        CASE WHEN cf.total_applications > 0
          THEN ROUND(cf.success_count * 100.0 / cf.total_applications)
          ELSE 0 END AS success_rate
      FROM community_fixes cf
      JOIN error_patterns ep ON ep.id = cf.pattern_id
      WHERE cf.total_applications >= 3
      ORDER BY success_rate DESC, cf.total_applications DESC
      LIMIT 10
    `);

    // Top 10 most attempted patterns
    const mostAttempted = await db.execute(sql`
      SELECT
        ep.pattern_text, ep.category, ep.occurrence_count,
        (SELECT COUNT(*) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS fix_count,
        (SELECT COALESCE(SUM(cf.total_applications), 0) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS total_apps
      FROM error_patterns ep
      ORDER BY ep.occurrence_count DESC
      LIMIT 10
    `);

    // Recent 20 fix contributions
    const recentActivity = await db.execute(sql`
      SELECT
        cf.fix_approach, cf.updated_at, cf.success_count, cf.total_applications,
        ep.pattern_text, ep.category
      FROM community_fixes cf
      JOIN error_patterns ep ON ep.id = cf.pattern_id
      ORDER BY cf.updated_at DESC
      LIMIT 20
    `);

    return NextResponse.json({
      overview: {
        totalPatterns: Number(ov.total_patterns ?? 0),
        totalFixes: Number(ov.total_fixes ?? 0),
        totalApplications: totalApps,
        overallSuccessRate: totalApps > 0 ? Math.round((totalSuccess / totalApps) * 100) : 0,
        avgConfidence: Math.round(Number(ov.avg_confidence ?? 0)),
      },
      topSuccessful: topSuccessful.rows ?? [],
      mostAttempted: mostAttempted.rows ?? [],
      recentActivity: recentActivity.rows ?? [],
    });
  } catch (err) {
    console.error("Fleet API error:", err);
    return NextResponse.json({ error: "Failed to load fleet stats" }, { status: 500 });
  }
}
