import { NextResponse } from "next/server";
import { db, errorPatterns, communityFixes } from "@/lib/db";
import { eq, desc } from "drizzle-orm";

/**
 * GET /api/patterns/search?fingerprint={fingerprint}&lang={language}
 *
 * Search for error patterns by fingerprint. Returns matching patterns
 * with their community fixes sorted by success count.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const fingerprint = searchParams.get("fingerprint") ?? searchParams.get("q");
  const language = searchParams.get("lang");

  if (!fingerprint) {
    return NextResponse.json({ error: "fingerprint parameter required" }, { status: 400 });
  }

  // Exact fingerprint match
  const [pattern] = await db
    .select()
    .from(errorPatterns)
    .where(eq(errorPatterns.fingerprint, fingerprint))
    .limit(1);

  if (!pattern) {
    return NextResponse.json({ matches: [] });
  }

  // Get community fixes for this pattern
  const fixes = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.patternId, pattern.id))
    .orderBy(desc(communityFixes.successCount))
    .limit(5);

  return NextResponse.json({
    matches: [{
      pattern: {
        id: pattern.id,
        fingerprint: pattern.fingerprint,
        patternText: pattern.patternText,
        category: pattern.category,
        framework: pattern.framework,
        language: pattern.language,
        occurrenceCount: pattern.occurrenceCount,
      },
      fixes: fixes.map((f) => ({
        id: f.id,
        fixApproach: f.fixApproach,
        fixDescription: f.fixDescription,
        filesChangedSummary: f.filesChangedSummary,
        avgConfidence: f.avgConfidence,
        successCount: f.successCount,
        failureCount: f.failureCount,
        totalApplications: f.totalApplications,
      })),
    }],
  });
}
