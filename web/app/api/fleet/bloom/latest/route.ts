import { NextResponse } from "next/server"
import { extractClientIp, checkWebhookRateLimit } from "@/lib/webhooks/rate-limit"
import { loadPersistedBloom } from "@/lib/fleet-bloom/build"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/fleet/bloom/latest
 *
 * Public endpoint serving the most-recent fleet bloom built by
 * `/api/cron/build-fleet-bloom`. Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * - HEAD support: clients can fetch only the meta (via X-Bloom-* headers)
 *   without downloading 2 MB.
 * - ETag = bloom version tag (SHA-256 prefix of the serialized bloom).
 *   Clients send `If-None-Match: "<tag>"` and get 304 when unchanged.
 * - Cache: short max-age (5 min) so propagation after a build is fast,
 *   but `stale-while-revalidate` lets edges serve quickly.
 * - Rate-limited per-IP. Receipts are public + low-frequency (SDK refreshes
 *   ~daily) so the limit can be aggressive without hurting real users.
 *
 * Response on hit (200):
 *   binary application/octet-stream
 *   X-Bloom-Version, X-Bloom-Count, X-Bloom-FPR, X-Bloom-Built-At
 *
 * Response when no bloom built yet (503):
 *   { error: "no fleet bloom available yet — wait for the daily build" }
 */
export async function GET(req: Request): Promise<NextResponse | Response> {
  const ip = extractClientIp(req)
  const rl = await checkWebhookRateLimit(ip)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  const loaded = await loadPersistedBloom()
  if (!loaded) {
    return NextResponse.json(
      { error: "no fleet bloom available yet — wait for the daily build" },
      { status: 503 },
    )
  }

  const ifNoneMatch = req.headers.get("if-none-match")?.replace(/^"|"$/g, "")
  if (ifNoneMatch && ifNoneMatch === loaded.meta.versionTag) {
    return new Response(null, {
      status: 304,
      headers: bloomHeaders(loaded.meta),
    })
  }

  return new Response(loaded.buffer, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(loaded.buffer.byteLength),
      ...bloomHeaders(loaded.meta),
    },
  })
}

export async function HEAD(req: Request): Promise<Response> {
  const loaded = await loadPersistedBloom()
  if (!loaded) {
    return new Response(null, { status: 503 })
  }
  return new Response(null, {
    status: 200,
    headers: {
      "content-length": String(loaded.buffer.byteLength),
      ...bloomHeaders(loaded.meta),
    },
  })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-expose-headers":
        "X-Bloom-Version, X-Bloom-Count, X-Bloom-FPR, X-Bloom-Built-At",
      "access-control-max-age": "86400",
    },
  })
}

function bloomHeaders(meta: { versionTag: string; count: number; fpr: number; builtAt: string }): Record<string, string> {
  return {
    etag: `"${meta.versionTag}"`,
    "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    "x-bloom-version": meta.versionTag,
    "x-bloom-count": String(meta.count),
    "x-bloom-fpr": meta.fpr.toExponential(2),
    "x-bloom-built-at": meta.builtAt,
    "access-control-allow-origin": "*",
    "access-control-expose-headers":
      "X-Bloom-Version, X-Bloom-Count, X-Bloom-FPR, X-Bloom-Built-At",
  }
}
