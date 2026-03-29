/**
 * Post-merge monitoring.
 *
 * After an auto-merge, watches for 10 minutes to detect regressions.
 * If the same error recurs or uptime drops, auto-reverts the merge.
 */

import { db, remediationSessions, alerts, errorPatterns, communityFixes, projectIntegrations, uptimeMonitors } from "@/lib/db";
import { eq, and, gt, desc, sql } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import * as gh from "@/lib/services/github-api";
import { createAlertIfNew } from "@/lib/webhooks/shared";
import { resolveIncident, regressIncident } from "./status-page-automation";
import { triggerEscalation } from "./escalation-engine";

type Emit = (event: string, data: unknown) => void;

const MONITOR_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 60 * 1000;          // 1 minute

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkSentryForRegression(
  projectId: string,
  mergeTime: Date,
  alertTitle: string
): Promise<boolean> {
  const sentryInteg = await db.select().from(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.service, "sentry")))
    .limit(1);

  if (sentryInteg.length === 0) return false;

  const config = decryptConfig(sentryInteg[0].configEncrypted);
  const token = config.token as string;
  const org = config.org as string;
  if (!token || !org) return false;

  try {
    const since = mergeTime.toISOString();
    const res = await fetch(
      `https://sentry.io/api/0/organizations/${org}/issues/?query=firstSeen%3A%3E${encodeURIComponent(since)}&limit=10`,
      { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 0 } }
    );
    if (!res.ok) return false;
    const issues = await res.json() as { title: string; isRegression?: boolean }[];

    // Check if any new issue matches the original error pattern
    const normalizedTitle = alertTitle.replace(/\[.*?\]\s*/, "").toLowerCase();
    for (const issue of issues) {
      if (issue.title.toLowerCase().includes(normalizedTitle.slice(0, 40)) || issue.isRegression) {
        return true; // Regression detected
      }
    }
  } catch { /* ignore */ }

  return false;
}

async function checkUptimeForRegression(projectId: string): Promise<boolean> {
  try {
    const monitors = await db.select().from(uptimeMonitors)
      .where(and(eq(uptimeMonitors.projectId, projectId), eq(uptimeMonitors.isActive, true)));

    for (const monitor of monitors.slice(0, 3)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(monitor.url, {
          method: "GET",
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);
        if (res.status >= 500) return true; // Server error = regression
      } catch {
        return true; // Can't reach = regression
      }
    }
  } catch { /* ignore */ }

  return false;
}

export async function startPostMergeMonitoring(params: {
  sessionId: string;
  projectId: string;
  mergedCommitSha: string;
  alertTitle: string;
  repo: string;       // "owner/repo"
  defaultBranch: string;
  ghToken: string;
  emit: Emit;
  /** Error fingerprint for outcome tracking */
  fingerprint?: string;
}): Promise<void> {
  const { sessionId, projectId, mergedCommitSha, alertTitle, repo, defaultBranch, ghToken, emit, fingerprint } = params;
  const [owner, repoName] = repo.split("/");
  const mergeTime = new Date();
  const monitorUntil = new Date(Date.now() + MONITOR_DURATION_MS);

  await db.update(remediationSessions).set({
    monitoringStatus: "watching",
    monitoringUntil: monitorUntil,
    mergedCommitSha,
    updatedAt: new Date(),
  }).where(eq(remediationSessions.id, sessionId));

  emit("status", { status: "monitoring" });
  emit("monitoring_poll", { elapsed: 0, total: MONITOR_DURATION_MS / 1000, status: "watching" });

  let elapsed = 0;
  while (elapsed < MONITOR_DURATION_MS) {
    await sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;

    // Check for regressions
    const sentryRegression = await checkSentryForRegression(projectId, mergeTime, alertTitle);
    const uptimeRegression = await checkUptimeForRegression(projectId);

    // Also check if same fingerprint alert was ingested since merge
    let fingerprintRegression = false;
    if (fingerprint && !sentryRegression) {
      try {
        const recurred = await db.select({ id: alerts.id }).from(alerts)
          .where(and(
            eq(alerts.projectId, projectId),
            eq(alerts.fingerprint, fingerprint),
            gt(alerts.createdAt, mergeTime),
          ))
          .limit(1);
        fingerprintRegression = recurred.length > 0;
      } catch { /* ignore */ }
    }

    emit("monitoring_poll", {
      elapsed: Math.round(elapsed / 1000),
      total: Math.round(MONITOR_DURATION_MS / 1000),
      status: "watching",
      checks: {
        sentry: sentryRegression ? "regression" : "ok",
        uptime: uptimeRegression ? "down" : "ok",
      },
    });

    if (sentryRegression || uptimeRegression || fingerprintRegression) {
      // Regression detected — auto-revert
      emit("monitoring_poll", { elapsed: Math.round(elapsed / 1000), total: Math.round(MONITOR_DURATION_MS / 1000), status: "reverting" });

      try {
        const revertPr = await gh.createPR(
          ghToken, owner, repoName,
          `revert: auto-revert fix for "${alertTitle.slice(0, 50)}"`,
          [
            `## Auto-revert by Inari AI`,
            ``,
            `The auto-merged fix (${mergedCommitSha.slice(0, 7)}) caused a regression:`,
            sentryRegression ? `- Sentry: Same error pattern reappeared after merge` : "",
            uptimeRegression ? `- Uptime: Service returned 5xx or became unreachable` : "",
            ``,
            `This PR reverts the changes. The original alert has been reopened.`,
            ``,
            `*Auto-reverted by [Inari AI](https://inariwatch.com) post-merge monitoring*`,
          ].filter(Boolean).join("\n"),
          `revert-${mergedCommitSha.slice(0, 8)}`,
          defaultBranch,
          false // not draft — auto-merge the revert too
        );

        // Try to merge the revert PR immediately
        try {
          await gh.mergePR(ghToken, owner, repoName, revertPr.number);
        } catch { /* if merge fails, at least the revert PR exists */ }

        await db.update(remediationSessions).set({
          monitoringStatus: "reverted",
          revertPrUrl: revertPr.url,
          status: "failed",
          error: `Auto-reverted: ${sentryRegression ? "error reappeared in Sentry" : "uptime regression detected"}`,
          updatedAt: new Date(),
        }).where(eq(remediationSessions.id, sessionId));

        // Create an alert about the revert
        await createAlertIfNew({
          severity: "critical",
          title: `[Auto-Revert] Fix for "${alertTitle.slice(0, 50)}" was reverted`,
          body: `The AI auto-merged fix (${mergedCommitSha.slice(0, 7)}) caused a regression and was automatically reverted.\n\nReason: ${sentryRegression ? "Same error pattern reappeared in Sentry" : "Service uptime dropped"}\n\nRevert PR: ${revertPr.url}`,
          sourceIntegrations: ["github"],
          isRead: false,
          isResolved: false,
        }, projectId);

        // Regress the status page incident
        try {
          await regressIncident({
            remediationSessionId: sessionId,
            reason: sentryRegression ? "Same error pattern reappeared in Sentry" : "Service uptime dropped",
          });
        } catch { /* non-blocking */ }

        // Escalate: regression after merge
        try {
          await triggerEscalation({
            alertId: (await db.select({ alertId: remediationSessions.alertId }).from(remediationSessions).where(eq(remediationSessions.id, sessionId)).limit(1))[0]?.alertId ?? "",
            projectId,
            reason: "regression_after_merge",
            diagnosis: sentryRegression ? "Same error pattern reappeared in Sentry after merge" : "Service uptime dropped after merge",
          });
        } catch { /* non-blocking */ }

        emit("auto_revert", {
          reason: sentryRegression ? "Sentry regression" : "Uptime regression",
          revertPrUrl: revertPr.url,
        });
        emit("done", { status: "failed", error: "Auto-reverted due to regression" });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Revert failed";
        emit("auto_revert", { reason: "Regression detected but revert failed", error: msg });
        await db.update(remediationSessions).set({
          monitoringStatus: "reverted",
          status: "failed",
          error: `Regression detected but auto-revert failed: ${msg}`,
          updatedAt: new Date(),
        }).where(eq(remediationSessions.id, sessionId));
        emit("done", { status: "failed", error: `Regression detected but revert failed: ${msg}` });
        return;
      }
    }
  }

  // Monitoring passed — no regressions
  await db.update(remediationSessions).set({
    monitoringStatus: "passed",
    status: "completed",
    updatedAt: new Date(),
  }).where(eq(remediationSessions.id, sessionId));

  // Verify pending predictions for this project
  try {
    const { verifyPendingPredictions } = await import("./prediction-feedback");
    const predResults = await verifyPendingPredictions(projectId, mergeTime);
    if (predResults.verified > 0) {
      emit("prediction_verified", {
        verified: predResults.verified,
        correct: predResults.correct,
        falsePositive: predResults.falsePositive,
      });
    }
  } catch {
    // Non-blocking
  }

  // Report success to community patterns (boost the fix's success count)
  if (fingerprint) {
    try {
      const pattern = await db.select({ id: errorPatterns.id }).from(errorPatterns)
        .where(eq(errorPatterns.fingerprint, fingerprint)).limit(1);
      if (pattern.length > 0) {
        const topFix = await db.select({ id: communityFixes.id }).from(communityFixes)
          .where(eq(communityFixes.patternId, pattern[0].id))
          .orderBy(desc(communityFixes.successCount)).limit(1);
        if (topFix.length > 0) {
          await db.update(communityFixes).set({
            successCount: sql`${communityFixes.successCount} + 1`,
            totalApplications: sql`${communityFixes.totalApplications} + 1`,
            updatedAt: new Date(),
          }).where(eq(communityFixes.id, topFix[0].id));
        }
      }
    } catch { /* non-blocking */ }
  }

  // Resolve the status page incident
  try { await resolveIncident({ remediationSessionId: sessionId }); } catch { /* non-blocking */ }

  emit("monitoring_result", { status: "passed", duration: Math.round(MONITOR_DURATION_MS / 1000) });
  emit("done", { status: "completed" });
}
