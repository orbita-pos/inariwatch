import { db, projects } from "@/lib/db";
import { inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";
import { queryAlerts } from "@/lib/services/alerts.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const limit = Math.min(Number(args.limit) || 20, 100);
  const severity = args.severity as "critical" | "warning" | "info" | undefined;
  const projectSlug = args.project as string | undefined;

  const projectIds = await getUserProjectIds(user.userId);
  if (projectIds.length === 0) return "No projects found.";

  const userProjects = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));

  const filteredIds = projectSlug
    ? userProjects.filter((p) => p.slug === projectSlug).map((p) => p.id)
    : projectIds;

  if (filteredIds.length === 0) return `Project not found: ${projectSlug}`;

  const rows = await queryAlerts({ projectIds: filteredIds, severity, limit });

  if (rows.length === 0) return "No alerts found.";

  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  let out = `${rows.length} alert(s):\n\n`;
  for (const a of rows) {
    out += `[${a.severity.toUpperCase()}] ${projectMap[a.projectId] ?? "?"} — ${a.title}\n`;
    out += `ID: ${a.id}\n`;
    if (a.body) out += `${a.body.slice(0, 500)}\n`;
    if (a.aiReasoning) out += `AI: ${a.aiReasoning.slice(0, 300)}\n`;
    out += `Sources: ${(a.sourceIntegrations ?? []).join(", ") || "capture"}\n`;
    out += `Status: ${a.isResolved ? "resolved" : "open"}\n`;
    out += `Time: ${a.createdAt.toISOString()}\n\n`;
  }
  return out;
}
