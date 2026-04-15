import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { replaySessions, organizations, organizationMembers, projects } from "@/lib/db/schema";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { parseReplayFilters, sinceToDate, hasActiveFilters, toLikePattern, paginationInfo, PAGE_SIZE } from "@/lib/replay-filters";
import { sha256Lower } from "@/lib/hash";
import { ReplaysFilters } from "./replays-filters";
import { ReplayCard } from "./replay-card";
import { ReplaysPagination } from "./replays-pagination";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Replays" };

export default async function ReplaysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const activeOrgId = await getActiveOrgId();
  if (!activeOrgId || !isReplayV2Enabled(activeOrgId)) {
    // V2 is workspace-scoped — personal workspaces and non-enrolled orgs
    // don't see the page at all. The nav link is hidden in the same
    // conditions.
    return notFound();
  }

  // Authorize: user must be org owner or member
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

  if (!access) return notFound();

  const rawParams = await searchParams;
  const filters = parseReplayFilters(rawParams);

  // Build WHERE clause
  const conditions: SQL[] = [eq(replaySessions.organizationId, activeOrgId)];

  // Absolute date range wins over the rolling `since` window. If the user
  // sets dateFrom/dateTo via the calendar inputs, we ignore `since`.
  const hasAbsoluteRange = filters.dateFrom !== null || filters.dateTo !== null;
  if (hasAbsoluteRange) {
    if (filters.dateFrom) conditions.push(gte(replaySessions.startedAt, filters.dateFrom));
    if (filters.dateTo) conditions.push(lte(replaySessions.startedAt, filters.dateTo));
  } else {
    const sinceDate = sinceToDate(filters.since);
    if (sinceDate) conditions.push(gte(replaySessions.startedAt, sinceDate));
  }

  if (filters.errorsOnly) {
    conditions.push(sql`array_length(${replaySessions.errorFingerprints}, 1) > 0`);
  }

  if (filters.browser.length > 0) {
    conditions.push(ilike(replaySessions.browser, toLikePattern(filters.browser)));
  }

  // Exact-match fingerprint filter — uses Postgres `= ANY(array)` so the
  // GIN index on error_fingerprints (if present) can be consulted.
  if (filters.fingerprint.length > 0) {
    conditions.push(sql`${filters.fingerprint} = ANY(${replaySessions.errorFingerprints})`);
  }

  // urlPath uses the same EXISTS-unnest pattern as `q` but scoped to URLs
  // only — the user already chose a path-style search via the URL filter.
  if (filters.urlPath.length > 0) {
    const urlPattern = toLikePattern(filters.urlPath);
    conditions.push(sql`EXISTS (
      SELECT 1 FROM unnest(${replaySessions.urlsVisited}) AS u WHERE u ILIKE ${urlPattern}
    )`);
  }

  // Phase E — frustration toggles. Each uses the functional index added in
  // migration 0050 (`replay_sessions_rage_count_idx` / `_dead_count_idx`)
  // so even on large orgs this is a cheap predicate.
  if (filters.hasRageClicks) {
    conditions.push(sql`jsonb_array_length(${replaySessions.rageClicks}) > 0`);
  }
  if (filters.hasDeadClicks) {
    conditions.push(sql`jsonb_array_length(${replaySessions.deadClicks}) > 0`);
  }

  // Phase F — end-user filters. id is exact-match (the SDK ships a stable
  // app-side id). Email is matched on the SHA-256 hash, NOT plain text, so
  // workspaces with `hashEndUserEmails: true` aren't reduced to an
  // enumeration oracle (a viewer iterating `?endUserEmail=a`, `b`, `c`…
  // would otherwise learn which addresses exist behind the privacy
  // toggle). Side effect: partial matches like "@acme.com" no longer work
  // via this filter — use the URL-contains filter for that.
  if (filters.endUserId.length > 0) {
    conditions.push(eq(replaySessions.endUserId, filters.endUserId));
  }
  if (filters.endUserEmail.length > 0) {
    const inputHash = sha256Lower(filters.endUserEmail);
    if (inputHash) conditions.push(eq(replaySessions.endUserEmailHash, inputHash));
  }

  if (filters.q.length > 0) {
    const pattern = toLikePattern(filters.q);
    // Search click_selectors OR urls_visited — unnest each once per row and
    // short-circuit via EXISTS so Postgres stops on first match.
    conditions.push(sql`(
      EXISTS (SELECT 1 FROM unnest(${replaySessions.clickSelectors}) AS s WHERE s ILIKE ${pattern})
      OR
      EXISTS (SELECT 1 FROM unnest(${replaySessions.urlsVisited}) AS u WHERE u ILIKE ${pattern})
    )`);
  }

  const whereClause = and(...conditions);

  // Map the validated `sortBy` (parseReplayFilters guarantees one of the
  // 3 enum values) to the actual Drizzle column. The orderBy direction is
  // applied by wrapping in asc/desc — keeps the SQL readable + safe from
  // injection (no string interpolation).
  const sortColumn = (() => {
    switch (filters.sortBy) {
      case "durationMs": return replaySessions.durationMs;
      case "totalBytes": return replaySessions.totalBytes;
      case "createdAt":  // fall-through — startedAt is the user-visible "created"
      default: return replaySessions.startedAt;
    }
  })();
  const orderClause = filters.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  // Fetch data + count in parallel
  const [rows, countRows, distinctBrowsers] = await Promise.all([
    db.select({
      id: replaySessions.id,
      sessionId: replaySessions.sessionId,
      startedAt: replaySessions.startedAt,
      durationMs: replaySessions.durationMs,
      browser: replaySessions.browser,
      os: replaySessions.os,
      blockCount: replaySessions.blockCount,
      totalBytes: replaySessions.totalBytes,
      urlsVisited: replaySessions.urlsVisited,
      errorFingerprints: replaySessions.errorFingerprints,
      aiSummary: replaySessions.aiSummary,
      rageClicks: replaySessions.rageClicks,
      deadClicks: replaySessions.deadClicks,
      endUserId: replaySessions.endUserId,
      endUserEmail: replaySessions.endUserEmail,
      endUserEmailHash: replaySessions.endUserEmailHash,
      webVitals: replaySessions.webVitals,
      projectId: replaySessions.projectId,
    })
      .from(replaySessions)
      .where(whereClause)
      .orderBy(orderClause)
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),

    db.select({ count: sql<number>`count(*)::int` })
      .from(replaySessions)
      .where(whereClause),

    db.select({ browser: replaySessions.browser })
      .from(replaySessions)
      .where(and(eq(replaySessions.organizationId, activeOrgId), sql`${replaySessions.browser} IS NOT NULL`))
      .groupBy(replaySessions.browser)
      .limit(20),
  ]);

  const totalCount = countRows[0]?.count ?? 0;
  const pagination = paginationInfo(filters.page, totalCount);
  const active = hasActiveFilters(filters);
  const browserOptions = distinctBrowsers
    .map((r) => (r.browser ?? "").split(" ").slice(0, 2).join(" "))
    .filter((b) => b.length > 0);

  // Phase F — load each row's project privacy setting in one shot. Sessions
  // can come from multiple projects in the same workspace, so we batch.
  // The map is `projectId → hashEndUserEmails`; default false matches the
  // Sentry-style plain-by-default policy.
  const projectIds = Array.from(new Set(rows.map((r) => r.projectId).filter((p): p is string => p != null)));
  const hashEmailMap = new Map<string, boolean>();
  if (projectIds.length > 0) {
    const projRows = await db
      .select({ id: projects.id, replaySettings: projects.replaySettings })
      .from(projects)
      .where(inArray(projects.id, projectIds));
    for (const p of projRows) {
      const settings = (p.replaySettings ?? {}) as { hashEndUserEmails?: boolean };
      hashEmailMap.set(p.id, settings.hashEndUserEmails === true);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Replays</h1>
          <p className="mt-1 text-sm text-fg-base">
            {totalCount} session{totalCount !== 1 ? "s" : ""}{active ? " (filtered)" : ""}
            {pagination.totalPages > 1 ? ` · page ${pagination.page} of ${pagination.totalPages}` : ""}
          </p>
        </div>
      </div>

      {/* Filters */}
      <ReplaysFilters
        q={filters.q}
        errorsOnly={filters.errorsOnly}
        browser={filters.browser}
        since={filters.since}
        fingerprint={filters.fingerprint}
        urlPath={filters.urlPath}
        dateFrom={filters.dateFrom}
        dateTo={filters.dateTo}
        sortBy={filters.sortBy}
        sortDir={filters.sortDir}
        hasRageClicks={filters.hasRageClicks}
        hasDeadClicks={filters.hasDeadClicks}
        endUserId={filters.endUserId}
        endUserEmail={filters.endUserEmail}
        browserOptions={Array.from(new Set(browserOptions))}
      />

      {/* List */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-16 text-center">
          <p className="text-sm font-medium text-fg-strong">
            {active ? "No replays match your filters" : "No replays yet"}
          </p>
          <p className="text-sm text-fg-base">
            {active ? (
              <Link href="/replays" className="text-inari-accent underline underline-offset-2 hover:text-inari-accent/80">
                Clear all filters
              </Link>
            ) : (
              <>
                Install <code className="bg-surface-dim px-1 rounded">@inariwatch/capture</code> with{" "}
                <code className="bg-surface-dim px-1 rounded">replay: true</code> to capture sessions.
              </>
            )}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <ReplayCard
                sessionId={row.sessionId}
                startedAt={row.startedAt.toISOString()}
                durationMs={row.durationMs}
                browser={row.browser}
                os={row.os}
                blockCount={row.blockCount}
                totalBytes={row.totalBytes}
                urlsVisited={row.urlsVisited ?? []}
                errorCount={(row.errorFingerprints ?? []).length}
                aiSummary={row.aiSummary}
                rageCount={Array.isArray(row.rageClicks) ? row.rageClicks.length : 0}
                deadCount={Array.isArray(row.deadClicks) ? row.deadClicks.length : 0}
                // Phase F privacy: when a project has the hash toggle on,
                // both email AND id are masked because customers sometimes
                // pass an email-shaped value as id (e.g. user.id="x@y.com").
                // The dashboard falls back to the hash-based "User …xyz123"
                // pill in that case. The raw id is only suppressed in
                // DISPLAY — the page-level filter still uses it for the
                // exact-match WHERE so deep links survive.
                endUserId={
                  row.projectId && hashEmailMap.get(row.projectId) ? null : row.endUserId
                }
                endUserEmail={
                  row.projectId && hashEmailMap.get(row.projectId) ? null : row.endUserEmail
                }
                endUserEmailHash={row.endUserEmailHash}
                webVitals={(row.webVitals ?? {}) as Record<string, { value: number; rating: "good" | "needs-improvement" | "poor" }>}
              />
            </li>
          ))}
        </ul>
      )}

      {pagination.totalPages > 1 && (
        <ReplaysPagination page={pagination.page} totalPages={pagination.totalPages} />
      )}
    </div>
  );
}
