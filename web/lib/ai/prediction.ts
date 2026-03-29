/**
 * Prediction Engine — Pre-deployment error detection
 *
 * Analyzes PR diffs against historical alerts, community patterns,
 * and Substrate recordings to predict errors before deployment.
 */

import { db, alerts, remediationSessions, errorPatterns, communityFixes, substrateRecordings } from "@/lib/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { callAI } from "./client";
import { getProjectOwnerAIKey } from "./get-key";
import { SYSTEM_PREDICTOR, buildPredictionPrompt, type PredictionResult } from "./prompts";
import * as gh from "@/lib/services/github-api";

export interface PredictionInput {
  projectId: string;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
}

export interface PredictionOutput {
  result: PredictionResult;
  patternMatches: {
    fingerprint: string;
    patternText: string;
    occurrenceCount: number;
    successRate: number;
  }[];
  shadowReplay: import("./shadow-replay").ShadowReplayResult | null;
}

/**
 * Run the full prediction pipeline for a PR.
 * Layer 1 (pattern match) + Layer 2 (AI prediction).
 */
export async function runPrediction(input: PredictionInput): Promise<PredictionOutput | null> {
  const { projectId, token, owner, repo, prNumber } = input;

  // Get AI key
  const aiKey = await getProjectOwnerAIKey(projectId);
  if (!aiKey) return null;

  // Fetch PR data
  const [prFiles, diff] = await Promise.all([
    gh.getPRFiles(token, owner, repo, prNumber),
    gh.getPRDiff(token, owner, repo, prNumber),
  ]);

  if (!diff || prFiles.length === 0) return null;

  // Gather context in parallel
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const prFileNames = prFiles.map((f) => f.filename);

  const [recentAlerts, communityPatternsRaw, substrateCtx, patternMatches] = await Promise.all([
    // Recent alerts for this project
    db
      .select({
        title: alerts.title,
        severity: alerts.severity,
        aiReasoning: alerts.aiReasoning,
      })
      .from(alerts)
      .where(and(
        eq(alerts.projectId, projectId),
        sql`${alerts.createdAt} > ${ninetyDaysAgo.toISOString()}`,
      ))
      .orderBy(desc(alerts.createdAt))
      .limit(15),

    // Community patterns via similarity search
    fetchCommunityPatterns(prFileNames),

    // Substrate recordings for changed files
    fetchSubstrateContext(projectId, prFileNames),

    // Direct fingerprint pattern matches
    findPatternMatches(projectId, ninetyDaysAgo),
  ]);

  // Build prompt and call AI
  const prompt = buildPredictionPrompt(
    diff,
    prFiles.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })),
    recentAlerts.map((a) => ({ title: a.title, severity: a.severity, aiReasoning: a.aiReasoning })),
    communityPatternsRaw,
    substrateCtx,
  );

  const raw = await callAI(
    aiKey.key,
    SYSTEM_PREDICTOR,
    [{ role: "user", content: prompt }],
    { maxTokens: 1500, timeout: 45000 },
  );

  // Parse AI response
  let result: PredictionResult;
  try {
    // Extract JSON from response (AI sometimes wraps in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch?.[0] ?? raw);
  } catch {
    result = { predictions: [], overallRisk: "low", summary: "Could not parse prediction." };
  }

  // Layer 3: Shadow execution with Substrate replay
  let shadowReplay: import("./shadow-replay").ShadowReplayResult | null = null;
  try {
    // Get the PR branch name
    const prInfo = await gh.getPRInfo(token, owner, repo, prNumber) as Record<string, unknown>;
    const head = prInfo.head as Record<string, unknown> | undefined;
    const branch = head?.ref as string | undefined;

    if (branch) {
      const { runShadowReplay } = await import("./shadow-replay");
      shadowReplay = await runShadowReplay({
        projectId,
        owner,
        repo,
        branch,
        prFiles: prFileNames,
        token,
      });
    }
  } catch {
    // Non-blocking — shadow replay is optional
  }

  return { result, patternMatches, shadowReplay };
}

/** Search community patterns related to PR files */
async function fetchCommunityPatterns(
  fileNames: string[],
): Promise<{ patternText: string; category: string; occurrenceCount: number; topFix: string | null }[]> {
  try {
    const searchTerm = fileNames.slice(0, 5).join(" ");
    if (searchTerm.length < 3) return [];

    const patterns = await db.execute(sql`
      SELECT ep.pattern_text, ep.category, ep.occurrence_count,
        (SELECT cf.fix_approach FROM community_fixes cf WHERE cf.pattern_id = ep.id ORDER BY cf.success_count DESC LIMIT 1) AS top_fix
      FROM error_patterns ep
      WHERE similarity(ep.pattern_text, ${searchTerm}) > 0.1
      ORDER BY ep.occurrence_count DESC
      LIMIT 10
    `);

    return (patterns.rows ?? []).map((r: Record<string, unknown>) => ({
      patternText: r.pattern_text as string,
      category: r.category as string,
      occurrenceCount: r.occurrence_count as number,
      topFix: r.top_fix as string | null,
    }));
  } catch {
    return []; // pg_trgm may not be available
  }
}

/** Fetch Substrate recording context for files being changed */
async function fetchSubstrateContext(
  projectId: string,
  fileNames: string[],
): Promise<string | null> {
  try {
    // Get latest recording for the project
    const [recording] = await db
      .select({ context: substrateRecordings.context })
      .from(substrateRecordings)
      .where(eq(substrateRecordings.projectId, projectId))
      .orderBy(desc(substrateRecordings.createdAt))
      .limit(1);

    return recording?.context ?? null;
  } catch {
    return null;
  }
}

/** Find error patterns that match recent alerts for this project */
async function findPatternMatches(
  projectId: string,
  since: Date,
): Promise<{ fingerprint: string; patternText: string; occurrenceCount: number; successRate: number }[]> {
  try {
    // Get fingerprints from recent alerts
    const recentFingerprints = await db
      .select({ fingerprint: alerts.fingerprint })
      .from(alerts)
      .where(and(
        eq(alerts.projectId, projectId),
        sql`${alerts.createdAt} > ${since.toISOString()}`,
        sql`${alerts.fingerprint} IS NOT NULL`,
      ))
      .limit(20);

    const fps = recentFingerprints
      .map((r) => r.fingerprint)
      .filter((fp): fp is string => !!fp);

    if (fps.length === 0) return [];

    // Look up patterns and their community fixes
    const patterns = await db
      .select()
      .from(errorPatterns)
      .where(inArray(errorPatterns.fingerprint, fps))
      .limit(10);

    const results: { fingerprint: string; patternText: string; occurrenceCount: number; successRate: number }[] = [];

    for (const p of patterns) {
      const [fix] = await db
        .select()
        .from(communityFixes)
        .where(eq(communityFixes.patternId, p.id))
        .orderBy(desc(communityFixes.successCount))
        .limit(1);

      const successRate = fix && fix.totalApplications > 0
        ? Math.round((fix.successCount / fix.totalApplications) * 100)
        : 0;

      results.push({
        fingerprint: p.fingerprint,
        patternText: p.patternText,
        occurrenceCount: p.occurrenceCount,
        successRate,
      });
    }

    return results;
  } catch {
    return [];
  }
}
