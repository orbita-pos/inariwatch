import { NextResponse } from "next/server"
import { extractClientIp, checkWebhookRateLimit } from "@/lib/webhooks/rate-limit"
import { rateLimit } from "@/lib/auth-rate-limit"
import { db } from "@/lib/db"
import { errorPatterns } from "@/lib/db/schema"
import { sql } from "drizzle-orm"
import { getRedis } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/fleet/bloom/observe
 *
 * Live-observation contribution path for the fleet bloom. SDKs that opt
 * into `fleetBloomIntegration({ contribute: true })` POST anonymized
 * fingerprints here when they hit a NEW error in production.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Important: this is the LIVE contribution path. Successful post-merge
 * fixes already auto-contribute via `contributeApprovedFix()`
 * (web/lib/ai/contribute-fix.ts) — that's the source of truth for
 * community fixes WITH success rates. This endpoint just expands the
 * bloom's coverage of *known* fingerprints so other SDKs can short-circuit
 * "have we seen this before?" decisions.
 *
 * Request body:
 *   {
 *     fingerprint: string (64 hex chars from SHA-256),
 *     anonymizedTitle?: string (optional, ≤ 200 chars),
 *     framework?: string,
 *     language?: string,
 *   }
 *
 * Auth: none — but rate-limited aggressively. The fingerprint alone is
 * the contribution; no PII is accepted.
 *
 * Rate limits: 100 contributions / minute per IP. Past limit returns 429.
 *
 * Side effects:
 *   - INSERT (or upsert occurrence_count) into `error_patterns`.
 *   - The next daily bloom build picks up the new row.
 */

const FINGERPRINT_REGEX = /^[0-9a-f]{16,64}$/i
const MAX_TITLE_LEN = 200

interface ObserveRequest {
  fingerprint?: unknown
  anonymizedTitle?: unknown
  framework?: unknown
  language?: unknown
}

export async function POST(req: Request): Promise<NextResponse> {
  const ip = extractClientIp(req)
  const ipRl = await checkWebhookRateLimit(ip)
  if (!ipRl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  // Per-IP fine-grained limit on top of the ingest-wide rate limit. 100/min
  // is plenty even for an SDK on a busy app.
  const observeRl = await rateLimit("fleet-bloom-observe", ip, {
    windowMs: 60_000,
    max: 100,
  })
  if (!observeRl.allowed) {
    return NextResponse.json(
      { error: "Observation rate limit reached" },
      { status: 429, headers: { "Retry-After": String(observeRl.retryAfterSeconds ?? 60) } },
    )
  }

  let body: ObserveRequest
  try {
    body = (await req.json()) as ObserveRequest
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (typeof body.fingerprint !== "string" || !FINGERPRINT_REGEX.test(body.fingerprint)) {
    return NextResponse.json({ error: "fingerprint must be 16–64 hex chars" }, { status: 400 })
  }
  const fingerprint = body.fingerprint.toLowerCase()

  // Per-fingerprint dedup: if we've seen this fingerprint within the last
  // 5 min from any IP, just bump the in-memory counter rather than
  // touching the DB. Saves a write on the noisy-pattern path.
  const redis = getRedis()
  if (redis) {
    try {
      const dedupKey = `fleet:bloom:obs:${fingerprint}`
      const acquired = await redis.set(dedupKey, "1", { ex: 300, nx: true })
      if (acquired !== "OK") {
        return NextResponse.json({ ok: true, deduped: true })
      }
    } catch {
      // Redis hiccup → proceed (correctness > optimization).
    }
  }

  const anonymizedTitle =
    typeof body.anonymizedTitle === "string"
      ? body.anonymizedTitle.slice(0, MAX_TITLE_LEN)
      : "(observed via fleet bloom contribute)"
  const framework = typeof body.framework === "string" ? body.framework.slice(0, 64) : null
  const language = typeof body.language === "string" ? body.language.slice(0, 32) : null

  try {
    await db
      .insert(errorPatterns)
      .values({
        fingerprint,
        patternText: anonymizedTitle,
        category: "observed",
        framework,
        language,
        contextSummary: null,
      })
      .onConflictDoUpdate({
        target: errorPatterns.fingerprint,
        set: {
          occurrenceCount: sql`${errorPatterns.occurrenceCount} + 1`,
          lastSeenAt: new Date(),
        },
      })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error(
      "[fleet-bloom-observe] db insert failed:",
      err instanceof Error ? err.message : String(err),
    )
    // Don't leak DB errors to public clients.
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  })
}
