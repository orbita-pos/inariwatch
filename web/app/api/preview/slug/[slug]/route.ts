import { NextRequest, NextResponse } from "next/server";
import { db, previewPredictions } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  getPreviewBySlug,
  incrementPreviewViewCount,
} from "@/lib/services/preview/session.service";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Preview Fix — public capability URL.
 *
 *   GET /api/preview/slug/:slug
 *
 * No auth. The 60-bit random slug IS the capability; anyone who holds the
 * URL can see the preview. When `revoked_at` is set, we 410 Gone rather
 * than serving stale content.
 *
 * Rate-limited per-IP to slow slug enumeration + protect the DB from spray.
 *
 * Does NOT leak: raw error stacks, project name (unless opted in), or any
 * cross-workspace data. Only the rendered iframe surfaces are returned.
 */
const SLUG_REGEX = /^[A-Z2-7]{12}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  if (!SLUG_REGEX.test(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const preview = await getPreviewBySlug(slug);
  if (!preview) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (preview.revokedAt) {
    return NextResponse.json(
      { error: "This preview has been revoked by the workspace owner." },
      { status: 410 },
    );
  }

  // Best-effort view-count bump — never block the response on this.
  incrementPreviewViewCount(preview.id).catch(() => {});

  let prediction: {
    html: string;
    original: string;
    summary: string;
    confidence: number;
  } | null = null;
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

  const body = JSON.stringify({
    publicSlug: preview.publicSlug,
    live: {
      status: preview.liveStatus,
      url: preview.liveUrl,
      readyAt: preview.liveReadyAt,
      expiresAt: preview.liveExpiresAt,
    },
    prediction: {
      status: preview.predictionStatus,
      html: prediction?.html ?? null,
      originalHtml: prediction?.original ?? null,
      summary: prediction?.summary ?? null,
      confidence: prediction?.confidence ?? null,
    },
    eapReceiptId: preview.eapReceiptId,
    createdAt: preview.createdAt,
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Preview content is mutable while tiers are still in flight. Short
      // edge cache is fine once both are terminal; for simplicity, keep
      // uncached during MVP and tune in Session 2.
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "accept",
      "access-control-max-age": "86400",
    },
  });
}
