/**
 * Status page automation — auto-create/update/resolve incidents
 * as alerts flow through the remediation pipeline.
 */

import {
  db,
  statusPages,
  statusPageIncidents,
  statusPageUpdates,
  statusPageSubscribers,
  type StatusPageConfig,
  DEFAULT_STATUS_PAGE_CONFIG,
} from "@/lib/db";
import { eq, and } from "drizzle-orm";

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };

function meetsSeverityThreshold(alertSeverity: string, minSeverity: string): boolean {
  return (SEVERITY_RANK[alertSeverity] ?? 3) <= (SEVERITY_RANK[minSeverity] ?? 3);
}

function alertSeverityToIncidentSeverity(alertSeverity: string): string {
  if (alertSeverity === "critical") return "critical";
  if (alertSeverity === "warning" || alertSeverity === "error") return "major";
  return "minor";
}

// ── Find status page for a project ────────────────────────────────────────────

async function getStatusPageWithConfig(projectId: string) {
  const [page] = await db
    .select()
    .from(statusPages)
    .where(and(eq(statusPages.projectId, projectId), eq(statusPages.isPublic, true)))
    .limit(1);

  if (!page) return null;

  const config: StatusPageConfig = {
    ...DEFAULT_STATUS_PAGE_CONFIG,
    ...(page.config as StatusPageConfig | null),
  };

  return { page, config };
}

// ── Create incident ───────────────────────────────────────────────────────────

export async function autoCreateIncident(params: {
  projectId: string;
  alertId: string;
  alertTitle: string;
  alertSeverity: string;
}): Promise<string | null> {
  const result = await getStatusPageWithConfig(params.projectId);
  if (!result || !result.config.autoCreateIncident) return null;
  if (!meetsSeverityThreshold(params.alertSeverity, result.config.minSeverityToPost ?? "critical")) return null;

  // Avoid duplicate incidents for the same alert
  const [existing] = await db
    .select({ id: statusPageIncidents.id })
    .from(statusPageIncidents)
    .where(eq(statusPageIncidents.alertId, params.alertId))
    .limit(1);

  if (existing) return existing.id;

  const [incident] = await db
    .insert(statusPageIncidents)
    .values({
      statusPageId: result.page.id,
      alertId: params.alertId,
      title: params.alertTitle,
      status: "investigating",
      severity: alertSeverityToIncidentSeverity(params.alertSeverity),
    })
    .returning({ id: statusPageIncidents.id });

  // Add initial timeline update
  await db.insert(statusPageUpdates).values({
    incidentId: incident.id,
    status: "investigating",
    message: `We're aware of issues affecting this service. Our AI is analyzing the problem.`,
  });

  // Notify subscribers
  if (result.config.notifySubscribers) {
    notifySubscribersBackground(
      result.page.id,
      `Incident: ${params.alertTitle}`,
      `A new incident has been reported: ${params.alertTitle}\n\nStatus: Investigating\nSeverity: ${params.alertSeverity}\n\nWe're working on a resolution and will provide updates.`
    );
  }

  return incident.id;
}

// ── Update incident status ────────────────────────────────────────────────────

export async function updateIncidentStatus(params: {
  alertId?: string;
  remediationSessionId?: string;
  status: string;
  message: string;
}): Promise<void> {
  // Find the incident by alert ID or remediation session ID
  let incident;

  if (params.alertId) {
    [incident] = await db
      .select()
      .from(statusPageIncidents)
      .where(
        and(
          eq(statusPageIncidents.alertId, params.alertId),
          // Don't update already-resolved incidents
        )
      )
      .limit(1);
  }

  if (!incident && params.remediationSessionId) {
    [incident] = await db
      .select()
      .from(statusPageIncidents)
      .where(eq(statusPageIncidents.remediationSessionId, params.remediationSessionId))
      .limit(1);
  }

  if (!incident || incident.status === "resolved") return;

  await db
    .update(statusPageIncidents)
    .set({ status: params.status, updatedAt: new Date() })
    .where(eq(statusPageIncidents.id, incident.id));

  await db.insert(statusPageUpdates).values({
    incidentId: incident.id,
    status: params.status,
    message: params.message,
  });
}

// ── Link remediation session to incident ──────────────────────────────────────

export async function linkRemediationToIncident(alertId: string, sessionId: string): Promise<void> {
  await db
    .update(statusPageIncidents)
    .set({ remediationSessionId: sessionId, updatedAt: new Date() })
    .where(eq(statusPageIncidents.alertId, alertId));
}

// ── Resolve incident ──────────────────────────────────────────────────────────

export async function resolveIncident(params: {
  alertId?: string;
  remediationSessionId?: string;
  postmortem?: string;
}): Promise<void> {
  let incident;

  if (params.remediationSessionId) {
    [incident] = await db
      .select()
      .from(statusPageIncidents)
      .where(eq(statusPageIncidents.remediationSessionId, params.remediationSessionId))
      .limit(1);
  }

  if (!incident && params.alertId) {
    [incident] = await db
      .select()
      .from(statusPageIncidents)
      .where(eq(statusPageIncidents.alertId, params.alertId))
      .limit(1);
  }

  if (!incident || incident.status === "resolved") return;

  await db
    .update(statusPageIncidents)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
      postmortem: params.postmortem ?? null,
      updatedAt: new Date(),
    })
    .where(eq(statusPageIncidents.id, incident.id));

  await db.insert(statusPageUpdates).values({
    incidentId: incident.id,
    status: "resolved",
    message: "The issue has been resolved. All systems are operating normally.",
  });

  // Check if we should notify subscribers
  const [page] = await db
    .select()
    .from(statusPages)
    .where(eq(statusPages.id, incident.statusPageId))
    .limit(1);

  if (page) {
    const config: StatusPageConfig = {
      ...DEFAULT_STATUS_PAGE_CONFIG,
      ...(page.config as StatusPageConfig | null),
    };

    if (config.notifySubscribers) {
      notifySubscribersBackground(
        page.id,
        `Resolved: ${incident.title}`,
        `The incident "${incident.title}" has been resolved.\n\nAll systems are now operating normally.`
      );
    }
  }
}

// ── Mark incident as regressed ────────────────────────────────────────────────

export async function regressIncident(params: {
  remediationSessionId: string;
  reason: string;
}): Promise<void> {
  const [incident] = await db
    .select()
    .from(statusPageIncidents)
    .where(eq(statusPageIncidents.remediationSessionId, params.remediationSessionId))
    .limit(1);

  if (!incident) return;

  await db
    .update(statusPageIncidents)
    .set({ status: "regressed", resolvedAt: null, updatedAt: new Date() })
    .where(eq(statusPageIncidents.id, incident.id));

  await db.insert(statusPageUpdates).values({
    incidentId: incident.id,
    status: "regressed",
    message: `A regression was detected after the fix was deployed. ${params.reason}. The fix has been reverted and our team is investigating.`,
  });

  // Notify subscribers
  const [page] = await db
    .select()
    .from(statusPages)
    .where(eq(statusPages.id, incident.statusPageId))
    .limit(1);

  if (page) {
    const config: StatusPageConfig = {
      ...DEFAULT_STATUS_PAGE_CONFIG,
      ...(page.config as StatusPageConfig | null),
    };

    if (config.notifySubscribers) {
      notifySubscribersBackground(
        page.id,
        `Regression: ${incident.title}`,
        `The fix for "${incident.title}" caused a regression and has been reverted.\n\nReason: ${params.reason}\n\nWe're investigating further.`
      );
    }
  }
}

// ── Subscriber notifications (fire-and-forget) ───────────────────────────────

function notifySubscribersBackground(statusPageId: string, subject: string, body: string): void {
  notifySubscribers(statusPageId, subject, body).catch(() => {
    // Non-blocking — subscriber emails should never block the main pipeline
  });
}

async function notifySubscribers(statusPageId: string, subject: string, body: string): Promise<void> {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;

  const subscribers = await db
    .select()
    .from(statusPageSubscribers)
    .where(
      and(
        eq(statusPageSubscribers.statusPageId, statusPageId),
        eq(statusPageSubscribers.verified, true)
      )
    );

  if (subscribers.length === 0) return;

  const APP_URL = process.env.APP_URL ?? process.env.VERCEL_URL ?? "https://app.inariwatch.com";

  for (const sub of subscribers) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "InariWatch Status <status@inariwatch.com>",
          to: sub.email,
          subject: `[Status] ${subject}`,
          text: `${body}\n\n---\nUnsubscribe: ${APP_URL}/api/status/unsubscribe?token=${sub.unsubscribeToken}`,
        }),
      });
    } catch {
      // Individual email failure should not block others
    }
  }
}
