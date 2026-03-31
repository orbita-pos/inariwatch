import { db, projects, projectIntegrations, alerts, uptimeMonitors } from "@/lib/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";

export async function execute(
  _args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectIds = await getUserProjectIds(user.userId);
  const userProjects = projectIds.length > 0
    ? await db.select().from(projects).where(inArray(projects.id, projectIds))
    : [];

  if (userProjects.length === 0)
    return "No projects configured. Create one at app.inariwatch.com.";

  let out = `${userProjects.length} project(s):\n\n`;

  for (const p of userProjects) {
    out += `• ${p.name} (${p.slug})\n`;

    const integrations = await db
      .select({ service: projectIntegrations.service, isActive: projectIntegrations.isActive })
      .from(projectIntegrations)
      .where(eq(projectIntegrations.projectId, p.id));

    for (const i of integrations) {
      out += `  ${i.isActive ? "✓" : "✗"} ${i.service}\n`;
    }

    // Alert count (last 24h)
    const [alertCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(
        and(
          eq(alerts.projectId, p.id),
          sql`${alerts.createdAt} > now() - interval '24 hours'`
        )
      );
    out += `  Alerts (24h): ${alertCount?.count ?? 0}\n`;

    // Uptime monitors
    const monitors = await db
      .select({ url: uptimeMonitors.url, isDown: uptimeMonitors.isDown, isActive: uptimeMonitors.isActive })
      .from(uptimeMonitors)
      .where(eq(uptimeMonitors.projectId, p.id));

    for (const m of monitors) {
      if (m.isActive) {
        out += `  ${m.isDown ? "✗ DOWN" : "✓ UP"} ${m.url}\n`;
      }
    }
    out += "\n";
  }

  return out;
}
