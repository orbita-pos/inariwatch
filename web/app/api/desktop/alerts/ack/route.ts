import { NextRequest, NextResponse } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { eq, desc, inArray, and } from "drizzle-orm";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";
import { acknowledgeAlert } from "@/lib/services/alerts.service";

export async function POST(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => ({})) as { alertId?: string; project?: string };

  if (auth.projectIds.length === 0) {
    return NextResponse.json({ ok: false, title: null });
  }

  const projectFilter = body.project?.trim() || null;
  let projectIds = auth.projectIds;

  if (projectFilter) {
    const userProjects = await db
      .select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(eq(projects.userId, auth.userId));

    const filtered = userProjects
      .filter((p) =>
        p.slug?.toLowerCase() === projectFilter.toLowerCase() ||
        p.name?.toLowerCase() === projectFilter.toLowerCase()
      )
      .map((p) => p.id);

    if (filtered.length > 0) projectIds = filtered;
  }

  let alertId = body.alertId?.trim() || null;

  if (!alertId) {
    const [latest] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(inArray(alerts.projectId, projectIds), eq(alerts.isResolved, false)))
      .orderBy(desc(alerts.createdAt))
      .limit(1);
    if (!latest) return NextResponse.json({ ok: false, title: null });
    alertId = latest.id;
  } else {
    const [check] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.id, alertId), inArray(alerts.projectId, projectIds)))
      .limit(1);
    if (!check) return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  }

  const [row] = await db
    .select({ title: alerts.title })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  await acknowledgeAlert(alertId);
  return NextResponse.json({ ok: true, title: row?.title ?? null });
}
