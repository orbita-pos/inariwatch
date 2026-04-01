import { db, alerts, projects } from "@/lib/db";
import { sql, inArray } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const days = Math.min(Number(args.days) || 7, 30);
  const projectSlug = args.project as string | undefined;

  const projectIds = await getUserProjectIds(user.userId);
  if (projectIds.length === 0) return "No projects found.";

  const userProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, projectIds));

  const filteredIds = projectSlug
    ? userProjects.filter((p) => p.slug === projectSlug).map((p) => p.id)
    : projectIds;

  if (filteredIds.length === 0) return `Project not found: ${projectSlug}`;

  // Alerts per day by severity
  const dailyTrends = await db.execute(sql`
    SELECT
      to_char(created_at, 'YYYY-MM-DD') AS date,
      severity,
      count(*)::int AS count
    FROM alerts
    WHERE project_id = ANY(${filteredIds})
      AND created_at > now() - make_interval(days => ${days})
    GROUP BY date, severity
    ORDER BY date
  `);

  // Top recurring error titles
  const topErrors = await db.execute(sql`
    SELECT title, count(*)::int AS count, severity
    FROM alerts
    WHERE project_id = ANY(${filteredIds})
      AND created_at > now() - make_interval(days => ${days})
    GROUP BY title, severity
    ORDER BY count DESC
    LIMIT 10
  `);

  // Comparison to previous period
  const [currentPeriod] = (await db.execute(sql`
    SELECT count(*)::int AS count
    FROM alerts
    WHERE project_id = ANY(${filteredIds})
      AND created_at > now() - make_interval(days => ${days})
  `)).rows as { count: number }[];

  const [previousPeriod] = (await db.execute(sql`
    SELECT count(*)::int AS count
    FROM alerts
    WHERE project_id = ANY(${filteredIds})
      AND created_at > now() - make_interval(days => ${days * 2})
      AND created_at <= now() - make_interval(days => ${days})
  `)).rows as { count: number }[];

  const current = currentPeriod?.count ?? 0;
  const previous = previousPeriod?.count ?? 0;
  const change = previous > 0
    ? `${current > previous ? "+" : ""}${Math.round(((current - previous) / previous) * 100)}%`
    : "N/A (no previous data)";

  // Format output
  let out = `Error trends (last ${days} days)\n${"=".repeat(40)}\n\n`;
  out += `Total alerts: ${current} (${change} vs previous ${days} days)\n\n`;

  // Daily breakdown
  out += "Daily breakdown:\n";
  const dailyRows = dailyTrends.rows as { date: string; severity: string; count: number }[];
  const byDate = new Map<string, Record<string, number>>();
  for (const r of dailyRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    byDate.get(r.date)![r.severity] = r.count;
  }
  for (const [date, severities] of byDate) {
    const parts = Object.entries(severities).map(([s, c]) => `${s}: ${c}`);
    out += `  ${date} — ${parts.join(", ")}\n`;
  }

  // Top errors
  out += `\nTop recurring errors:\n`;
  const errorRows = topErrors.rows as { title: string; count: number; severity: string }[];
  for (const r of errorRows) {
    out += `  [${r.severity}] ${r.title} (${r.count}x)\n`;
  }

  return out;
}
