import type { NextRequest } from "next/server";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db, previewSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import { screenshotR2Key } from "@/lib/services/preview/screenshot.service";

export const runtime = "nodejs";

/**
 * Preview Fix — screenshot proxy.
 *
 *   GET /api/preview/:id/screenshot.png
 *
 * Fetches the preview's hero PNG from R2 (private bucket) and streams it
 * back with immutable cache headers. Vercel's edge CDN caches the response
 * per edge region, so R2 only sees one read per region per preview —
 * Twitter/Slack/LinkedIn unfurls are served from CDN after the first hit,
 * with zero egress cost.
 *
 * Public (no auth): the screenshot exists to be shared, and the preview
 * slug is already a 60-bit unguessable capability. If `revoked_at` is set
 * on the underlying preview we still serve the image — revocation is a
 * UX signal on the landing page, not an attempt to un-cache social unfurls
 * (which we can't un-cache once posted).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new Response("Invalid id", { status: 400 });
  }

  const [row] = await db
    .select({
      screenshotUrl: previewSessions.screenshotUrl,
      screenshotTakenAt: previewSessions.screenshotTakenAt,
    })
    .from(previewSessions)
    .where(eq(previewSessions.id, id))
    .limit(1);
  if (!row || !row.screenshotUrl || !row.screenshotTakenAt) {
    return new Response("Not captured yet", { status: 404 });
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return new Response("Storage not configured", { status: 503 });
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const obj = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: screenshotR2Key(id) }),
  );
  if (!obj.Body) {
    return new Response("Not found in storage", { status: 404 });
  }

  // Stream the R2 body through — Node 18+ ReadableStream is compatible.
  return new Response(obj.Body.transformToWebStream() as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": obj.ContentLength ? String(obj.ContentLength) : "",
      // Immutable — per-preview id is stable and the screenshot is never
      // overwritten; safe to cache for a year at edge + browser.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
