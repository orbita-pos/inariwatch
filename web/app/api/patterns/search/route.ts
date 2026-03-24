import { NextResponse } from "next/server";
import { db, errorPatterns, communityFixes } from "@/lib/db";
import { eq, desc, sql } from "drizzle-orm";

/**
 * GET /api/patterns/search?fingerprint={fingerprint}&q={text}&lang={language}
 *
 * Hybrid search for error patterns:
 *   1. Exact fingerprint match (instant, deterministic)
 *   2. Text similarity via pg_trgm (fuzzy, catches rephrasings)
 *
 * Returns matching patterns with their community fixes sorted by success count.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const fingerprint = searchParams.get("fingerprint");
  const query = searchParams.get("q");
  const language = searchParams.get("lang");
  const limit = Math.min(Number(searchParams.get("limit")) || 5, 20);

  if (!fingerprint && !query) {
    return NextResponse.json(
      { error: "fingerprint or q parameter required" },
      { status: 400 }
    );
  }

  // Strategy 1: Exact fingerprint match
  if (fingerprint) {
    const [pattern] = await db
      .select()
      .from(errorPatterns)
      .where(eq(errorPatterns.fingerprint, fingerprint))
      .limit(1);

    if (pattern) {
      const fixes = await getFixesForPattern(pattern.id);
      return NextResponse.json({
        matches: [{ pattern: formatPattern(pattern), fixes, similarity: 1.0 }],
        strategy: "fingerprint",
      });
    }
  }

  // Strategy 2: Text similarity via pg_trgm
  const searchText = query ?? "";
  if (searchText.length < 3) {
    return NextResponse.json({ matches: [], strategy: "none" });
  }

  const languageFilter = language
    ? sql`AND ${errorPatterns.language} = ${language}`
    : sql``;

  const similarPatterns = await db.execute(sql`
    SELECT
      id, fingerprint, pattern_text, category, framework, language,
      occurrence_count, first_seen_at, last_seen_at, created_at,
      similarity(pattern_text, ${searchText}) AS sim
    FROM error_patterns
    WHERE similarity(pattern_text, ${searchText}) > 0.15
      ${languageFilter}
    ORDER BY sim DESC, occurrence_count DESC
    LIMIT ${limit}
  `);

  if (!similarPatterns.rows || similarPatterns.rows.length === 0) {
    return NextResponse.json({ matches: [], strategy: "similarity" });
  }

  const matches = await Promise.all(
    similarPatterns.rows.map(async (row: Record<string, unknown>) => {
      const patternId = row.id as string;
      const fixes = await getFixesForPattern(patternId);
      return {
        pattern: {
          id: patternId,
          fingerprint: row.fingerprint as string,
          patternText: row.pattern_text as string,
          category: row.category as string,
          framework: row.framework as string | null,
          language: row.language as string | null,
          occurrenceCount: row.occurrence_count as number,
        },
        fixes,
        similarity: Number((row.sim as number).toFixed(3)),
      };
    })
  );

  return NextResponse.json({ matches, strategy: "similarity" });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getFixesForPattern(patternId: string) {
  const fixes = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.patternId, patternId))
    .orderBy(desc(communityFixes.successCount))
    .limit(5);

  return fixes.map((f) => ({
    id: f.id,
    fixApproach: f.fixApproach,
    fixDescription: f.fixDescription,
    filesChangedSummary: f.filesChangedSummary,
    avgConfidence: f.avgConfidence,
    successCount: f.successCount,
    failureCount: f.failureCount,
    totalApplications: f.totalApplications,
  }));
}

function formatPattern(p: typeof errorPatterns.$inferSelect) {
  return {
    id: p.id,
    fingerprint: p.fingerprint,
    patternText: p.patternText,
    category: p.category,
    framework: p.framework,
    language: p.language,
    occurrenceCount: p.occurrenceCount,
  };
}
