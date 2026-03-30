"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, remediationSessions, alerts, projects, projectIntegrations } from "@/lib/db";
import { eq, and, inArray, gte, sql, isNotNull } from "drizzle-orm";
import type { AutoMergeConfig } from "@/lib/db/schema";
import { DEFAULT_AUTO_MERGE_CONFIG } from "@/lib/db/schema";
import { decryptConfig } from "@/lib/crypto";
import * as gh from "@/lib/services/github-api";
import { logAudit } from "@/lib/audit";
import { generatePostmortem } from "@/lib/ai/postmortem";
import { contributeApprovedFix } from "@/lib/ai/contribute-fix";

/**
 * Start a new remediation session for an alert.
 */
export async function startRemediation(
  alertId: string
): Promise<{ sessionId?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  // Load alert + verify ownership
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return { error: "Alert not found" };

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return { error: "Unauthorized" };

  // Check for an already active session
  const [existing] = await db
    .select({ id: remediationSessions.id, status: remediationSessions.status })
    .from(remediationSessions)
    .where(and(
      eq(remediationSessions.alertId, alertId),
      inArray(remediationSessions.status, ["analyzing", "reading_code", "generating_fix", "pushing", "awaiting_ci", "proposing"])
    ))
    .limit(1);

  if (existing) {
    return { sessionId: existing.id };
  }

  // Create session
  const [newSession] = await db
    .insert(remediationSessions)
    .values({
      alertId,
      projectId: alert.projectId,
      userId,
      status: "analyzing",
      attempt: 1,
      maxAttempts: 3,
      steps: [],
    })
    .returning();

  logAudit({
    userId,
    action: "remediation.start",
    resource: "alert",
    resourceId: alertId,
  });

  return { sessionId: newSession.id };
}

/**
 * Approve and merge the fix PR.
 */
export async function approveRemediation(
  sessionId: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const [remSession] = await db
    .select()
    .from(remediationSessions)
    .where(and(eq(remediationSessions.id, sessionId), eq(remediationSessions.userId, userId)))
    .limit(1);

  if (!remSession) return { error: "Session not found" };
  if (remSession.status !== "proposing") return { error: "Session is not in proposing state" };
  if (!remSession.prNumber || !remSession.repo) return { error: "No PR to merge" };

  // Get GitHub token
  const integrations = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      eq(projectIntegrations.projectId, remSession.projectId),
      eq(projectIntegrations.service, "github")
    ))
    .limit(1);

  const ghInteg = integrations[0];
  if (!ghInteg) return { error: "GitHub integration not found" };

  const config = decryptConfig(ghInteg.configEncrypted);
  const token = config.token as string;
  const [owner, repo] = remSession.repo.split("/");

  try {
    await db
      .update(remediationSessions)
      .set({ status: "merging", updatedAt: new Date() })
      .where(eq(remediationSessions.id, sessionId));

    await gh.mergePR(token, owner, repo, remSession.prNumber);

    await db
      .update(remediationSessions)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(remediationSessions.id, sessionId));

    // Auto-resolve the alert
    await db
      .update(alerts)
      .set({ isResolved: true, resolvedAt: new Date() })
      .where(eq(alerts.id, remSession.alertId));

    // Fire-and-forget: generate post-mortem
    generatePostmortem(remSession.alertId, userId).catch(() => {});

    logAudit({
      userId,
      action: "remediation.approve",
      resource: "alert",
      resourceId: remSession.alertId,
      metadata: { prUrl: remSession.prUrl, prNumber: remSession.prNumber },
    });

    // Check if this project qualifies for autonomous mode suggestion
    checkAndSuggestAutonomous(remSession.projectId).catch(() => {});
    // Auto-tune confidence threshold based on approval history
    checkAndTuneConfidence(remSession.projectId).catch(() => {});
    // Contribute anonymized fix to community network
    contributeApprovedFix(sessionId, remSession.alertId).catch(() => {});

    return {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Merge failed";
    await db
      .update(remediationSessions)
      .set({ status: "failed", error: msg, updatedAt: new Date() })
      .where(eq(remediationSessions.id, sessionId));
    return { error: msg };
  }
}

/**
 * Cancel an active remediation session.
 */
export async function cancelRemediation(
  sessionId: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const [cancelled] = await db
    .update(remediationSessions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(remediationSessions.id, sessionId), eq(remediationSessions.userId, userId)))
    .returning({ projectId: remediationSessions.projectId });

  logAudit({
    userId,
    action: "remediation.cancel",
    resource: "remediation_session",
    resourceId: sessionId,
  });

  if (cancelled) {
    checkAndTuneConfidence(cancelled.projectId).catch(() => {});
  }

  return {};
}

// ── Autonomous mode suggestion ────────────────────────────────────────────────

const SUGGEST_MIN_REMEDIATIONS = 5;
const SUGGEST_MIN_APPROVAL_RATE = 90; // %
const SUGGEST_WINDOW_DAYS = 30;

async function checkAndSuggestAutonomous(projectId: string) {
  const [project] = await db
    .select({ autoMergeConfig: projects.autoMergeConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return;

  const config = { ...DEFAULT_AUTO_MERGE_CONFIG, ...(project.autoMergeConfig as AutoMergeConfig ?? {}) };

  // Skip if autonomous mode already on or already suggested
  if (config.autoRemediate || config.suggestAutonomous) return;

  const since = new Date();
  since.setDate(since.getDate() - SUGGEST_WINDOW_DAYS);

  const [stats] = await db
    .select({
      total:    sql<number>`count(*)`,
      approved: sql<number>`count(*) filter (where status = 'completed')`,
    })
    .from(remediationSessions)
    .where(and(
      eq(remediationSessions.projectId, projectId),
      gte(remediationSessions.createdAt, since),
      inArray(remediationSessions.status, ["completed", "cancelled", "failed"]),
    ));

  const total = Number(stats?.total ?? 0);
  const approved = Number(stats?.approved ?? 0);
  if (total < SUGGEST_MIN_REMEDIATIONS) return;

  const approvalRate = Math.round((approved / total) * 100);
  if (approvalRate < SUGGEST_MIN_APPROVAL_RATE) return;

  await db
    .update(projects)
    .set({ autoMergeConfig: { ...config, suggestAutonomous: true } as AutoMergeConfig })
    .where(eq(projects.id, projectId));
}

// ── Auto-confidence tuning ────────────────────────────────────────────────────

const TUNE_MIN_SESSIONS   = 8;
const TUNE_MIN_DELTA      = 5;   // only adjust if change >= 5 points
const TUNE_CONF_FLOOR     = 55;
const TUNE_CONF_CAP       = 95;
const TUNE_WINDOW_DAYS    = 30;

async function checkAndTuneConfidence(projectId: string) {
  const [project] = await db
    .select({ autoMergeConfig: projects.autoMergeConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return;

  const config = { ...DEFAULT_AUTO_MERGE_CONFIG, ...(project.autoMergeConfig as AutoMergeConfig ?? {}) };
  if (!config.enabled) return;

  const since = new Date();
  since.setDate(since.getDate() - TUNE_WINDOW_DAYS);

  const sessions = await db
    .select({
      status:     remediationSessions.status,
      confidence: remediationSessions.confidenceScore,
    })
    .from(remediationSessions)
    .where(and(
      eq(remediationSessions.projectId, projectId),
      gte(remediationSessions.createdAt, since),
      inArray(remediationSessions.status, ["completed", "cancelled"]),
      isNotNull(remediationSessions.confidenceScore),
    ));

  if (sessions.length < TUNE_MIN_SESSIONS) return;

  const approved  = sessions.filter(s => s.status === "completed").map(s => Number(s.confidence));
  const cancelled = sessions.filter(s => s.status === "cancelled").map(s => Number(s.confidence));

  if (approved.length < 3) return;

  const approvalRate    = approved.length / sessions.length;
  const currentThreshold = config.minConfidence;
  let newThreshold       = currentThreshold;

  if (approvalRate >= 0.8) {
    // High approval rate: can safely lower the threshold
    const minApproved = Math.min(...approved);
    const candidate   = Math.max(TUNE_CONF_FLOOR, Math.round(minApproved) - 3);
    if (candidate <= currentThreshold - TUNE_MIN_DELTA) {
      newThreshold = candidate;
    }
  } else if (approvalRate < 0.5 && cancelled.length >= 3) {
    // Low approval rate: raise the threshold
    const sorted   = [...cancelled].sort((a, b) => a - b);
    const median   = sorted[Math.floor(sorted.length / 2)];
    const candidate = Math.min(TUNE_CONF_CAP, Math.round(median) + 5);
    if (candidate >= currentThreshold + TUNE_MIN_DELTA) {
      newThreshold = candidate;
    }
  }

  if (newThreshold === currentThreshold) return;

  await db
    .update(projects)
    .set({
      autoMergeConfig: {
        ...config,
        minConfidence:     newThreshold,
        confidenceTunedAt:   new Date().toISOString(),
        confidenceTunedFrom: currentThreshold,
      } as AutoMergeConfig,
    })
    .where(eq(projects.id, projectId));
}
