import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { replaySessions, organizations, organizationMembers } from "@/lib/db/schema";
import { and, eq, desc, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { parseReplayFilters, sinceToDate, hasActiveFilters, toLikePattern, paginationInfo, PAGE_SIZE } from "@/lib/replay-filters";
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

  const sinceDate = sinceToDate(filters.since);
  if (sinceDate) conditions.push(gte(replaySessions.startedAt, sinceDate));

  if (filters.errorsOnly) {
    conditions.push(sql`array_length(${replaySessions.errorFingerprints}, 1) > 0`);
  }

  if (filters.browser.length > 0) {
    conditions.push(ilike(replaySessions.browser, toLikePattern(filters.browser)));
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
    })
      .from(replaySessions)
      .where(whereClause)
      .orderBy(desc(replaySessions.startedAt))
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
