import { NextRequest, NextResponse } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";
import { authenticateExtensionToken, unauthorized } from "@/lib/auth-extension";

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return unauthorized();

  if (auth.projectIds.length === 0) return NextResponse.json([]);

  const userProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.userId, auth.userId));

  const rows = await db
    .select()
    .from(alerts)
    .where(inArray(alerts.projectId, auth.projectIds))
    .orderBy(desc(alerts.createdAt))
    .limit(20);

  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  const unread = rows
    .filter((a) => !a.isRead && (a.severity === "critical" || a.severity === "warning"))
    .map((a) => ({
      id:                 a.id,
      title:              a.title,
      body:               a.body,
      severity:           a.severity,
      aiReasoning:        a.aiReasoning ?? null,
      sourceIntegrations: a.sourceIntegrations,
      projectName:        projectMap[a.projectId] ?? "?",
      fingerprint:        a.fingerprint ?? null,
      isRead:             a.isRead,
      isResolved:         a.isResolved,
      createdAt:          a.createdAt.toISOString(),
    }));

  return NextResponse.json(unread);
}
