/**
 * S12 — POST /api/mobile/alerts/[id]/fix
 *
 * Mobile triggers remediation for an alert. Bearer = device JWT. We
 * insert a remediation_session row + fire `runRemediation` in the
 * background (same shape as the MCP `trigger_fix` tool, just
 * device-scoped instead of user-scoped). The session is owned by
 * the workspace's owner — that's the user who provisioned the
 * organization.
 */

import { NextResponse, type NextRequest } from "next/server";
import { db, alerts, projects, remediationSessions, organizations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { authoriseMobileRequest } from "@/lib/auth/mobile-auth";

export const runtime = "nodejs";

export async function POST(
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

  // Resolve the workspace owner — remediation_sessions.userId expects
  // a user uuid + the worker uses it to look up the BYOK key. Falling
  // back to project.userId (the user who created the project) keeps
  // pre-org alerts working.
  const orgRows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, device.workspaceId))
    .limit(1);
  const ownerUserId = orgRows[0]?.ownerId ?? project.userId;

  const [session] = await db
    .insert(remediationSessions)
    .values({
      alertId:     id,
      projectId:   project.id,
      userId:      ownerUserId,
      status:      "analyzing",
      attempt:     1,
      maxAttempts: 3,
      steps: [
        {
          id:        "mobile_trigger",
          type:      "info",
          message:   `Remediation triggered from mobile (${device.displayName})`,
          status:    "completed",
          timestamp: new Date().toISOString(),
        },
      ],
    })
    .returning({ id: remediationSessions.id });

  // Fire-and-forget — the worker runs server-side regardless of the
  // mobile client closing the tab.
  import("@/lib/ai/remediate")
    .then(({ runRemediation }) => {
      runRemediation(session.id, () => {}).catch(() => {});
    })
    .catch(() => {});

  return NextResponse.json({
    status:     "started",
    session_id: session.id,
  });
}
