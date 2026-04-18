import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  alerts,
  db,
  organizationMembers,
  organizations,
  projects,
  remediationSessions,
} from "@/lib/db";
import { and, desc, eq, or } from "drizzle-orm";
import { rateLimit } from "@/lib/auth-rate-limit";
import { isPreviewFixEnabled } from "@/lib/feature-flags";
import { getOrCreatePreviewSession } from "@/lib/services/preview/session.service";
import { kickoffTier1 } from "@/lib/services/preview/tier1-live.service";
import { kickoffTier3 } from "@/lib/services/preview/tier3-predict.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Preview Fix — create or fetch endpoint.
 *
 *   POST /api/alerts/:id/preview
 *
 * Idempotent: if a preview_sessions row already exists for (alert_id,
 * latest completed remediation_session_id), returns it. Otherwise creates
 * the row, kicks off Tier 3 (AI prediction, detached) and Tier 1 (Docker
 * deploy, detached), and returns the row so the client can subscribe to
 * the SSE stream for progress.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: alertId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(alertId)) {
    return NextResponse.json({ error: "Invalid alertId" }, { status: 400 });
  }

  const rl = await rateLimit("preview:create", userId, { windowMs: 60_000, max: 3 });
  if (!rl.allowed) {
    const retryAfter = rl.retryAfterSeconds ?? 60;
    return NextResponse.json(
      { error: "Too many preview requests", retryAfterSeconds: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const authed = await authorizeAlert(alertId, userId);
  if (!authed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (
    !isPreviewFixEnabled({
      organizationId: authed.organizationId,
      userId: authed.projectOwnerId,
    })
  ) {
    return NextResponse.json({ error: "Preview Fix not enabled for this workspace" }, { status: 403 });
  }

  // Locate the latest completed+merged remediation for this alert. The panel
  // on the alert detail page only renders when one exists, so a hit here is
  // the expected path; 404 means the client raced a state change.
  const [remediation] = await db
    .select({
      id: remediationSessions.id,
      status: remediationSessions.status,
      mergedCommitSha: remediationSessions.mergedCommitSha,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, alertId))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);

  if (!remediation) {
    return NextResponse.json({ error: "No remediation on this alert" }, { status: 404 });
  }
  if (remediation.status !== "completed") {
    return NextResponse.json(
      { error: "Remediation not completed", status: remediation.status },
      { status: 409 },
    );
  }
  if (!remediation.mergedCommitSha) {
    return NextResponse.json({ error: "Remediation has no merged commit yet" }, { status: 409 });
  }

  const result = await getOrCreatePreviewSession({
    alertId,
    remediationSessionId: remediation.id,
    userId,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  // Kick off both tiers on first creation only. On idempotent re-hits, the
  // detached promises from the first request are already in flight (or done)
  // and firing again would double-charge Claude + double-deploy the container.
  if (result.created) {
    void kickoffTier3(result.session.id);
    void kickoffTier1(result.session.id);
  }

  const origin =
    process.env.APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://app.inariwatch.com");
  const shareUrl = `${origin}/preview/${result.session.publicSlug}`;

  return NextResponse.json(
    {
      id: result.session.id,
      publicSlug: result.session.publicSlug,
      shareUrl,
      liveStatus: result.session.liveStatus,
      liveUrl: result.session.liveUrl,
      predictionStatus: result.session.predictionStatus,
      eapReceiptId: result.session.eapReceiptId,
      streamUrl: `/api/preview/${result.session.id}/stream`,
    },
    { status: result.created ? 201 : 200 },
  );
}

async function authorizeAlert(
  alertId: string,
  userId: string,
): Promise<{ organizationId: string | null; projectId: string; projectOwnerId: string } | null> {
  const [row] = await db
    .select({
      projectId: alerts.projectId,
      ownerId: projects.userId,
      organizationId: projects.organizationId,
    })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!row) return null;
  if (row.ownerId === userId) {
    return { organizationId: row.organizationId, projectId: row.projectId, projectOwnerId: row.ownerId };
  }
  if (!row.organizationId) return null;

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

  return access
    ? { organizationId: row.organizationId, projectId: row.projectId, projectOwnerId: row.ownerId }
    : null;
}
