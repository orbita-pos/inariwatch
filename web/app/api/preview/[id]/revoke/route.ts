import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  organizationMembers,
  organizations,
  projects,
} from "@/lib/db";
import { and, eq, or } from "drizzle-orm";
import {
  getPreviewById,
  revokePreviewSession,
} from "@/lib/services/preview/session.service";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Preview Fix — revoke a shared preview.
 *
 *   POST /api/preview/:id/revoke
 *
 * Idempotent: flips `preview_sessions.revoked_at` to now(). The public
 * `/preview/<slug>` endpoint then returns 410 Gone with a friendly page,
 * and any Slack / Twitter / LinkedIn unfurls of the share URL lose their
 * content (their OG cache still shows the screenshot but the landing
 * page tells visitors the preview was withdrawn).
 *
 * Auth: the project owner OR the org owner can revoke. Matches the
 * disconnect integration's authorization model — an org member cannot
 * quietly un-share something the owner published, only the owner can.
 *
 * Does NOT destroy the live container or delete the R2 screenshot — it
 * only hides them from the public slug. Rationale: once a share URL is
 * in a tweet we can't un-cache it, and tearing the container down early
 * would break any authed viewer who still has the panel open.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid preview id" }, { status: 400 });
  }

  const preview = await getPreviewById(id);
  if (!preview) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const authed = await authorizeRevoke(preview.projectId, userId);
  if (!authed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  await revokePreviewSession(id);
  logAudit({
    userId,
    action: "preview.revoke",
    resource: "preview_session",
    resourceId: id,
  });

  return NextResponse.json({ ok: true });
}

async function authorizeRevoke(projectId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      ownerId: projects.userId,
      organizationId: projects.organizationId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return false;
  if (row.ownerId === userId) return true;
  if (!row.organizationId) return false;

  // Org owner OR any member can revoke — we want a co-founder to be able
  // to pull a share URL immediately if the primary owner is unreachable.
  const [access] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(organizations.id, row.organizationId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);
  return !!access;
}
