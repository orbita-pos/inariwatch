/**
 * Preview Fix — screenshot capture service.
 *
 * Orchestrates the hand-off: calls the Hetzner worker's `/worker/screenshot`
 * endpoint with the preview URL, uploads the returned PNG to Cloudflare R2
 * (private bucket), and writes the R2 object key to `preview_sessions`.
 *
 * Why R2 over Vercel Blob: R2 has zero egress fees, so every OG unfurl and
 * public-page view of a shared preview is free. Reusing the S3 client +
 * bucket already configured for Replay v2 means no new credentials, no new
 * storage billing line, and the screenshot proxy route below benefits from
 * Vercel's edge cache so R2 reads only happen on first view per region.
 *
 * Called as fire-and-forget from `pollAndStreamTier1Progress` the moment
 * Tier 1 transitions to `running`. The screenshot is intentionally
 * non-blocking: the preview is usable without it (raw URL opens in a new
 * tab fine), and the panel polls the preview row so the image appears
 * inline as soon as it lands — no SSE plumbing needed.
 *
 * Error policy: any failure writes a short reason to
 * `preview_sessions.screenshot_error` and leaves `screenshot_url` null.
 * The panel falls back to the gradient OG card (same as before) and the
 * public page still renders — screenshot is purely additive UX.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db, previewSessions } from "@/lib/db";
import { eq } from "drizzle-orm";

// Generous — the worker internally retries on transient SSL / DNS errors
// (first-cert provisioning on a fresh preview subdomain can take ~10-20s
// under Caddy's ACME DNS-01 flow). Aggregate is well below the 10min
// polling cap that pollAndStreamTier1Progress enforces.
const WORKER_TIMEOUT_MS = 60_000;

function getR2(): { client: S3Client; bucket: string } | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, bucket };
}

function getWorkerConfig(): { url: string; secret: string } | null {
  const url = process.env.WORKER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!url || !secret) return null;
  return { url: url.replace(/\/$/, ""), secret };
}

/**
 * Stable key for the screenshot object in R2. Derivable from the preview
 * id alone — the proxy route reconstructs this key without any extra
 * state, which is why we don't need to store the key in the DB at all.
 * Only success / error timestamps go on the row.
 */
export function screenshotR2Key(previewSessionId: string): string {
  return `preview-screenshots/${previewSessionId}.png`;
}

type CaptureArgs = {
  previewSessionId: string;
  previewUrl: string;
};

/**
 * Fire-and-forget. Callers should `void` this. All failures are persisted
 * on the row as `screenshot_error` — the caller never needs to try/catch.
 */
export async function captureAndStoreScreenshot(args: CaptureArgs): Promise<void> {
  try {
    const workerCfg = getWorkerConfig();
    if (!workerCfg) {
      await writeError(args.previewSessionId, "Worker not configured (WORKER_URL missing)");
      return;
    }
    const r2 = getR2();
    if (!r2) {
      await writeError(args.previewSessionId, "R2 not configured (R2_* env vars missing)");
      return;
    }

    // 1. Ask the worker to render the preview URL.
    const workerRes = await fetch(`${workerCfg.url}/worker/screenshot`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workerCfg.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: args.previewUrl,
        width: 1280,
        height: 800,
        fullPage: false,
      }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });

    if (!workerRes.ok) {
      const text = await workerRes.text().catch(() => "");
      await writeError(
        args.previewSessionId,
        `worker returned ${workerRes.status}: ${text.slice(0, 200)}`,
      );
      return;
    }

    const pngBuffer = Buffer.from(await workerRes.arrayBuffer());
    const width = Number(workerRes.headers.get("x-screenshot-width") ?? 1280);
    const height = Number(workerRes.headers.get("x-screenshot-height") ?? 800);

    if (pngBuffer.length < 100) {
      await writeError(args.previewSessionId, `worker returned empty PNG (${pngBuffer.length}B)`);
      return;
    }

    // 2. Upload to R2 (private bucket). The proxy route
    //    `/api/preview/[id]/screenshot.png` reads from here and streams
    //    with immutable cache headers so Vercel CDN caches the response —
    //    R2 gets one read per edge region per preview, not per social
    //    unfurl.
    const key = screenshotR2Key(args.previewSessionId);
    await r2.client.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: key,
        Body: pngBuffer,
        ContentType: "image/png",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    // 3. Record the screenshot metadata. The public-facing URL is computed
    //    downstream from the preview id — no need to store it.
    await db
      .update(previewSessions)
      .set({
        screenshotUrl: key,
        screenshotTakenAt: new Date(),
        screenshotWidth: width,
        screenshotHeight: height,
        screenshotError: null,
        updatedAt: new Date(),
      })
      .where(eq(previewSessions.id, args.previewSessionId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeError(args.previewSessionId, msg.slice(0, 500));
  }
}

async function writeError(previewSessionId: string, error: string): Promise<void> {
  await db
    .update(previewSessions)
    .set({
      screenshotError: error,
      updatedAt: new Date(),
    })
    .where(eq(previewSessions.id, previewSessionId));
}
