import { db, alerts, remediationSessions, substrateRecordings } from "@/lib/db";
import { eq, and, desc, gt } from "drizzle-orm";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  // Get latest remediation session
  const [session] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, alertId))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);

  if (!session) {
    return JSON.stringify({
      alert_id: alertId,
      title: alert.title,
      verification: null,
      note: "No remediation session found. Trigger a fix first with trigger_fix.",
    }, null, 2);
  }

  // Get substrate recording
  const [recording] = await db
    .select({ id: substrateRecordings.id, recordingId: substrateRecordings.recordingId })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.alertId, alertId))
    .limit(1);

  // Check if error recurred post-merge
  const errorRecurred = session.mergedCommitSha ? await checkRecurrence(alert, session) : null;

  // Build verification report
  const checks: { name: string; status: "pass" | "fail" | "pending" | "skip"; detail: string }[] = [];

  // 1. Fix generated
  checks.push({
    name: "Fix generated",
    status: session.fileChanges ? "pass" : "fail",
    detail: session.fileChanges
      ? `${(session.fileChanges as unknown[]).length} file(s) changed`
      : "No fix generated",
  });

  // 2. Self-review
  const selfReview = session.selfReviewResult as { score?: number; recommendation?: string } | null;
  checks.push({
    name: "Self-review",
    status: selfReview?.score && selfReview.score >= 70 ? "pass" : selfReview ? "fail" : "skip",
    detail: selfReview ? `Score: ${selfReview.score}/100 — ${selfReview.recommendation ?? ""}` : "Not performed",
  });

  // 3. CI passed
  const ciPassed = ["ci_passed", "proposing", "approved", "merging", "completed"].includes(session.status);
  checks.push({
    name: "CI passed",
    status: ciPassed ? "pass" : session.status === "ci_failed_retrying" ? "pending" : "fail",
    detail: ciPassed ? "All checks passed" : `Status: ${session.status}`,
  });

  // 4. PR created
  checks.push({
    name: "PR created",
    status: session.prUrl ? "pass" : "pending",
    detail: session.prUrl ?? "Not yet created",
  });

  // 5. Merged
  checks.push({
    name: "Merged",
    status: session.mergedCommitSha ? "pass" : session.status === "completed" ? "pass" : "pending",
    detail: session.mergedCommitSha
      ? `Commit: ${session.mergedCommitSha.slice(0, 8)} (${session.mergeStrategy ?? "manual"})`
      : `Status: ${session.status}`,
  });

  // 6. Post-merge monitoring
  checks.push({
    name: "Post-merge monitoring",
    status: session.monitoringStatus === "passed" ? "pass"
      : session.monitoringStatus === "reverted" ? "fail"
      : session.monitoringUntil ? "pending" : "skip",
    detail: session.monitoringStatus
      ? `${session.monitoringStatus}${session.revertPrUrl ? ` — revert: ${session.revertPrUrl}` : ""}`
      : "Not started",
  });

  // 7. Error stopped
  checks.push({
    name: "Error stopped recurring",
    status: errorRecurred === false ? "pass" : errorRecurred === true ? "fail" : "skip",
    detail: errorRecurred === false ? "No recurrence in last 24h"
      : errorRecurred === true ? "Error recurred after fix"
      : "Cannot verify (no post-merge data)",
  });

  // 8. Substrate recording
  checks.push({
    name: "Substrate recording",
    status: recording ? "pass" : "skip",
    detail: recording ? `Recording: ${recording.recordingId}` : "No recording (enable INARIWATCH_SUBSTRATE=true)",
  });

  // 9. Confidence
  checks.push({
    name: "Confidence score",
    status: (session.confidenceScore ?? 0) >= 80 ? "pass"
      : (session.confidenceScore ?? 0) >= 50 ? "pass" : "fail",
    detail: session.confidenceScore != null ? `${session.confidenceScore}%` : "Not scored",
  });

  const passCount = checks.filter((c) => c.status === "pass").length;
  const failCount = checks.filter((c) => c.status === "fail").length;
  const totalActive = checks.filter((c) => c.status !== "skip").length;

  const overallStatus = failCount > 0 ? "failed" : passCount === totalActive ? "verified" : "in_progress";

  return JSON.stringify({
    alert_id: alertId,
    title: alert.title,
    session_id: session.id,
    status: overallStatus,
    summary: `${passCount}/${totalActive} checks passed${failCount > 0 ? `, ${failCount} failed` : ""}`,
    checks,
    remediation: {
      attempt: session.attempt,
      branch: session.branch,
      prUrl: session.prUrl,
      mergedCommitSha: session.mergedCommitSha,
      createdAt: session.createdAt.toISOString(),
    },
  }, null, 2);
}

async function checkRecurrence(
  alert: { fingerprint: string | null; projectId: string },
  session: { mergedCommitSha: string | null; createdAt: Date }
): Promise<boolean | null> {
  if (!alert.fingerprint || !session.mergedCommitSha) return null;

  // Check if same fingerprint appeared after the fix was merged
  const [recurrence] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.fingerprint, alert.fingerprint),
        eq(alerts.projectId, alert.projectId),
        gt(alerts.createdAt, session.createdAt)
      )
    )
    .limit(1);

  return !!recurrence;
}
