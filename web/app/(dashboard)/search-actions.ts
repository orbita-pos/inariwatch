"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, getUserProjectIds } from "@/lib/db";
import { ilike, inArray, eq, or, and } from "drizzle-orm";

export interface SearchResult {
  id:       string;
  type:     "alert" | "project";
  title:    string;
  subtitle: string;
  href:     string;
}

export async function searchDashboard(query: string): Promise<SearchResult[]> {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId || query.trim().length < 2) return [];

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) return [];

  const q = `%${query.trim()}%`;

  const [alertRows, projectRows] = await Promise.all([
    db.select({ id: alerts.id, title: alerts.title, severity: alerts.severity })
      .from(alerts)
      .where(and(inArray(alerts.projectId, projectIds), ilike(alerts.title, q)))
      .limit(5),

    db.select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(and(inArray(projects.id, projectIds), ilike(projects.name, q)))
      .limit(3),
  ]);

  const results: SearchResult[] = [];

  for (const p of projectRows) {
    results.push({
      id:       p.id,
      type:     "project",
      title:    p.name,
      subtitle: "Project",
      href:     `/projects/${p.slug}`,
    });
  }

  for (const a of alertRows) {
    results.push({
      id:       a.id,
      type:     "alert",
      title:    a.title,
      subtitle: a.severity.charAt(0).toUpperCase() + a.severity.slice(1) + " alert",
      href:     `/alerts/${a.id}`,
    });
  }

  return results;
}
