import { NextRequest, NextResponse } from "next/server";
import { db, projects } from "@/lib/db";
import { inArray } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";
import { queryAlerts } from "@/lib/services/alerts.service";
import { requireMobileAuth } from "@/lib/auth/mobile";

export async function GET(req: NextRequest) {
  const auth = await requireMobileAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const url = new URL(req.url);
  const severity = url.searchParams.get("severity") as "critical" | "warning" | "info" | undefined;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) return NextResponse.json({ alerts: [], unreadCount: 0 });

  const userProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  const alerts = await queryAlerts({
    projectIds,
    severity: severity || undefined,
    isResolved: false,
    limit,
  });

  const unreadCount = alerts.filter((a) => !a.isRead).length;

  return NextResponse.json({
    alerts: alerts.map((a) => ({ ...a, projectName: projectMap[a.projectId] ?? "?" })),
    unreadCount,
  });
}
