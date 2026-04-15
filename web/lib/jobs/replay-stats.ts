/**
 * Public replay-platform stats — refreshed by the 5-min cron, served from
 * Redis to the public `/status/replay` page.
 *
 * Why this lives outside the regular dashboard analytics:
 *   1. Public — no auth, must never expose per-customer data
 *   2. High traffic potential (status pages get scraped) — DB query per
 *      request would saturate Neon
 *   3. Deliberately fuzzy — round counts, hide tiny orgs, never list names
 *
 * Refresh strategy: Go scheduler hits /api/cron/replay-stats every 5 min,
 * which calls `computeAndCacheStats()`. Page reads from Redis with a 24h
 * TTL fallback so a missed cron tick still serves something useful.
 */

import { db } from "@/lib/db";
import { replaySessions } from "@/lib/db/schema";
import { and, gte, sql } from "drizzle-orm";
import { getRedis } from "@/lib/redis";

export interface ReplayPublicStats {
  /** Total sessions ingested in the last 24h, rounded to nearest 10. */
  sessions24h: number;
  /** Distinct organizations active in the last 24h, rounded down. */
  activeOrgs24h: number;
  /** Bytes of replay data processed in the last 24h. */
  bytes24h: number;
  /** ISO timestamp of the most recent successful ingest. Null when none. */
  lastIngestAt: string | null;
  /** When this stats snapshot was generated (server time). */
  generatedAt: string;
}

const REDIS_KEY = "replay:public:stats";
const REDIS_TTL_SECONDS = 24 * 60 * 60; // survive a full day of missed crons

/** Round counts to the nearest `step` — public stats shouldn't reveal
 *  exact customer activity to scrapers. Tiny orgs (<step sessions) get
 *  bucketed at 0 which is also the desired behaviour. */
function roundDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

/** Bucket bytes to the nearest 10MB so a scraper can't read precise
 *  per-day throughput (which is a competitive-intelligence leak). */
function roundBytes(bytes: number): number {
  const TEN_MB = 10 * 1024 * 1024;
  return Math.floor(bytes / TEN_MB) * TEN_MB;
}

/**
 * Run the actual aggregation queries against Postgres. Bounded — the
 * date filter uses the `created_at` index on replay_sessions, so this
 * scans at most last-24h rows even at scale.
 */
export async function computeStats(now: Date = new Date()): Promise<ReplayPublicStats> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [agg] = await db
    .select({
      sessions: sql<number>`count(*)::int`,
      orgs: sql<number>`count(distinct ${replaySessions.organizationId})::int`,
      bytes: sql<number>`coalesce(sum(${replaySessions.totalBytes}), 0)::bigint`,
      lastIngestAt: sql<Date | null>`max(${replaySessions.createdAt})`,
    })
    .from(replaySessions)
    .where(
      and(
        gte(replaySessions.createdAt, since),
        sql`${replaySessions.organizationId} IS NOT NULL`,
      ),
    );

  // sql<bigint> arrives as string in node-postgres for safety. Coerce.
  const bytesRaw = agg?.bytes ?? 0;
  const bytes24h = typeof bytesRaw === "bigint"
    ? Number(bytesRaw)
    : typeof bytesRaw === "string"
      ? parseInt(bytesRaw, 10)
      : Number(bytesRaw);

  return {
    sessions24h: roundDown(agg?.sessions ?? 0, 10),
    // Round orgs to nearest 5 — a single-org platform reading "0" or
    // "5" still tells the scraper roughly the scale without leaking
    // exact membership counts (relevant when orgCount is small).
    activeOrgs24h: roundDown(agg?.orgs ?? 0, 5),
    bytes24h: roundBytes(bytes24h),
    lastIngestAt: agg?.lastIngestAt ? new Date(agg.lastIngestAt).toISOString() : null,
    generatedAt: now.toISOString(),
  };
}

/**
 * Compute + write to Redis. Called by the cron route every 5 minutes.
 * Returns the fresh snapshot for log inspection.
 */
export async function computeAndCacheStats(): Promise<ReplayPublicStats> {
  const stats = await computeStats();
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(REDIS_KEY, JSON.stringify(stats), { ex: REDIS_TTL_SECONDS });
    } catch {
      // Redis write failed — log already shows up via cronLog. Page falls
      // back to a fresh DB query the next render.
    }
  }
  return stats;
}

/**
 * Fast path used by the public page. Tries Redis first, falls back to
 * computing from the DB on miss. Always returns SOMETHING — the page is
 * public, can't 500 just because Redis is down.
 */
export async function getPublicStats(): Promise<ReplayPublicStats> {
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get<string | ReplayPublicStats>(REDIS_KEY);
      if (cached) {
        if (typeof cached === "string") return JSON.parse(cached) as ReplayPublicStats;
        return cached;
      }
    } catch {
      // fall through to DB
    }
  }
  return computeStats();
}
