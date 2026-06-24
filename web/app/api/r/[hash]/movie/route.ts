import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import {
  alerts,
  projects,
  apiKeys,
  organizationMembers,
  replaySessions,
  remediationSessions,
  previewSessions,
  previewPredictions,
} from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { parseInariHash } from "@/lib/inari-hash";
import { eq, desc, and } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (!token) return null;
    const desktopKeys = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.service, "desktop"));
    const keyRow = desktopKeys.find((k) => {
      try {
        const stored = Buffer.from(decrypt(k.keyEncrypted ?? ""));
        const provided = Buffer.from(token);
        if (stored.length !== provided.length) return false;
        return crypto.timingSafeEqual(stored, provided);
      } catch {
        return false;
      }
    });
    return keyRow?.userId ?? null;
  }
  const session = await getServerSession(authOptions);
  return (session?.user as { id?: string } | undefined)?.id ?? null;
}

async function canAccessProject(userId: string, projectId: string): Promise<boolean> {
  const [proj] = await db
    .select({ ownerId: projects.userId, orgId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) return false;
  if (proj.ownerId === userId) return true;
  if (!proj.orgId) return false;
  const [membership] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, proj.orgId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return !!membership;
}

/**
 * GET /api/r/[hash]/movie
 *
 * Movie manifest — single call that returns all phases of an incident:
 * session (rrweb), error (diagnosis), fix (remediation), preview (before/after).
 *
 * Auth: NextAuth session (web) or Bearer desktop token (Inari Live).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { hash } = await params;
  const parsed = parseInariHash(decodeURIComponent(hash));
  if (!parsed || parsed.type !== "alert") {
    return NextResponse.json({ error: "invalid_hash" }, { status: 400 });
  }

  const fullHash = hash.startsWith("inari:") ? hash : `inari:alert:${parsed.hex}`;

  // Load alert
  const [alert] = await db
    .select({
      id: alerts.id,
      projectId: alerts.projectId,
      title: alerts.title,
      severity: alerts.severity,
      body: alerts.body,
      aiReasoning: alerts.aiReasoning,
      fingerprint: alerts.fingerprint,
      replaySessionId: alerts.replaySessionId,
      sessionId: alerts.sessionId,
      inariHash: alerts.inariHash,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .where(eq(alerts.inariHash, fullHash))
    .limit(1);

  if (!alert) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const hasAccess = await canAccessProject(userId, alert.projectId);
  if (!hasAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Load replay session + latest remediation in parallel
  const [replayRow, remediationRow] = await Promise.all([
    alert.replaySessionId
      ? db
          .select({
            sessionId: replaySessions.sessionId,
            durationMs: replaySessions.durationMs,
            browser: replaySessions.browser,
            os: replaySessions.os,
            viewport: replaySessions.viewport,
            rageClicks: replaySessions.rageClicks,
            deadClicks: replaySessions.deadClicks,
            webVitals: replaySessions.webVitals,
            urlsVisited: replaySessions.urlsVisited,
            frustrationScore: replaySessions.frustrationScore,
            aiSummary: replaySessions.aiSummary,
            aiChapters: replaySessions.aiChapters,
            endUserEmailHash: replaySessions.endUserEmailHash,
          })
          .from(replaySessions)
          .where(eq(replaySessions.id, alert.replaySessionId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),

    db
      .select({
        id: remediationSessions.id,
        status: remediationSessions.status,
        steps: remediationSessions.steps,
        fileChanges: remediationSessions.fileChanges,
        confidenceScore: remediationSessions.confidenceScore,
        prUrl: remediationSessions.prUrl,
        branch: remediationSessions.branch,
        previewSessionId: remediationSessions.previewSessionId,
        eapReceiptId: remediationSessions.eapReceiptId,
      })
      .from(remediationSessions)
      .where(eq(remediationSessions.alertId, alert.id))
      .orderBy(desc(remediationSessions.createdAt))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  // Load preview if available
  type PreviewData = {
    publicSlug: string;
    screenshotUrl: string | null;
    predictionHtml: string | null;
    originalHtml: string | null;
    diffSummary: string | null;
    confidence: number | null;
  };
  let previewData: PreviewData | null = null;

  if (remediationRow?.previewSessionId) {
    const [ps] = await db
      .select({
        publicSlug: previewSessions.publicSlug,
        predictionId: previewSessions.predictionId,
        screenshotUrl: previewSessions.screenshotUrl,
      })
      .from(previewSessions)
      .where(eq(previewSessions.id, remediationRow.previewSessionId))
      .limit(1);

    if (ps) {
      let pred: {
        predictedHtml: string | null;
        originalHtml: string | null;
        diffSummary: string | null;
        confidence: number | null;
      } | null = null;

      if (ps.predictionId) {
        const [row] = await db
          .select({
            predictedHtml: previewPredictions.predictedHtml,
            originalHtml: previewPredictions.originalHtml,
            diffSummary: previewPredictions.diffSummary,
            confidence: previewPredictions.confidence,
          })
          .from(previewPredictions)
          .where(eq(previewPredictions.id, ps.predictionId))
          .limit(1);
        pred = row ?? null;
      }

      previewData = {
        publicSlug: ps.publicSlug,
        screenshotUrl: ps.screenshotUrl ?? null,
        predictionHtml: pred?.predictedHtml ?? null,
        originalHtml: pred?.originalHtml ?? null,
        diffSummary: pred?.diffSummary ?? null,
        confidence: pred?.confidence ?? null,
      };
    }
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    "https://app.inariwatch.com";

  const fixStatuses = new Set(["completed", "merged", "monitoring"]);
  const hasFix = !!remediationRow && fixStatuses.has(remediationRow.status ?? "");

  const available: string[] = [];
  if (replayRow) available.push("session");
  available.push("error");
  if (hasFix) available.push("fix");
  if (previewData) available.push("preview");

  return NextResponse.json({
    alertId: alert.id,
    inariHash: alert.inariHash,
    available,
    phases: {
      ...(replayRow && {
        session: {
          sessionId: replayRow.sessionId,
          manifestUrl: `${appUrl}/api/replay/${replayRow.sessionId}/manifest`,
          durationMs: replayRow.durationMs,
          browser: replayRow.browser,
          os: replayRow.os,
          viewport: replayRow.viewport,
          rageClicks: replayRow.rageClicks ?? [],
          deadClicks: replayRow.deadClicks ?? [],
          webVitals: replayRow.webVitals ?? {},
          urlsVisited: replayRow.urlsVisited ?? [],
          frustrationScore: replayRow.frustrationScore,
          aiSummary: replayRow.aiSummary,
          aiChapters: replayRow.aiChapters,
          endUserEmailHash: replayRow.endUserEmailHash,
        },
      }),
      error: {
        title: alert.title,
        severity: alert.severity,
        body: alert.body,
        diagnosis: alert.aiReasoning,
        fingerprint: alert.fingerprint,
        occurredAt: alert.createdAt,
      },
      ...(hasFix && {
        fix: {
          remediationId: remediationRow!.id,
          status: remediationRow!.status,
          steps: remediationRow!.steps,
          fileChanges: remediationRow!.fileChanges,
          confidenceScore: remediationRow!.confidenceScore,
          prUrl: remediationRow!.prUrl,
          branch: remediationRow!.branch,
        },
      }),
      ...(previewData && { preview: previewData }),
    },
    witness: {
      inariHash: alert.inariHash,
      eapReceiptId: remediationRow?.eapReceiptId ?? null,
    },
  });
}
