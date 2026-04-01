import { db, projects } from "@/lib/db";
import { inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";
import { getErrorTrends } from "@/lib/services/alerts.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const days = Math.min(Number(args.days) || 7, 30);
  const projectSlug = args.project as string | undefined;

  const projectIds = await getUserProjectIds(user.userId);
  if (projectIds.length === 0) return "No projects found.";

  const userProjects = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, projectIds));

  const filteredIds = projectSlug
    ? userProjects.filter((p) => p.slug === projectSlug).map((p) => p.id)
    : projectIds;

  if (filteredIds.length === 0) return `Project not found: ${projectSlug}`;

  const trends = await getErrorTrends(filteredIds, days);

  const change = trends.previous > 0
    ? `${trends.current > trends.previous ? "+" : ""}${Math.round(((trends.current - trends.previous) / trends.previous) * 100)}%`
    : "N/A (no previous data)";

  let out = `Error trends (last ${days} days)\n${"=".repeat(40)}\n\n`;
  out += `Total alerts: ${trends.current} (${change} vs previous ${days} days)\n\n`;

  out += "Daily breakdown:\n";
  const byDate = new Map<string, Record<string, number>>();
  for (const r of trends.daily) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    byDate.get(r.date)![r.severity] = r.count;
  }
  for (const [date, severities] of byDate) {
    const parts = Object.entries(severities).map(([s, c]) => `${s}: ${c}`);
    out += `  ${date} — ${parts.join(", ")}\n`;
  }

  out += `\nTop recurring errors:\n`;
  for (const r of trends.topErrors) {
    out += `  [${r.severity}] ${r.title} (${r.count}x)\n`;
  }

  return out;
}
