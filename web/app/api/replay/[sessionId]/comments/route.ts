/**
 * GET / POST /api/replay/[sessionId]/comments
 *
 * GET  → list every comment for the session, oldest first by timestamp
 * POST → create a new comment (or reply if `parentId` provided)
 *
 * Auth: org owner OR org member of the session's organization. Same gate
 * as /api/replay/[sessionId]/manifest.
 *
 * Mention pipeline: extract `@email` substrings → resolve against the
 * org's user roster → store the matched user ids on the row → fire-
 * and-forget email notification to each.
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
  users,
} from "@/lib/db/schema";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { extractMentionEmails } from "@/lib/jobs/replay-mention";
import { sendEmail } from "@/lib/notifications/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4_000;
const MAX_TIMESTAMP_MS = 24 * 60 * 60 * 1000; // 24h cap on session length

interface AuthorizedContext {
  userId: string;
  organizationId: string;
}

/**
 * Shared auth gate for both verbs. Returns null on success (with the
 * verified context tucked alongside) or a NextResponse to short-circuit
 * the caller with the right error code.
 */
async function authorize(sessionId: string): Promise<
  | { ok: true; ctx: AuthorizedContext; sessionRowId: string }
  | { ok: false; resp: NextResponse }
> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return { ok: false, resp: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  if (!sessionId || sessionId.length > 128) {
    return { ok: false, resp: NextResponse.json({ error: "Invalid sessionId" }, { status: 400 }) };
  }

  const [row] = await db
    .select({ id: replaySessions.id, sessionId: replaySessions.sessionId, organizationId: replaySessions.organizationId })
    .from(replaySessions)
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);
  if (!row || !row.organizationId) return { ok: false, resp: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isReplayV2Enabled(row.organizationId)) {
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
        eq(organizations.id, row.organizationId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);
  if (!access) return { ok: false, resp: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };

  return {
    ok: true,
    ctx: { userId, organizationId: row.organizationId },
    sessionRowId: row.id,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const { sessionId } = await params;
  const auth = await authorize(sessionId);
  if (!auth.ok) return auth.resp;

  // Join authors so the panel can render avatars + names without N+1.
  const rows = await db
    .select({
      id: replayComments.id,
      timestampMs: replayComments.timestampMs,
      body: replayComments.body,
      parentId: replayComments.parentId,
      resolved: replayComments.resolved,
      mentionedUserIds: replayComments.mentionedUserIds,
      createdAt: replayComments.createdAt,
      authorId: replayComments.userId,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(replayComments)
    .leftJoin(users, eq(users.id, replayComments.userId))
    .where(eq(replayComments.sessionId, sessionId))
    .orderBy(asc(replayComments.timestampMs), asc(replayComments.createdAt));

  return NextResponse.json({ comments: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const { sessionId } = await params;
  const auth = await authorize(sessionId);
  if (!auth.ok) return auth.resp;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length === 0) return NextResponse.json({ error: "Empty body" }, { status: 400 });
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Body too long" }, { status: 400 });

  const ts = typeof body.timestampMs === "number" ? Math.round(body.timestampMs) : 0;
  if (!Number.isFinite(ts) || ts < 0 || ts > MAX_TIMESTAMP_MS) {
    return NextResponse.json({ error: "Invalid timestampMs" }, { status: 400 });
  }

  // Validate parent: must exist + belong to same session + must be top-level
  // (no nested replies — keeps the UI 1-deep, matches the contract).
  let parentId: string | null = null;
  if (typeof body.parentId === "string") {
    const [parent] = await db
      .select({ id: replayComments.id, parentId: replayComments.parentId })
      .from(replayComments)
      .where(and(eq(replayComments.id, body.parentId), eq(replayComments.sessionId, sessionId)))
      .limit(1);
    if (!parent) return NextResponse.json({ error: "Invalid parentId" }, { status: 400 });
    if (parent.parentId) {
      return NextResponse.json({ error: "Cannot reply to a reply (1-level threading)" }, { status: 400 });
    }
    parentId = parent.id;
  }

  // Resolve @mentions to user ids in the same org. We never expose existence
  // of users outside the org — unmatched emails are silently dropped.
  const mentionEmails = extractMentionEmails(text);
  let mentionedUserIds: string[] = [];
  let mentionedUserDetails: { id: string; email: string }[] = [];
  if (mentionEmails.length > 0) {
    const candidates = await db
      .select({ id: users.id, email: users.email, role: organizationMembers.role })
      .from(users)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, users.id),
          eq(organizationMembers.organizationId, auth.ctx.organizationId),
        ),
      )
      .leftJoin(organizations, eq(organizations.ownerId, users.id))
      .where(
        and(
          inArray(users.email, mentionEmails),
          // user must be either an org member OR the org owner
          or(eq(organizationMembers.organizationId, auth.ctx.organizationId), eq(organizations.id, auth.ctx.organizationId)),
        ),
      );
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      mentionedUserIds.push(c.id);
      if (c.email) mentionedUserDetails.push({ id: c.id, email: c.email });
    }
  }

  const [created] = await db
    .insert(replayComments)
    .values({
      sessionId,
      userId: auth.ctx.userId,
      timestampMs: ts,
      body: text,
      parentId,
      mentionedUserIds,
    })
    .returning();

  // Fire-and-forget email notifications. Don't block the response — the
  // user just wants their comment to land; the email is a nice-to-have.
  if (mentionedUserDetails.length > 0 && created) {
    void notifyMentions({
      sessionId,
      timestampMs: ts,
      authorId: auth.ctx.userId,
      bodyExcerpt: text.slice(0, 240),
      recipients: mentionedUserDetails.filter((u) => u.id !== auth.ctx.userId),
    }).catch((err) => {
      console.warn("[replay-comments] mention notify failed:", err instanceof Error ? err.message : err);
    });
  }

  // Don't echo `mentionedUserIds` back to the caller — that would let an
  // org member harvest "is X in this org?" by spamming POST with @<email>
  // and reading the array. The dashboard refetches via GET to populate
  // its panel, where the join already exposes only org-scoped data.
  const { mentionedUserIds: _omit, ...safe } = created ?? {};
  void _omit;
  return NextResponse.json({ comment: { ...safe, mentionedCount: mentionedUserIds.length } }, { status: 201 });
}

/**
 * Send "@you were mentioned" emails. Best-effort: per-recipient errors are
 * logged but don't propagate. Subject + body kept minimal — the deep link
 * to `/sessions/<id>?t=<ms>` is the call-to-action.
 */
async function notifyMentions(opts: {
  sessionId: string;
  timestampMs: number;
  authorId: string;
  bodyExcerpt: string;
  recipients: { id: string; email: string }[];
}): Promise<void> {
  if (opts.recipients.length === 0) return;
  const [author] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, opts.authorId))
    .limit(1);
  const authorLabel = author?.name || author?.email || "Someone";

  const appUrl = process.env.APP_URL ?? "https://inariwatch.com";
  const link = `${appUrl}/sessions/${encodeURIComponent(opts.sessionId)}?t=${opts.timestampMs}`;
  const subject = `${authorLabel} mentioned you in a replay`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#222">
      <h2 style="margin:0 0 8px;font-size:16px">${escapeHtml(authorLabel)} mentioned you in a replay</h2>
      <p style="margin:0 0 12px;color:#555;font-size:14px">
        At <code>${formatMs(opts.timestampMs)}</code>:
      </p>
      <blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #f97316;background:#fff8f1;color:#222;font-size:14px;white-space:pre-wrap">${escapeHtml(opts.bodyExcerpt)}</blockquote>
      <p style="margin:0">
        <a href="${link}" style="display:inline-block;padding:8px 14px;background:#f97316;color:#fff;text-decoration:none;border-radius:6px;font-size:14px">Open replay at this moment</a>
      </p>
    </div>
  `;

  await Promise.all(opts.recipients.map(async (r) => {
    try {
      await sendEmail({ email: r.email }, subject, html);
    } catch (err) {
      console.warn(`[replay-comments] email to ${r.email} failed:`, err instanceof Error ? err.message : err);
    }
  }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const millis = ms % 1000;
  return `${m}:${String(sec).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
