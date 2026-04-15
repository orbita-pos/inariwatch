import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  replaySessions,
  alerts,
  projects,
  remediationSessions,
  organizations,
  organizationMembers,
} from "@/lib/db/schema";
import { and, eq, desc, inArray, or } from "drizzle-orm";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { summarizeChains } from "./helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/replay/[sessionId]/generate-fix
 *
 * Kicks off AI remediation using the replay as ground-truth context.
 *
 * Resolution order for the alert to remediate:
 *   1. replay_sessions.alert_id (direct FK, set when SDK correlates).
 *   2. Most recent alert in the same project whose fingerprint matches
 *      any of the replay's error_fingerprints.
 *
 * If neither produces an alert, returns 400 — replays without a captured
 * error cannot drive remediation.
 */
export async function POST(
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

  const [replay] = await db
    .select()
    .from(replaySessions)
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);

  if (!replay || !replay.organizationId || !replay.projectId) {
    return NextResponse.json({ error: "Replay session not found" }, { status: 404 });
  }

  if (!isReplayV2Enabled(replay.organizationId)) {
    return NextResponse.json({ error: "Replay V2 not enabled" }, { status: 403 });
  }

  // Authorization: user must own the org OR be a member
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
        eq(organizations.id, replay.organizationId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);

  if (!access) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 1. Try direct alert link
  let alertRow: typeof alerts.$inferSelect | undefined;
  if (replay.alertId) {
    [alertRow] = await db
      .select()
      .from(alerts)
      .where(eq(alerts.id, replay.alertId))
      .limit(1);
  }

  // 2. Fallback: fingerprint match in the same project
  if (!alertRow && Array.isArray(replay.errorFingerprints) && replay.errorFingerprints.length > 0) {
    [alertRow] = await db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.projectId, replay.projectId),
          inArray(alerts.fingerprint, replay.errorFingerprints),
        ),
      )
      .orderBy(desc(alerts.createdAt))
      .limit(1);
  }

  if (!alertRow) {
    return NextResponse.json(
      { error: "No linked alert found for this replay — cannot generate fix." },
      { status: 400 },
    );
  }

  // Verify the project exists (belt-and-suspenders — the org check above already proves access)
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, replay.projectId))
    .limit(1);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Compact causal-chain summary for the remediation context — the full
  // chain already lives in replay_sessions.aiChapters.
  const aiChaptersRaw = replay.aiChapters as unknown;
  const chainsSummary = summarizeChains(aiChaptersRaw);

  // Create the remediation session with replay context stored in `context` jsonb
  const [remediation] = await db
    .insert(remediationSessions)
    .values({
      alertId: alertRow.id,
      projectId: project.id,
      userId,
      status: "analyzing",
      attempt: 1,
      maxAttempts: 3,
      steps: [
        {
          id: "replay_trigger",
          type: "info",
          message: `Remediation triggered from replay ${replay.sessionId.slice(0, 12)}…`,
          status: "completed",
          timestamp: new Date().toISOString(),
        },
      ],
      context: {
        triggeredBy: "replay",
        replaySessionId: replay.sessionId,
        replaySummary: replay.aiSummary ?? null,
        replayChains: chainsSummary,
        replayErrorFingerprints: replay.errorFingerprints ?? [],
        replayUrlsVisited: (replay.urlsVisited ?? []).slice(0, 20),
      },
    })
    .returning({ id: remediationSessions.id });

  if (!remediation) {
    return NextResponse.json({ error: "Failed to create remediation session" }, { status: 500 });
  }

  // Fire-and-forget — runs server-side regardless of client disconnect
  void import("@/lib/ai/remediate").then(({ runRemediation }) => {
    runRemediation(remediation.id, () => {}).catch((err) => {
      console.error(`[replay/generate-fix] runRemediation failed:`, err instanceof Error ? err.message : err);
    });
  }).catch((err) => {
    console.error(`[replay/generate-fix] failed to import remediate:`, err instanceof Error ? err.message : err);
  });

  return NextResponse.json({
    ok: true,
    remediationSessionId: remediation.id,
    alertId: alertRow.id,
    streamUrl: `/api/remediation/stream/${remediation.id}`,
    dashboardUrl: `/alerts/${alertRow.id}`,
  });
}

