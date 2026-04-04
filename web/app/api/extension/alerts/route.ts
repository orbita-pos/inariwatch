/**
 * GET  /api/extension/alerts — List unresolved alerts (with projectName, aiReasoning, etc.)
 * POST /api/extension/alerts — Mark alert as read: { alertId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";
import { queryAlerts } from "@/lib/services/alerts.service";
import { requireExtensionAuth } from "@/lib/auth/extension";

export async function GET(req: NextRequest) {
  const auth = await requireExtensionAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const url = new URL(req.url);
  const severity = url.searchParams.get("severity") as "critical" | "warning" | "info" | undefined;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) return NextResponse.json([]);

  const userProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  const result = await queryAlerts({
    projectIds,
    severity: severity || undefined,
    isResolved: false,
    limit,
  });

  return NextResponse.json(
    result.map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      severity: a.severity,
      aiReasoning: a.aiReasoning ?? null,
      isRead: a.isRead,
      isResolved: a.isResolved,
      sourceIntegrations: a.sourceIntegrations,
      projectName: projectMap[a.projectId] ?? "?",
      createdAt: a.createdAt.toISOString(),
      source: "cloud" as const,
    }))
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireExtensionAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const body = await req.json().catch(() => null);
  const alertId = body?.alertId;
  if (!alertId) return NextResponse.json({ error: "Missing alertId" }, { status: 400 });

  // Verify ownership
  const projectIds = await getUserProjectIds(userId);
  const [alert] = await db
    .select({ id: alerts.id, projectId: alerts.projectId })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert || !projectIds.includes(alert.projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.update(alerts).set({ isRead: true }).where(eq(alerts.id, alertId));

  return NextResponse.json({ ok: true });
}
