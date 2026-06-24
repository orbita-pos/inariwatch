/**
 * GET /api/desktop/alert/[id]/timeline
 *
 * Returns a unified chronological feed for the Inari Live desktop's
 * AlertDetailPanel (`Cmd+\` sidecar). Aggregates four sources into a
 * single sorted array:
 *
 *   - Alert birth     ("Alert fired" — from alerts.createdAt)
 *   - Comments        (alert_comments)
 *   - Remediations    (remediation_sessions — diagnose / PR opened / merged / completed)
 *   - State changes   (audit_logs entries for ack / silence / resolve / reopen / escalate)
 *
 * Response shape is a flat array of typed events. The panel renders
 * each by `kind`. We cap at 50 items so a long-running incident
 * doesn't return megabytes.
 *
 * Auth: same as `/api/desktop/alerts` — extension Bearer token.
 *
 * Returns 404 when the alert doesn't exist OR isn't accessible by
 * the authed user's project set.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, alerts, alertComments, remediationSessions, auditLogs, users } from "@/lib/db";
import { and, eq, inArray, asc, or, desc } from "drizzle-orm";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";

const TIMELINE_CAP = 50;

export interface TimelineEvent {
  /** Stable key for React lists; not a DB id. */
  id: string;
  /** Discriminates the renderer. */
  kind:
    | "alert_fired"
    | "comment"
    | "remediation_started"
    | "remediation_pr_opened"
    | "remediation_merged"
    | "remediation_completed"
    | "remediation_failed"
    | "ack"
    | "silence"
    | "resolve"
    | "reopen"
    | "escalate";
  /** ISO-8601. The panel sorts client-side too, but the server returns sorted asc. */
  at: string;
  /** Short human description, already formatted. */
  text: string;
  /** Witness receipt id when applicable (remediation_*), null otherwise. */
  witness?: string | null;
  /** Actor — userName, "Inari", or system. */
  actor?: string | null;
  /** Free-form extras the renderer may use (PR url, severity, etc.). */
  meta?: Record<string, unknown>;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const { id } = await ctx.params;

  // Authorize: alert must belong to one of the bearer's accessible projects.
  const [alert] = await db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      title: alerts.title,
      createdAt: alerts.createdAt,
      severity: alerts.severity,
    })
    .from(alerts)
    .where(eq(alerts.id, id))
    .limit(1);
  if (!alert || !auth.projectIds.includes(alert.projectId)) {
    return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  }

  // Fan out the 3 queries in parallel — none depend on each other.
  // We then merge + sort + cap server-side. Cheap join-by-userId on
  // comments to denormalize the actor name; audit_logs already carries
  // its actor in metadata.
  const [comments, remediations, audits] = await Promise.all([
    db
      .select({
        id: alertComments.id,
        body: alertComments.body,
        createdAt: alertComments.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(alertComments)
      .innerJoin(users, eq(alertComments.userId, users.id))
      .where(eq(alertComments.alertId, id))
      .orderBy(asc(alertComments.createdAt))
      .limit(TIMELINE_CAP),
    db
      .select({
        id: remediationSessions.id,
        status: remediationSessions.status,
        createdAt: remediationSessions.createdAt,
        prUrl: remediationSessions.prUrl,
        prNumber: remediationSessions.prNumber,
        proposedAt: remediationSessions.proposedAt,
        mergedCommitSha: remediationSessions.mergedCommitSha,
        error: remediationSessions.error,
      })
      .from(remediationSessions)
      .where(eq(remediationSessions.alertId, id))
      .orderBy(asc(remediationSessions.createdAt))
      .limit(TIMELINE_CAP),
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        userName: users.name,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(
        and(
          // Audit log schema: `resource` + `resourceId`, actions are
          // dotted (`alert.ack`, `alert.resolve`, ...).
          eq(auditLogs.resource, "alert"),
          eq(auditLogs.resourceId, id),
          inArray(auditLogs.action, [
            "alert.ack",
            "alert.silence",
            "alert.unsilence",
            "alert.resolve",
            "alert.reopen",
            "alert.escalate",
          ]),
        ),
      )
      .orderBy(asc(auditLogs.createdAt))
      .limit(TIMELINE_CAP),
  ]);

  const events: TimelineEvent[] = [];

  // 1. Alert fired — synthetic, derived from alerts.createdAt.
  events.push({
    id: `fired:${alert.id}`,
    kind: "alert_fired",
    at: alert.createdAt.toISOString(),
    text: "Alert fired · first event detected",
    actor: "system",
    meta: { severity: alert.severity },
  });

  // 2. Comments
  for (const c of comments) {
    events.push({
      id: `cmt:${c.id}`,
      kind: "comment",
      at: c.createdAt.toISOString(),
      text: c.body,
      actor: c.userName ?? c.userEmail ?? "user",
    });
  }

  // 3. Remediations — emit multiple events per session as it progresses.
  for (const r of remediations) {
    events.push({
      id: `rem-start:${r.id}`,
      kind: "remediation_started",
      at: r.createdAt.toISOString(),
      text: "Inari started diagnosis",
      actor: "Inari",
      witness: `w_rem_${r.id.slice(0, 8)}`,
      meta: { sessionId: r.id },
    });
    if (r.prUrl && r.prNumber) {
      // proposedAt is the moment the PR was actually opened. Falls back
      // to createdAt if the column is null (legacy rows).
      const prAt = r.proposedAt ?? r.createdAt;
      events.push({
        id: `rem-pr:${r.id}`,
        kind: "remediation_pr_opened",
        at: prAt.toISOString(),
        text: `Inari opened PR #${r.prNumber} · awaiting CI`,
        actor: "Inari",
        witness: `w_pr_${r.id.slice(0, 8)}`,
        meta: { prUrl: r.prUrl, prNumber: r.prNumber, sessionId: r.id },
      });
    }
    if (r.mergedCommitSha) {
      events.push({
        id: `rem-merged:${r.id}`,
        kind: "remediation_merged",
        at: r.createdAt.toISOString(), // best-effort; no merge ts column on session
        text: `PR merged · commit ${r.mergedCommitSha.slice(0, 7)}`,
        actor: "Inari",
        witness: `w_merge_${r.id.slice(0, 8)}`,
        meta: { commitSha: r.mergedCommitSha, sessionId: r.id },
      });
    }
    if (r.status === "completed") {
      events.push({
        id: `rem-done:${r.id}`,
        kind: "remediation_completed",
        at: r.createdAt.toISOString(),
        text: "Remediation completed",
        actor: "Inari",
        witness: `w_done_${r.id.slice(0, 8)}`,
        meta: { sessionId: r.id },
      });
    }
    if (r.status === "failed" && r.error) {
      events.push({
        id: `rem-fail:${r.id}`,
        kind: "remediation_failed",
        at: r.createdAt.toISOString(),
        text: `Remediation failed — ${r.error.slice(0, 120)}`,
        actor: "Inari",
        meta: { sessionId: r.id, error: r.error },
      });
    }
  }

  // 4. State changes from audit log. Dotted actions → bare kind.
  for (const a of audits) {
    const bare = a.action.replace(/^alert\./, "");
    const kindMap: Record<string, TimelineEvent["kind"] | undefined> = {
      ack: "ack",
      silence: "silence",
      resolve: "resolve",
      reopen: "reopen",
      escalate: "escalate",
    };
    const k = kindMap[bare];
    if (!k) continue;
    const reason =
      a.metadata && typeof a.metadata === "object" && "reason" in a.metadata
        ? String((a.metadata as { reason?: unknown }).reason ?? "")
        : "";
    const label =
      k === "ack" ? "Acknowledged" :
      k === "silence" ? "Silenced" :
      k === "resolve" ? "Resolved" :
      k === "reopen" ? "Reopened" :
      "Escalated";
    events.push({
      id: `audit:${a.id}`,
      kind: k,
      at: a.createdAt.toISOString(),
      text: reason ? `${label} — ${reason}` : label,
      actor: a.userName ?? "user",
    });
  }

  // Sort ascending and cap. The panel renders newest-first but the
  // wire order is ascending for cheaper merging on the client when
  // SSE pushes incremental events later.
  events.sort((a, b) => a.at.localeCompare(b.at));
  const capped = events.slice(-TIMELINE_CAP);

  return NextResponse.json({ events: capped });
}
