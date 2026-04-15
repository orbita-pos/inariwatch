import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { replaySessions, organizationMembers, organizations } from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import { getSessionBlockUrls } from "@/lib/storage/replay-storage";
import { isReplayV2Enabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ManifestResponse {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  browser: string | null;
  os: string | null;
  viewport: unknown;
  alertId: string | null;
  projectId: string | null;
  organizationId: string;
  blockCount: number;
  totalBytes: number;
  clickSelectors: string[];
  urlsVisited: string[];
  errorFingerprints: string[];
  aiSummary: string | null;
  aiChapters: unknown;
  blocks: { index: number; startMs: number; endMs: number; url: string }[];
}

/**
 * GET /api/replay/[sessionId]/manifest
 *
 * Returns metadata + signed R2 URLs for every block in the session.
 * Requires session auth + membership in the session's organization
 * (or ownership of the org). Signed URLs expire in 5 minutes; the
 * client refetches the manifest if it needs more time.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  if (!sessionId || sessionId.length > 128) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  const [row] = await db
    .select({
      id: replaySessions.id,
      sessionId: replaySessions.sessionId,
      organizationId: replaySessions.organizationId,
      projectId: replaySessions.projectId,
      alertId: replaySessions.alertId,
      startedAt: replaySessions.startedAt,
      endedAt: replaySessions.endedAt,
      durationMs: replaySessions.durationMs,
      blockCount: replaySessions.blockCount,
      totalBytes: replaySessions.totalBytes,
      clickSelectors: replaySessions.clickSelectors,
      urlsVisited: replaySessions.urlsVisited,
      errorFingerprints: replaySessions.errorFingerprints,
      browser: replaySessions.browser,
      os: replaySessions.os,
      viewport: replaySessions.viewport,
      aiSummary: replaySessions.aiSummary,
      aiChapters: replaySessions.aiChapters,
    })
    .from(replaySessions)
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);

  if (!row || !row.organizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!isReplayV2Enabled(row.organizationId)) {
    return NextResponse.json({ error: "Replay V2 not enabled" }, { status: 403 });
  }

  // Authorization: user must be the org owner OR a member
  const [access] = await db
    .select({ role: organizationMembers.role, ownerId: organizations.ownerId })
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

  if (!access) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Generate signed URLs for all blocks (5 min TTL)
  let blocks: { index: number; startMs: number; endMs: number; url: string }[];
  try {
    blocks = await getSessionBlockUrls(row.organizationId, row.sessionId, row.blockCount, 300);
  } catch (e) {
    console.error("[replay/manifest] R2 sign failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }

  const response: ManifestResponse = {
    sessionId: row.sessionId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationMs: row.durationMs,
    browser: row.browser,
    os: row.os,
    viewport: row.viewport,
    alertId: row.alertId,
    projectId: row.projectId,
    organizationId: row.organizationId,
    blockCount: row.blockCount,
    totalBytes: row.totalBytes,
    clickSelectors: row.clickSelectors,
    urlsVisited: row.urlsVisited,
    errorFingerprints: row.errorFingerprints,
    aiSummary: row.aiSummary,
    aiChapters: row.aiChapters,
    blocks,
  };

  return NextResponse.json(response);
}
