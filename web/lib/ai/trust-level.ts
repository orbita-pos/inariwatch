/**
 * Trust Level System
 *
 * Computes a project's trust level based on its remediation track record.
 * Mirrors the Rust CLI implementation (cli/src/db.rs) for the web backend.
 *
 * Trust levels control auto-merge gate thresholds:
 *   Rookie     → never auto-merge (draft PRs only)
 *   Apprentice → strict gates (confidence >= 90, lines <= 50)
 *   Trusted    → standard gates (confidence >= 80, lines <= 100)
 *   Expert     → relaxed gates (confidence >= 70, lines <= 200)
 *
 * Progression is earned through successful fixes with passing CI and no regressions.
 */

import { db, remediationSessions } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

export type TrustLevelName = "Rookie" | "Apprentice" | "Trusted" | "Expert";

export type TrustLevel = {
  name: TrustLevelName;
  level: number;
  minConfidence: number;
  minReviewScore: number;
  maxLinesChanged: number;
};

export type TrackRecord = {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  trustLevel: TrustLevel;
  fixesToNextLevel: number | null;
};

// ── Trust level definitions ─────────────────────────────────────────────────

const LEVELS: Record<TrustLevelName, TrustLevel> = {
  Rookie: {
    name: "Rookie",
    level: 0,
    minConfidence: 101,   // impossible — never auto-merge
    minReviewScore: 101,
    maxLinesChanged: 0,
  },
  Apprentice: {
    name: "Apprentice",
    level: 1,
    minConfidence: 90,
    minReviewScore: 70,
    maxLinesChanged: 50,
  },
  Trusted: {
    name: "Trusted",
    level: 2,
    minConfidence: 80,
    minReviewScore: 70,
    maxLinesChanged: 100,
  },
  Expert: {
    name: "Expert",
    level: 3,
    minConfidence: 70,
    minReviewScore: 70,
    maxLinesChanged: 200,
  },
};

// ── Core logic ──────────────────────────────────────────────────────────────

/** Compute trust level from track record (mirrors cli/src/db.rs:compute_trust_level) */
function computeTrustLevel(total: number, successRate: number): TrustLevel {
  if (total >= 10 && successRate >= 0.85) return LEVELS.Expert;
  if (total >= 5 && successRate >= 0.70) return LEVELS.Trusted;
  if (total >= 3 && successRate >= 0.50) return LEVELS.Apprentice;
  return LEVELS.Rookie;
}

/** How many more successful fixes needed to reach the next level */
function fixesToNextLevel(total: number, succeeded: number, current: TrustLevel): number | null {
  if (current.name === "Expert") return null; // max level

  // Requirements for next level
  const requirements: Record<TrustLevelName, { fixes: number; rate: number }> = {
    Rookie: { fixes: 3, rate: 0.50 },
    Apprentice: { fixes: 5, rate: 0.70 },
    Trusted: { fixes: 10, rate: 0.85 },
    Expert: { fixes: 0, rate: 0 }, // already max
  };

  const next = requirements[current.name];
  const fixesNeeded = Math.max(0, next.fixes - total);
  const rateNeeded = Math.max(0, Math.ceil(next.rate * (total + fixesNeeded)) - succeeded);

  return Math.max(fixesNeeded, rateNeeded);
}

// ── DB query ────────────────────────────────────────────────────────────────

/** Get trust level for a project based on its remediation history */
export async function getProjectTrustLevel(projectId: string): Promise<TrackRecord> {
  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${remediationSessions.status} = 'completed' and ${remediationSessions.monitoringStatus} != 'reverted')::int`,
      failed: sql<number>`count(*) filter (where ${remediationSessions.status} = 'failed' or ${remediationSessions.monitoringStatus} = 'reverted')::int`,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.projectId, projectId));

  const row = result[0] ?? { total: 0, succeeded: 0, failed: 0 };
  const total = row.total;
  const succeeded = row.succeeded;
  const failed = row.failed;
  const successRate = total > 0 ? succeeded / total : 0;

  const trustLevel = computeTrustLevel(total, successRate);

  return {
    total,
    succeeded,
    failed,
    successRate,
    trustLevel,
    fixesToNextLevel: fixesToNextLevel(total, succeeded, trustLevel),
  };
}

/** Apply trust level thresholds to an AutoMergeConfig, tightening if trust is low */
export function applyTrustLevel(
  config: { enabled: boolean; minConfidence: number; maxLinesChanged: number },
  trustLevel: TrustLevel
): { enabled: boolean; minConfidence: number; maxLinesChanged: number } {
  // Trust level can only TIGHTEN thresholds, never relax them
  return {
    enabled: config.enabled && trustLevel.level > 0, // Rookie → never auto-merge
    minConfidence: Math.max(config.minConfidence, trustLevel.minConfidence),
    maxLinesChanged: Math.min(config.maxLinesChanged, trustLevel.maxLinesChanged),
  };
}
