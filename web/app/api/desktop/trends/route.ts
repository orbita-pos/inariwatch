import { NextRequest, NextResponse } from "next/server";
import { db, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import { getErrorTrends } from "@/lib/services/alerts.service";

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const allProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.userId, auth.userId));

  if (allProjects.length === 0) {
    return NextResponse.json({ current: 0, previous: 0, daily: [], topErrors: [] });
  }

  const days = Math.min(Number(req.nextUrl.searchParams.get("days") ?? "7"), 30);
  const projectFilter = req.nextUrl.searchParams.get("project")?.trim() || null;

  const projectIds = projectFilter
    ? allProjects
        .filter((p) =>
          p.slug?.toLowerCase() === projectFilter.toLowerCase() ||
          p.name?.toLowerCase() === projectFilter.toLowerCase()
        )
        .map((p) => p.id)
    : allProjects.map((p) => p.id);

  if (projectIds.length === 0) {
    return NextResponse.json({ current: 0, previous: 0, daily: [], topErrors: [] });
  }

  const trends = await getErrorTrends(projectIds, days);
  return NextResponse.json(trends);
}
