/**
 * S12 — GET /api/mobile/alerts/[id]
 *
 * Single-alert fetch for the mobile PWA. Bearer = device JWT (S12);
 * the device must be paired to the workspace whose org owns this
 * alert's project.
 *
 * NOTE: this REPLACES the bot-app-era handler that previously lived
 * here. The legacy Expo client is deprecated — see
 * `bot-app/README.md` and S12_PROMPT.md anti-pattern #1.
 */

import { NextResponse, type NextRequest } from "next/server";
import { db, alerts, projects, remediationSessions } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { authoriseMobileRequest } from "@/lib/auth/mobile-auth";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authoriseMobileRequest(req);
  if (!auth.ok) return auth.response;
  const { device } = auth;
  const { id } = await params;

  const alertRows = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  if (alertRows.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const alert = alertRows[0];

  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);
  if (projectRows.length === 0 || projectRows[0].organizationId !== device.workspaceId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const project = projectRows[0];

  const recentRemediations = await db
    .select({
      id:        remediationSessions.id,
      status:    remediationSessions.status,
      attempt:   remediationSessions.attempt,
      prUrl:     remediationSessions.prUrl,
      createdAt: remediationSessions.createdAt,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, id))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(5);

  return NextResponse.json({
    id:                  alert.id,
    title:               alert.title,
    body:                alert.body,
    severity:            alert.severity,
    ai_reasoning:        alert.aiReasoning,
    source_integrations: alert.sourceIntegrations,
    fingerprint:         alert.fingerprint,
    is_read:             alert.isRead,
    is_resolved:         alert.isResolved,
    repo:                alert.repo,
    project: {
      id:   project.id,
      name: project.name,
      slug: project.slug,
    },
    remediations: recentRemediations.map((r) => ({
      id:         r.id,
      status:     r.status,
      attempt:    r.attempt,
      pr_url:     r.prUrl,
      created_at: r.createdAt.toISOString(),
    })),
    created_at: alert.createdAt.toISOString(),
  });
}
