/**
 * Build runner — populates a fleet bloom from `error_patterns` and stores
 * it in Redis under `fleet:bloom:current` (binary) + `fleet:bloom:meta`
 * (JSON metadata). The public endpoint `GET /api/fleet/bloom/latest` reads
 * from these keys.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Idempotent. Safe to run repeatedly. Skips write if Redis is unavailable.
 *
 * Why Redis (vs S3 / blob storage):
 *   - We already pay for Redis (Hetzner accessory, see project_upstash_migration_plan.md).
 *   - Bloom is small (<2 MB) and replaced wholesale each build.
 *   - One round-trip read on the endpoint hot path.
 *   - SDK-side ETag against the version hash means the body itself
 *     downloads only when content changes (~daily).
 */

import { db } from "@/lib/db"
import { errorPatterns } from "@/lib/db/schema"
import { getRedis } from "@/lib/redis"
import { add, fingerprint, newBloom, serialize, type BloomFilter } from "./bloom"

const REDIS_KEY_BINARY = "fleet:bloom:current"
const REDIS_KEY_META = "fleet:bloom:meta"

export interface BuildStats {
  scanned: number
  inserted: number
  fpr: number
  byteSize: number
  versionTag: string
  durationMs: number
}

export interface BloomMeta {
  versionTag: string
  count: number
  byteSize: number
  fpr: number
  builtAt: string // ISO 8601
}

/**
 * Build a bloom from all known error_patterns rows. Streams the rows so
 * memory stays bounded even at millions of patterns.
 *
 * Returns stats + serialized buffer. Caller decides whether to persist.
 */
export async function buildFleetBloom(opts: {
  m?: number
  k?: number
  /** Optional limit (test override). Default: all rows. */
  limit?: number
} = {}): Promise<{ stats: BuildStats; buffer: Buffer; bloom: BloomFilter }> {
  const t0 = Date.now()
  const bloom = newBloom(opts.m, opts.k)

  // Drizzle's iterator API isn't enabled here — pages of 5K rows is a
  // reasonable middle ground (5K * ~200 bytes per row = 1 MB max in memory).
  const PAGE_SIZE = 5000
  let scanned = 0
  let offset = 0
  let inserted = 0

  while (true) {
    const rows = await db
      .select({ fingerprint: errorPatterns.fingerprint })
      .from(errorPatterns)
      .limit(PAGE_SIZE)
      .offset(offset)

    if (rows.length === 0) break
    for (const row of rows) {
      if (!row.fingerprint) continue
      add(bloom, row.fingerprint)
      inserted++
    }
    scanned += rows.length
    offset += rows.length
    if (opts.limit && inserted >= opts.limit) break
    if (rows.length < PAGE_SIZE) break
  }

  const buffer = serialize(bloom)
  const versionTag = fingerprint(bloom)

  const stats: BuildStats = {
    scanned,
    inserted,
    fpr: bloom.count === 0 ? 0 : Math.pow(1 - Math.exp((-bloom.k * bloom.count) / bloom.m), bloom.k),
    byteSize: buffer.byteLength,
    versionTag,
    durationMs: Date.now() - t0,
  }

  return { stats, buffer, bloom }
}

/**
 * Build + persist to Redis. Returns stats. Failures (Redis down, DB down)
 * are caught and surfaced via stats.scanned === -1 so the cron can log
 * them without throwing.
 */
export async function buildAndPersistFleetBloom(): Promise<BuildStats | { error: string; durationMs: number }> {
  const t0 = Date.now()
  try {
    const { stats, buffer } = await buildFleetBloom()
    const redis = getRedis()
    if (!redis) {
      return { error: "redis-unavailable", durationMs: Date.now() - t0 }
    }
    const meta: BloomMeta = {
      versionTag: stats.versionTag,
      count: stats.inserted,
      byteSize: stats.byteSize,
      fpr: stats.fpr,
      builtAt: new Date().toISOString(),
    }
    // Use base64 because RedisLike.set serializes via JSON, which mangles
    // raw Buffer bytes (loses high bytes on the JSON.stringify path).
    await redis.set(REDIS_KEY_BINARY, buffer.toString("base64"))
    await redis.set(REDIS_KEY_META, meta)
    return stats
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    }
  }
}

/** Read the persisted bloom + meta back from Redis. Returns null if absent. */
export async function loadPersistedBloom(): Promise<{ buffer: Buffer; meta: BloomMeta } | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const [b64, meta] = await Promise.all([
      redis.get<string>(REDIS_KEY_BINARY),
      redis.get<BloomMeta>(REDIS_KEY_META),
    ])
    if (!b64 || !meta) return null
    return { buffer: Buffer.from(b64, "base64"), meta }
  } catch (err) {
    console.warn(
      "[fleet-bloom] redis read failed:",
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

export const FLEET_BLOOM_REDIS_KEYS = {
  BINARY: REDIS_KEY_BINARY,
  META: REDIS_KEY_META,
} as const
