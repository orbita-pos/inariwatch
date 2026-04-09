/**
 * Alert service — single source of truth for all alert operations.
 * Used by: MCP tools, Slack bot, VS Code extension, dashboard, API routes.
 */

import { db, alerts, projects, alertComments, users } from "@/lib/db";
import { eq, desc, and, sql, inArray, gt, ilike } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

export type QueryAlertsParams = {
  projectIds: string[];
  severity?: "critical" | "warning" | "info";
  isResolved?: boolean;
  search?: string;
  limit?: number;
};

export type AlertSummary = {
  id: string;
  projectId: string;
  severity: string;
  title: string;
  body: string | null;
  aiReasoning: string | null;
  sourceIntegrations: string[];
  isRead: boolean;
  isResolved: boolean;
  fingerprint: string | null;
  createdAt: Date;
  correlationData: unknown;
};

export type AlertDetail = AlertSummary & {
  postmortem: string | null;
  resolvedAt: Date | null;
  sentAt: Date | null;
  correlationData: unknown;
};

// ── Query alerts ─────────────────────────────────────────────────────────────

export async function queryAlerts(params: QueryAlertsParams): Promise<AlertSummary[]> {
  const { projectIds, severity, isResolved, search, limit = 50 } = params;
  if (projectIds.length === 0) return [];

  const conditions = [inArray(alerts.projectId, projectIds)];
  if (severity) conditions.push(eq(alerts.severity, severity));
  if (isResolved !== undefined) conditions.push(eq(alerts.isResolved, isResolved));
  if (search) {
    const escaped = search.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push(ilike(alerts.title, `%${escaped}%`));
  }

  return db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      severity: alerts.severity,
      title: alerts.title,
      body: alerts.body,
      aiReasoning: alerts.aiReasoning,
      sourceIntegrations: alerts.sourceIntegrations,
      isRead: alerts.isRead,
      isResolved: alerts.isResolved,
      fingerprint: alerts.fingerprint,
      createdAt: alerts.createdAt,
      correlationData: alerts.correlationData,
    })
    .from(alerts)
    .where(and(...conditions))
    .orderBy(desc(alerts.createdAt))
    .limit(Math.min(limit, 1000));
}

// ── Get alert by ID ──────────────────────────────────────────────────────────

export async function getAlert(alertId: string): Promise<AlertDetail | null> {
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  return alert ?? null;
}

// ── Silence / resolve alert ──────────────────────────────────────────────────

export async function silenceAlert(
  alertId: string,
  resolve: boolean = true
): Promise<{ ok: boolean; title?: string }> {
  const [alert] = await db
    .select({ id: alerts.id, title: alerts.title, projectId: alerts.projectId, fingerprint: alerts.fingerprint })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return { ok: false };

  await db
    .update(alerts)
    .set({
      isRead: true,
      ...(resolve ? { isResolved: true, resolvedAt: new Date() } : {}),
    })
    .where(eq(alerts.id, alertId));

  // Clear Redis dedup key so the same error can create a new alert if it recurs
  if (resolve && alert.fingerprint) {
    import("@/lib/redis").then(({ getRedis }) => {
      const redis = getRedis();
      if (redis) redis.del(`dedup:${alert.projectId}:${alert.fingerprint}`).catch(() => {});
    }).catch(() => {});
  }

  return { ok: true, title: alert.title };
}

// ── Acknowledge alert (mark as read only) ────────────────────────────────────

export async function acknowledgeAlert(alertId: string): Promise<{ ok: boolean }> {
  const affected = await db
    .update(alerts)
    .set({ isRead: true })
    .where(eq(alerts.id, alertId));

  return { ok: true };
}

// ── Reopen alert ─────────────────────────────────────────────────────────────

export async function reopenAlert(alertId: string): Promise<{ ok: boolean }> {
  const [alert] = await db
    .select({ projectId: alerts.projectId, fingerprint: alerts.fingerprint })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  await db
    .update(alerts)
    .set({ isResolved: false, resolvedAt: null })
    .where(eq(alerts.id, alertId));

  // Clear Redis dedup key so the error can be re-ingested
  if (alert?.fingerprint) {
    import("@/lib/redis").then(({ getRedis }) => {
      const redis = getRedis();
      if (redis) redis.del(`dedup:${alert.projectId}:${alert.fingerprint}`).catch(() => {});
    }).catch(() => {});
  }

  return { ok: true };
}

// ── Alert stats ──────────────────────────────────────────────────────────────

export async function getAlertStats(
  projectIds: string[],
  days: number = 90
) {
  if (projectIds.length === 0) return [];

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return db
    .select({
      severity: alerts.severity,
      count: sql<number>`count(*)`,
      resolved: sql<number>`count(*) filter (where ${alerts.isResolved} = true)`,
    })
    .from(alerts)
    .where(and(inArray(alerts.projectId, projectIds), gt(alerts.createdAt, since)))
    .groupBy(alerts.severity);
}

// ── Error trends ─────────────────────────────────────────────────────────────

export async function getErrorTrends(projectIds: string[], days: number = 7) {
  if (projectIds.length === 0) return { daily: [], topErrors: [], current: 0, previous: 0 };

  const daily = await db.execute(sql`
    SELECT to_char(created_at, 'YYYY-MM-DD') AS date, severity, count(*)::int AS count
    FROM alerts
    WHERE project_id = ANY(${projectIds})
      AND created_at > now() - make_interval(days => ${days})
    GROUP BY date, severity ORDER BY date
  `);

  const topErrors = await db.execute(sql`
    SELECT title, count(*)::int AS count, severity
    FROM alerts
    WHERE project_id = ANY(${projectIds})
      AND created_at > now() - make_interval(days => ${days})
    GROUP BY title, severity ORDER BY count DESC LIMIT 10
  `);

  const [currentRow] = (await db.execute(sql`
    SELECT count(*)::int AS count FROM alerts
    WHERE project_id = ANY(${projectIds})
      AND created_at > now() - make_interval(days => ${days})
  `)).rows as { count: number }[];

  const [previousRow] = (await db.execute(sql`
    SELECT count(*)::int AS count FROM alerts
    WHERE project_id = ANY(${projectIds})
      AND created_at > now() - make_interval(days => ${days * 2})
      AND created_at <= now() - make_interval(days => ${days})
  `)).rows as { count: number }[];

  return {
    daily: daily.rows as { date: string; severity: string; count: number }[],
    topErrors: topErrors.rows as { title: string; count: number; severity: string }[],
    current: currentRow?.count ?? 0,
    previous: previousRow?.count ?? 0,
  };
}
