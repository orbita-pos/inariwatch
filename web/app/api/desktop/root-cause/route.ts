import { NextRequest, NextResponse } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { eq, inArray, desc, and, isNotNull } from "drizzle-orm";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const userProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(eq(projects.userId, auth.userId));

  if (userProjects.length === 0) {
    return NextResponse.json({ error: "No projects" }, { status: 404 });
  }

  const projectFilter = req.nextUrl.searchParams.get("project")?.trim() || null;

  const filteredProjects = projectFilter
    ? userProjects.filter(
        (p) =>
          p.name?.toLowerCase() === projectFilter.toLowerCase() ||
          p.slug?.toLowerCase() === projectFilter.toLowerCase()
      )
    : userProjects;

  const projectIds = filteredProjects.length > 0
    ? filteredProjects.map((p) => p.id)
    : userProjects.map((p) => p.id);

  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  const alertId = req.nextUrl.searchParams.get("alert_id");

  let row;
  if (alertId) {
    [row] = await db
      .select({
        id: alerts.id, title: alerts.title, severity: alerts.severity,
        body: alerts.body, aiReasoning: alerts.aiReasoning,
        projectId: alerts.projectId, createdAt: alerts.createdAt,
        isResolved: alerts.isResolved,
      })
      .from(alerts)
      .where(and(eq(alerts.id, alertId), inArray(alerts.projectId, projectIds)))
      .limit(1);
  } else {
    [row] = await db
      .select({
        id: alerts.id, title: alerts.title, severity: alerts.severity,
        body: alerts.body, aiReasoning: alerts.aiReasoning,
        projectId: alerts.projectId, createdAt: alerts.createdAt,
        isResolved: alerts.isResolved,
      })
      .from(alerts)
      .where(
        and(
          inArray(alerts.projectId, projectIds),
          eq(alerts.isResolved, false),
          isNotNull(alerts.aiReasoning),
        )
      )
      .orderBy(desc(alerts.createdAt))
      .limit(1);
  }

  if (!row) return NextResponse.json({ error: "No alert found" }, { status: 404 });

  return NextResponse.json({
    id:          row.id,
    title:       row.title,
    severity:    row.severity,
    body:        row.body ?? null,
    projectName: projectMap[row.projectId] ?? "?",
    aiReasoning: row.aiReasoning ?? null,
    isResolved:  row.isResolved,
    createdAt:   row.createdAt.toISOString(),
  });
}
