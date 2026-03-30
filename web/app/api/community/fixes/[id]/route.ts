import { NextRequest, NextResponse } from "next/server";
import { db, communityFixes, errorPatterns } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * GET /api/community/fixes/:id
 *
 * Returns full details for a single community fix including its pattern context.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [fix] = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.id, id))
    .limit(1);

  if (!fix) {
    return NextResponse.json({ error: "Fix not found" }, { status: 404, headers: CORS });
  }

  const [pattern] = await db
    .select()
    .from(errorPatterns)
    .where(eq(errorPatterns.id, fix.patternId))
    .limit(1);

  const successRate = fix.totalApplications > 0
    ? Math.round((fix.successCount / fix.totalApplications) * 100)
    : 0;

  return NextResponse.json({
    id:                  fix.id,
    successRate,
    totalApplications:   fix.totalApplications,
    successCount:        fix.successCount,
    failureCount:        fix.failureCount,
    fixApproach:         fix.fixApproach,
    fixDescription:      fix.fixDescription,
    filesChangedSummary: fix.filesChangedSummary,
    avgConfidence:       fix.avgConfidence,
    createdAt:           fix.createdAt,
    updatedAt:           fix.updatedAt,
    pattern: pattern ? {
      id:              pattern.id,
      fingerprint:     pattern.fingerprint,
      patternText:     pattern.patternText,
      category:        pattern.category,
      framework:       pattern.framework,
      language:        pattern.language,
      occurrenceCount: pattern.occurrenceCount,
      lastSeenAt:      pattern.lastSeenAt,
    } : null,
  }, { headers: CORS });
}
