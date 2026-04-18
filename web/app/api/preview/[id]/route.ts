import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  alerts,
  db,
  organizationMembers,
  organizations,
  previewPredictions,
  previewSessions,
  projects,
} from "@/lib/db";
import { and, eq, or } from "drizzle-orm";
import { getPreviewById } from "@/lib/services/preview/session.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Preview Fix — authed snapshot of a preview session.
 *
 *   GET /api/preview/:id
 *
 * Returns the full preview row + (if ready) the cached prediction HTML. Used
 * by the embedded PreviewPanel on the alert detail page for initial hydrate
 * and for resume (e.g. after a refresh) without opening an SSE stream.
 *
 * Auth: org membership on the preview's project. Public consumers should go
 * through /api/preview/slug/:slug instead — that endpoint is capability-based.
 */
export async function GET(
  req: NextRequest,
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

  const authed = await authorizePreview(preview.projectId, userId);
  if (!authed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Load the cached prediction if the preview links to one.
  let prediction: { html: string; original: string; summary: string; confidence: number } | null = null;
  if (preview.predictionId) {
    const [row] = await db
      .select({
        html: previewPredictions.predictedHtml,
        original: previewPredictions.originalHtml,
        summary: previewPredictions.diffSummary,
        confidence: previewPredictions.confidence,
      })
      .from(previewPredictions)
      .where(eq(previewPredictions.id, preview.predictionId))
      .limit(1);
    if (row) prediction = row;
  }

  return NextResponse.json({
    id: preview.id,
    publicSlug: preview.publicSlug,
    live: {
      status: preview.liveStatus,
      url: preview.liveUrl,
      error: preview.liveError,
      buildLogs: preview.liveBuildLogs,
      expiresAt: preview.liveExpiresAt,
      readyAt: preview.liveReadyAt,
    },
    prediction: {
      status: preview.predictionStatus,
      error: preview.predictionError,
      html: prediction?.html ?? null,
      originalHtml: prediction?.original ?? null,
      summary: prediction?.summary ?? null,
      confidence: prediction?.confidence ?? null,
    },
    eapReceiptId: preview.eapReceiptId,
    createdAt: preview.createdAt,
    revokedAt: preview.revokedAt,
  });
}

async function authorizePreview(
  projectId: string,
  userId: string,
): Promise<boolean> {
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

// Suppress unused-import warnings for things the auth helper needs via Drizzle.
void alerts;
