import { db, alerts, projects } from "@/lib/db";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const limit = Math.min(Number(args.limit) || 20, 100);
  const severity = args.severity as string | undefined;
  const projectSlug = args.project as string | undefined;

  // Get user's projects
  const projectIds = await getUserProjectIds(user.userId);
  const userProjects = projectIds.length > 0
    ? await db.select({ id: projects.id, slug: projects.slug, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
    : [];

  if (userProjects.length === 0) return "No projects found.";

  const filteredProjectIds = projectSlug
    ? userProjects.filter((p) => p.slug === projectSlug).map((p) => p.id)
    : userProjects.map((p) => p.id);

  if (filteredProjectIds.length === 0) return `Project not found: ${projectSlug}`;

  const conditions = [
    sql`${alerts.projectId} IN (${sql.join(filteredProjectIds.map((id) => sql`${id}`), sql`, `)})`,
  ];
  if (severity) conditions.push(eq(alerts.severity, severity as "critical" | "warning" | "info"));

  const rows = await db
    .select({
      id: alerts.id,
      severity: alerts.severity,
      title: alerts.title,
      body: alerts.body,
      sources: alerts.sourceIntegrations,
      aiReasoning: alerts.aiReasoning,
      isResolved: alerts.isResolved,
      createdAt: alerts.createdAt,
      projectId: alerts.projectId,
    })
    .from(alerts)
    .where(and(...conditions))
    .orderBy(desc(alerts.createdAt))
    .limit(limit);

  if (rows.length === 0) return "No alerts found.";

  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  let out = `${rows.length} alert(s):\n\n`;
  for (const a of rows) {
    out += `[${a.severity.toUpperCase()}] ${projectMap[a.projectId] ?? "?"} — ${a.title}\n`;
    out += `ID: ${a.id}\n`;
    if (a.body) out += `${a.body.slice(0, 500)}\n`;
    if (a.aiReasoning) out += `AI: ${a.aiReasoning.slice(0, 300)}\n`;
    out += `Sources: ${(a.sources ?? []).join(", ") || "capture"}\n`;
    out += `Status: ${a.isResolved ? "resolved" : "open"}\n`;
    out += `Time: ${a.createdAt.toISOString()}\n\n`;
  }
  return out;
}
