import { db, errorPatterns, communityFixes } from "@/lib/db";
import { eq, desc } from "drizzle-orm";

export interface CommunityFixMatch {
  patternId: string;
  fixId: string;
  fixApproach: string;
  fixDescription: string;
  filesChanged: string[];
  successCount: number;
  failureCount: number;
  totalApplications: number;
  successRate: number;
  avgConfidence: number;
  occurrenceCount: number; // how many teams hit this error
}

/**
 * Look up a community fix for an alert by fingerprint.
 * Returns the best fix (highest success count) if one exists with success rate >= 60%.
 */
export async function lookupCommunityFix(fingerprint: string): Promise<CommunityFixMatch | null> {
  if (!fingerprint) return null;

  const [pattern] = await db
    .select()
    .from(errorPatterns)
    .where(eq(errorPatterns.fingerprint, fingerprint))
    .limit(1);

  if (!pattern) return null;

  const [bestFix] = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.patternId, pattern.id))
    .orderBy(desc(communityFixes.successCount))
    .limit(1);

  if (!bestFix || bestFix.totalApplications === 0) return null;

  const successRate = Math.round((bestFix.successCount / bestFix.totalApplications) * 100);

  // Only return fixes with >= 60% success rate
  if (successRate < 60) return null;

  return {
    patternId: pattern.id,
    fixId: bestFix.id,
    fixApproach: bestFix.fixApproach,
    fixDescription: bestFix.fixDescription,
    filesChanged: bestFix.filesChangedSummary?.split(", ") ?? [],
    successCount: bestFix.successCount,
    failureCount: bestFix.failureCount,
    totalApplications: bestFix.totalApplications,
    successRate,
    avgConfidence: bestFix.avgConfidence,
    occurrenceCount: pattern.occurrenceCount,
  };
}
