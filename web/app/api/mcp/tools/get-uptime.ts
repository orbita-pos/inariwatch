import { db, projects, uptimeMonitors, uptimeChecks } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectSlug = args.project as string | undefined;

  const projectIds = await getUserProjectIds(user.userId);
  const userProjects = projectIds.length > 0
    ? await db.select({ id: projects.id, name: projects.name, slug: projects.slug }).from(projects).where(inArray(projects.id, projectIds))
    : [];

  const filteredIds = projectSlug
    ? userProjects.filter((p) => p.slug === projectSlug).map((p) => p.id)
    : userProjects.map((p) => p.id);

  if (filteredIds.length === 0) return "No projects found.";

  const monitors = await db
    .select()
    .from(uptimeMonitors)
    .where(eq(uptimeMonitors.isActive, true));

  const relevant = monitors.filter((m) => filteredIds.includes(m.projectId));

  if (relevant.length === 0)
    return "No uptime monitors configured.";

  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));
  const allUp = relevant.every((m) => !m.isDown);

  let out = allUp
    ? "✓ All systems operational\n"
    : "✗ Degraded — one or more monitors are down\n";
  out += "=".repeat(40) + "\n\n";

  for (const m of relevant) {
    const [lastCheck] = await db
      .select()
      .from(uptimeChecks)
      .where(eq(uptimeChecks.monitorId, m.id))
      .orderBy(desc(uptimeChecks.checkedAt))
      .limit(1);

    out += `${m.isDown ? "✗" : "✓"} ${projectMap[m.projectId] ?? "?"} — ${m.url}\n`;
    if (lastCheck) {
      out += `   Last check: HTTP ${lastCheck.statusCode ?? "—"} | ${lastCheck.responseTimeMs ?? "—"}ms | ${lastCheck.checkedAt.toISOString()}\n`;
    }
    if (m.isDown) {
      out += `   Consecutive failures: ${m.consecutiveFailures}\n`;
    }
    out += "\n";
  }

  return out;
}
