/**
 * PATCH / DELETE /api/replay/comments/[id]
 *
 *   PATCH  → toggle `resolved` (anyone with read access on the session)
 *   DELETE → soft-delete (author only, body becomes '[deleted]'). Hard
 *            delete is intentionally NOT supported — replies still need
 *            their parent row to render the thread.
 *
 * The session id is recovered FROM the comment row, not from the URL,
 * so the auth gate doesn't need to be parameterised by both ids.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  replaySessions,
  replayComments,
  organizations,
  organizationMembers,
} from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import { isReplayV2Enabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CommentContext {
  userId: string;
  comment: typeof replayComments.$inferSelect;
  sessionOrgId: string;
}

async function loadAndAuthorize(id: string): Promise<
  | { ok: true; ctx: CommentContext }
  | { ok: false; resp: NextResponse }
> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return { ok: false, resp: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!UUID_RE.test(id)) return { ok: false, resp: NextResponse.json({ error: "Invalid id" }, { status: 400 }) };

  const [row] = await db
    .select({
      comment: replayComments,
      sessionOrgId: replaySessions.organizationId,
    })
    .from(replayComments)
    .leftJoin(replaySessions, eq(replaySessions.sessionId, replayComments.sessionId))
    .where(eq(replayComments.id, id))
    .limit(1);
  if (!row || !row.comment || !row.sessionOrgId) {
    return { ok: false, resp: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  if (!isReplayV2Enabled(row.sessionOrgId)) {
    return { ok: false, resp: NextResponse.json({ error: "Replay V2 not enabled" }, { status: 403 }) };
  }

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
        eq(organizations.id, row.sessionOrgId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);
  if (!access) return { ok: false, resp: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };

  return { ok: true, ctx: { userId, comment: row.comment, sessionOrgId: row.sessionOrgId } };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const auth = await loadAndAuthorize(id);
  if (!auth.ok) return auth.resp;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.resolved !== "boolean") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  await db
    .update(replayComments)
    .set({ resolved: body.resolved, updatedAt: new Date() })
    .where(eq(replayComments.id, id));

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const auth = await loadAndAuthorize(id);
  if (!auth.ok) return auth.resp;

  if (auth.ctx.comment.userId !== auth.ctx.userId) {
    return NextResponse.json({ error: "Only the author can delete" }, { status: 403 });
  }

  // Soft-delete: keep the row so any replies still render coherently.
  await db
    .update(replayComments)
    .set({ body: "[deleted]", mentionedUserIds: [], updatedAt: new Date() })
    .where(eq(replayComments.id, id));

  return NextResponse.json({ ok: true });
}
