import { db, projects, uptimeMonitors } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";
import { isSafeUrl } from "@/lib/services/url-validation";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectSlug = args.project as string | undefined;

  const projectIds = await getUserProjectIds(user.userId);
  const userProjects = projectIds.length > 0
    ? await db.select().from(projects).where(inArray(projects.id, projectIds))
    : [];

  const targets = projectSlug
    ? userProjects.filter((p) => p.slug === projectSlug)
    : userProjects;

  if (targets.length === 0) return "No projects found.";

  const results: string[] = [];

  for (const project of targets) {
    const monitors = await db
      .select()
      .from(uptimeMonitors)
      .where(and(eq(uptimeMonitors.projectId, project.id), eq(uptimeMonitors.isActive, true)));

    for (const monitor of monitors) {
      if (!isSafeUrl(monitor.url)) {
        results.push(`✗ ${project.name} — ${monitor.url} — blocked (private/internal URL)`);
        continue;
      }
      try {
        const start = Date.now();
        const resp = await fetch(monitor.url, {
          redirect: "manual",
          signal: AbortSignal.timeout(monitor.timeoutMs),
        });
        const elapsed = Date.now() - start;
        const isUp = resp.status === monitor.expectedStatus;

        results.push(
          `${isUp ? "✓" : "✗"} ${project.name} — ${monitor.url} — HTTP ${resp.status} (${elapsed}ms)`
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : "unknown";
        results.push(`✗ ${project.name} — ${monitor.url} — ${reason}`);
      }
    }

    if (monitors.length === 0) {
      results.push(`• ${project.name} — no uptime monitors configured`);
    }
  }

  return `Check completed:\n\n${results.join("\n")}`;
}
