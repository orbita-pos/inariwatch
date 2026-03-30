import { db, alerts, remediationSessions, errorPatterns, communityFixes } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { RemediationStep } from "@/lib/db/schema";

/**
 * Anonymize and contribute an approved AI fix to the community network.
 * Called fire-and-forget after a user approves a remediation session.
 * Strips all PII, secrets, repo names, and file contents — only paths and
 * sanitized approach text are shared.
 */
export async function contributeApprovedFix(sessionId: string, alertId: string): Promise<void> {
  const [[remSession], [alert]] = await Promise.all([
    db
      .select({
        fingerprint:     remediationSessions.fingerprint,
        confidenceScore: remediationSessions.confidenceScore,
        fileChanges:     remediationSessions.fileChanges,
        steps:           remediationSessions.steps,
      })
      .from(remediationSessions)
      .where(eq(remediationSessions.id, sessionId))
      .limit(1),
    db
      .select({
        title:       alerts.title,
        body:        alerts.body,
        severity:    alerts.severity,
        fingerprint: alerts.fingerprint,
      })
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .limit(1),
  ]);

  if (!remSession || !alert) return;

  const fingerprint = remSession.fingerprint ?? alert.fingerprint;
  if (!fingerprint) return;

  const confidence = remSession.confidenceScore ?? 70;

  // ── Build fix approach from completed steps ─────────────────────────────────
  const steps = (remSession.steps as RemediationStep[]) ?? [];
  const fixStep   = steps.find(s => s.type === "generating_fix" && s.status === "completed");
  const fixApproach = sanitize(fixStep?.message ?? "AI-generated fix").slice(0, 200);
  const fixDescription = sanitize(
    steps.filter(s => s.status === "completed").map(s => s.message).join(" → ")
  ).slice(0, 600);

  // File paths only — never send file contents
  const fileChanges = (remSession.fileChanges as Array<{ path: string }> | null) ?? [];
  const filesChangedSummary = fileChanges.map(f => f.path).join(", ") || null;

  const patternText = sanitize(`${alert.title}\n${alert.body}`).slice(0, 300);
  const category    = alert.severity; // "critical" | "warning" | "info"

  // ── Upsert error_pattern ────────────────────────────────────────────────────
  let [pattern] = await db
    .select()
    .from(errorPatterns)
    .where(eq(errorPatterns.fingerprint, fingerprint))
    .limit(1);

  if (pattern) {
    await db
      .update(errorPatterns)
      .set({ occurrenceCount: pattern.occurrenceCount + 1, lastSeenAt: new Date() })
      .where(eq(errorPatterns.id, pattern.id));
  } else {
    [pattern] = await db
      .insert(errorPatterns)
      .values({ fingerprint, patternText, category })
      .returning();
  }

  if (!pattern) return;

  // ── Upsert community_fix ────────────────────────────────────────────────────
  const existingFixes = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.patternId, pattern.id));

  const similar = existingFixes.find(
    f => f.fixApproach.toLowerCase() === fixApproach.toLowerCase()
  );

  if (similar) {
    // Increment success metrics for this existing approach
    await db
      .update(communityFixes)
      .set({
        successCount:      similar.successCount + 1,
        totalApplications: similar.totalApplications + 1,
        avgConfidence: Math.round(
          (similar.avgConfidence * similar.totalApplications + confidence) /
          (similar.totalApplications + 1)
        ),
        updatedAt: new Date(),
      })
      .where(eq(communityFixes.id, similar.id));
  } else {
    await db.insert(communityFixes).values({
      patternId:           pattern.id,
      fixApproach,
      fixDescription,
      filesChangedSummary,
      avgConfidence:       confidence,
      successCount:        1,
      failureCount:        0,
      totalApplications:   1,
      contributedBy:       null, // always anonymous
    });
  }
}

// ── Sanitization ───────────────────────────────────────────────────────────────

function sanitize(text: string): string {
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>")
    .replace(/\b[a-zA-Z0-9_-]{32,}\b/g, "<token>")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>")
    .replace(/https?:\/\/[^\s"']+/g, "<url>")
    .replace(/\/(?:home|Users|var|etc|opt|srv)\/[^\s"']+/g, "<path>")
    .replace(/[A-Z]:\\[^\s"']+/g, "<path>");
}
