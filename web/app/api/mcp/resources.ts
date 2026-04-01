import { db, alerts, projects, uptimeMonitors, remediationSessions } from "@/lib/db";
import { eq, desc, and, sql } from "drizzle-orm";
import type { McpUser } from "./auth";

// ── Resource definitions ────────────────────────────────────────────────────

export const RESOURCES = [
  {
    uri: "inariwatch://alerts/critical",
    name: "Critical Alerts",
    description: "Currently open critical alerts across all your projects.",
    mimeType: "application/json",
  },
  {
    uri: "inariwatch://alerts/recent",
    name: "Recent Alerts",
    description: "Last 20 alerts across all your projects (last 24h).",
    mimeType: "application/json",
  },
  {
    uri: "inariwatch://status/overview",
    name: "System Status",
    description: "Overview of all projects: uptime, alert counts, active remediations.",
    mimeType: "application/json",
  },
  {
    uri: "inariwatch://remediations/active",
    name: "Active Remediations",
    description: "AI remediation sessions currently in progress.",
    mimeType: "application/json",
  },
];

// ── Resource readers ────────────────────────────────────────────────────────

export async function readResource(
  uri: string,
  user: McpUser
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> } | null> {
  const userProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.userId, user.userId));

  if (userProjects.length === 0) {
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ message: "No projects found." }) }],
    };
  }

  const projectIds = userProjects.map((p) => p.id);
  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  switch (uri) {
    case "inariwatch://alerts/critical": {
      const rows = await db
        .select({
          id: alerts.id, title: alerts.title, body: alerts.body,
          projectId: alerts.projectId, severity: alerts.severity,
          aiReasoning: alerts.aiReasoning, createdAt: alerts.createdAt,
        })
        .from(alerts)
        .where(
          and(
            sql`${alerts.projectId} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`,
            eq(alerts.severity, "critical"),
            eq(alerts.isResolved, false)
          )
        )
        .orderBy(desc(alerts.createdAt))
        .limit(50);

      const data = rows.map((a) => ({
        id: a.id,
        project: projectMap[a.projectId],
        title: a.title,
        body: a.body?.slice(0, 5000),
        aiReasoning: a.aiReasoning?.slice(0, 3000),
        createdAt: a.createdAt.toISOString(),
      }));

      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ count: data.length, alerts: data }, null, 2) }],
      };
    }

    case "inariwatch://alerts/recent": {
      const rows = await db
        .select({
          id: alerts.id, title: alerts.title, severity: alerts.severity,
          projectId: alerts.projectId, isResolved: alerts.isResolved,
          createdAt: alerts.createdAt,
        })
        .from(alerts)
        .where(
          and(
            sql`${alerts.projectId} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`,
            sql`${alerts.createdAt} > now() - interval '24 hours'`
          )
        )
        .orderBy(desc(alerts.createdAt))
        .limit(20);

      const data = rows.map((a) => ({
        id: a.id,
        project: projectMap[a.projectId],
        title: a.title,
        severity: a.severity,
        status: a.isResolved ? "resolved" : "open",
        createdAt: a.createdAt.toISOString(),
      }));

      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ count: data.length, alerts: data }, null, 2) }],
      };
    }

    case "inariwatch://status/overview": {
      const overview = [];
      for (const p of userProjects) {
        const [alertCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(alerts)
          .where(and(eq(alerts.projectId, p.id), eq(alerts.isResolved, false)));

        const monitors = await db
          .select({ url: uptimeMonitors.url, isDown: uptimeMonitors.isDown })
          .from(uptimeMonitors)
          .where(and(eq(uptimeMonitors.projectId, p.id), eq(uptimeMonitors.isActive, true)));

        overview.push({
          project: p.name,
          slug: p.slug,
          openAlerts: alertCount?.count ?? 0,
          monitors: monitors.map((m) => ({ url: m.url, status: m.isDown ? "down" : "up" })),
        });
      }

      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ projects: overview }, null, 2) }],
      };
    }

    case "inariwatch://remediations/active": {
      const sessions = await db
        .select({
          id: remediationSessions.id,
          status: remediationSessions.status,
          projectId: remediationSessions.projectId,
          prUrl: remediationSessions.prUrl,
          confidenceScore: remediationSessions.confidenceScore,
          createdAt: remediationSessions.createdAt,
        })
        .from(remediationSessions)
        .where(
          and(
            sql`${remediationSessions.projectId} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`,
            sql`${remediationSessions.status} NOT IN ('completed', 'failed', 'cancelled')`
          )
        )
        .orderBy(desc(remediationSessions.createdAt))
        .limit(10);

      const data = sessions.map((s) => ({
        id: s.id,
        project: projectMap[s.projectId],
        status: s.status,
        prUrl: s.prUrl,
        confidence: s.confidenceScore,
        createdAt: s.createdAt.toISOString(),
      }));

      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ count: data.length, sessions: data }, null, 2) }],
      };
    }

    default:
      return null;
  }
}
