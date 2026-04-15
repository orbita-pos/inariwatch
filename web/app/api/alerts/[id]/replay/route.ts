import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { alerts, replaySessions, projects, organizations, organizationMembers } from "@/lib/db/schema";
import { and, eq, desc, or, sql } from "drizzle-orm";
import { isReplayV2Enabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReplayLink {
  sessionId: string;
  startedAt: string;
  durationMs: number | null;
  hasAiSummary: boolean;
}

/**
 * GET /api/alerts/[id]/replay
 *
 * Returns the best-matching Replay V2 session for this alert, if any.
 * Lookup order:
 *   1. Direct alert_id link on replay_sessions.
 *   2. Most recent replay in the same project whose error_fingerprints
 *      array contains the alert's fingerprint.
 *
 * Used by the alert detail page to render a "View replay" deep-link.
 * Returns `{ replay: null }` when no correlation exists — never 404s.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: alertId } = await params;
  if (!alertId) {
    return NextResponse.json({ error: "Invalid alertId" }, { status: 400 });
  }

  // Load the alert + its project's organization. Authorization follows the
  // same org-membership pattern as /api/replay/[sessionId]/manifest — owners
  // and members both see the replay link, consistent with /replays access.
  const [alertRow] = await db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      fingerprint: alerts.fingerprint,
      organizationId: projects.organizationId,
    })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alertRow || !alertRow.organizationId) {
    // Don't leak existence — 200 with null (same-shape as no-replay case)
    return NextResponse.json({ replay: null });
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
        eq(organizations.id, alertRow.organizationId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);

  if (!access) {
    return NextResponse.json({ replay: null });
  }

  // 1. Direct link
  let [replay] = await db
    .select({
      sessionId: replaySessions.sessionId,
      startedAt: replaySessions.startedAt,
      durationMs: replaySessions.durationMs,
      aiSummary: replaySessions.aiSummary,
      organizationId: replaySessions.organizationId,
    })
    .from(replaySessions)
    .where(eq(replaySessions.alertId, alertRow.id))
    .orderBy(desc(replaySessions.startedAt))
    .limit(1);

  // 2. Fingerprint match fallback — use `= ANY(array)` so we match any
  // session whose error_fingerprints array CONTAINS the alert's fingerprint,
  // not just sessions whose array equals [fingerprint] exactly. The previous
  // `inArray(col, [[fp]])` generated `col IN (ARRAY[fp])` which required
  // exact array equality and almost never matched in practice.
  if (!replay && alertRow.fingerprint) {
    [replay] = await db
      .select({
        sessionId: replaySessions.sessionId,
        startedAt: replaySessions.startedAt,
        durationMs: replaySessions.durationMs,
        aiSummary: replaySessions.aiSummary,
        organizationId: replaySessions.organizationId,
      })
      .from(replaySessions)
      .where(
        and(
          eq(replaySessions.projectId, alertRow.projectId),
          sql`${alertRow.fingerprint} = ANY(${replaySessions.errorFingerprints})`,
        ),
      )
      .orderBy(desc(replaySessions.startedAt))
      .limit(1);
  }

  if (!replay) return NextResponse.json({ replay: null });

  // Feature flag gate — hide the link from orgs that don't have V2 enabled
  if (!isReplayV2Enabled(replay.organizationId)) {
    return NextResponse.json({ replay: null });
  }

  const response: { replay: ReplayLink } = {
    replay: {
      sessionId: replay.sessionId,
      startedAt: replay.startedAt.toISOString(),
      durationMs: replay.durationMs,
      hasAiSummary: !!replay.aiSummary,
    },
  };
  return NextResponse.json(response);
}
