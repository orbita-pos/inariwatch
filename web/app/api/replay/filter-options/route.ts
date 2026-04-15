/**
 * GET /api/replay/filter-options
 *
 * Returns the distinct values that populate the /replays page filter
 * dropdowns: list of error fingerprints + list of URL paths visited
 * across the active workspace's sessions. Both arrays are capped at 200
 * entries — beyond that the dropdowns become unusable anyway.
 *
 * Auth: dashboard session, org-scoped via `getActiveOrgId`. NOT public.
 *
 * Cache: 60s in Redis (HSET-style key per org). Distinct unnest queries
 * over a 100k-row table take ~150ms and the values barely change between
 * calls, so the hit ratio is high. Falls open if Redis is unavailable.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { replaySessions, organizations, organizationMembers } from "@/lib/db/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_TTL_SECONDS = 60;
const MAX_OPTIONS = 200;

interface FilterOptions {
  fingerprints: string[];
  urlPaths: string[];
}

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const activeOrgId = await getActiveOrgId();
  if (!activeOrgId || !isReplayV2Enabled(activeOrgId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Authorize: same gate as /replays page — owner OR member.
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
        eq(organizations.id, activeOrgId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);

  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const cacheKey = `replay:filter-options:${activeOrgId}`;
  const redis = getRedis();

  if (redis) {
    try {
      const cached = await redis.get<FilterOptions>(cacheKey);
      if (cached) {
        return NextResponse.json(cached, {
          headers: { "x-cache": "hit" },
        });
      }
    } catch {
      // Redis miss/error — fall through to DB. Don't surface the error.
    }
  }

  // Two parallel DISTINCT-unnest queries. Each uses a sequential scan over
  // the org's sessions but is bounded by `LIMIT MAX_OPTIONS`. No index is
  // needed because the working set is small per-org; if a single org grows
  // past ~10k sessions we'll need a materialized view, but that's a future
  // problem (the read latency is fine through ~5k rows).
  const [fpRows, urlRows] = await Promise.all([
    db.execute<{ fingerprint: string }>(sql`
      SELECT DISTINCT unnest(error_fingerprints) AS fingerprint
      FROM replay_sessions
      WHERE organization_id = ${activeOrgId}
      ORDER BY fingerprint
      LIMIT ${MAX_OPTIONS}
    `),
    db.execute<{ url: string }>(sql`
      SELECT DISTINCT unnest(urls_visited) AS url
      FROM replay_sessions
      WHERE organization_id = ${activeOrgId}
      ORDER BY url
      LIMIT ${MAX_OPTIONS}
    `),
  ]);

  const fingerprints: string[] = [];
  for (const r of fpRows.rows) {
    if (typeof r.fingerprint === "string" && r.fingerprint.length > 0) {
      fingerprints.push(r.fingerprint);
    }
  }
  const urlPaths: string[] = [];
  for (const r of urlRows.rows) {
    if (typeof r.url === "string" && r.url.length > 0) urlPaths.push(r.url);
  }

  const payload: FilterOptions = { fingerprints, urlPaths };

  if (redis) {
    try {
      await redis.set(cacheKey, payload, { ex: CACHE_TTL_SECONDS });
    } catch {
      // best-effort cache write
    }
  }

  return NextResponse.json(payload, { headers: { "x-cache": "miss" } });
}
