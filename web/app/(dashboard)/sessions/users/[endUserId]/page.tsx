import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  replaySessions,
  organizations,
  organizationMembers,
  projects,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import { ReplayCard } from "../../replay-card";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "User journey" };

/**
 * Aggregated view of every replay session captured for a single end user.
 *
 * Driven by `replay_sessions.end_user_id` (Phase F). The page is the
 * landing target for the user pill in the player header / list card —
 * way more useful than the previous behaviour (filtered list page) for
 * support workflows: "show me everything for juan@acme.com".
 *
 * Auth model mirrors /sessions + /sessions/[sessionId]: org owner or member.
 * Privacy: when the project's `hashEndUserEmails` toggle is on, the raw
 * email + id are masked alongside the same way the list page does it.
 */
export default async function UserJourneyPage({
  params,
}: {
  params: Promise<{ endUserId: string }>;
}) {
  const { endUserId: rawId } = await params;
  const endUserId = decodeURIComponent(rawId);

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const activeOrgId = await getActiveOrgId();
  if (!activeOrgId || !isReplayV2Enabled(activeOrgId)) return notFound();

  // Authorize — same gate as /replays
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

  // Sessions for this user — newest first. Cap at 200 so a user with
  // thousands of sessions doesn't tank the page; the cap matches the
  // implicit limit a reviewer would scroll anyway.
  const rows = await db
    .select({
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
    .where(
      and(
        eq(replaySessions.organizationId, activeOrgId),
        eq(replaySessions.endUserId, endUserId),
      ),
    )
    .orderBy(desc(replaySessions.startedAt))
    .limit(200);

  if (rows.length === 0) {
    // Don't 404 — the user might have existed historically but all sessions
    // were retention-swept. Tell the reviewer instead of guessing why.
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="rounded-xl border border-dashed border-line py-16 text-center">
          <p className="text-sm font-medium text-fg-strong">No sessions for this user</p>
          <p className="mt-1 text-xs text-fg-base/60 font-mono">{endUserId}</p>
          <p className="mt-3 text-xs text-fg-base/60">
            Either the user hasn&apos;t triggered a recording, or all sessions have been
            retention-swept. The user id stays valid — new sessions will appear here.
          </p>
        </div>
      </div>
    );
  }

  // Per-row hashEndUserEmails resolution (sessions can come from multiple
  // projects in the same workspace) — same pattern as the /replays page.
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

  // Aggregate stats — single pass over the bounded slice.
  let withErrors = 0;
  let totalDurationMs = 0;
  let durationSamples = 0;
  let sumBytes = 0;
  for (const r of rows) {
    if ((r.errorFingerprints ?? []).length > 0) withErrors++;
    if (typeof r.durationMs === "number" && r.durationMs > 0) {
      totalDurationMs += r.durationMs;
      durationSamples++;
    }
    sumBytes += r.totalBytes ?? 0;
  }
  const avgDurationMs = durationSamples > 0 ? Math.round(totalDurationMs / durationSamples) : 0;
  const lastSeen = rows[0].startedAt;

  // Best display label — first non-null email if any project allows it,
  // otherwise the id, otherwise hash. Matches the card's `endUserLabel`.
  const displayLabel = (() => {
    for (const r of rows) {
      const proj = r.projectId;
      const hash = proj ? hashEmailMap.get(proj) === true : false;
      if (!hash && r.endUserEmail) return r.endUserEmail;
    }
    return endUserId;
  })();

  return (
    <div className="space-y-6">
      <BackLink />

      {/* Header — primary identity + jump to filtered list for power users */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-fg-base/40">End user</p>
          <h1 className="mt-1 truncate text-2xl font-semibold text-fg-strong tracking-tight" title={displayLabel}>
            {displayLabel}
          </h1>
          <p className="mt-1 font-mono text-xs text-fg-base/50" title={endUserId}>{endUserId}</p>
        </div>
        <Link
          href={`/replays?endUserId=${encodeURIComponent(endUserId)}`}
          className="self-start text-xs text-inari-accent underline underline-offset-2 hover:text-inari-accent/80 sm:self-end"
        >
          Open in /replays with filters →
        </Link>
      </div>

      {/* Aggregates strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Sessions" value={String(rows.length)} hint={rows.length >= 200 ? "showing latest 200" : undefined} />
        <Stat label="With errors" value={String(withErrors)} tone={withErrors > 0 ? "warning" : "neutral"} />
        <Stat label="Avg duration" value={formatDuration(avgDurationMs)} />
        <Stat label="Last seen" value={formatRelative(lastSeen)} />
      </div>

      {/* Session list — reuse the same ReplayCard for visual consistency
          with /replays so the user doesn't have to re-learn the badges. */}
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

      <p className="text-center text-[10px] text-fg-base/40">
        Total storage for this user: {formatBytes(sumBytes)}
      </p>
    </div>
  );
}

// ── Presentational helpers ──────────────────────────────────────────────

function BackLink() {
  return (
    <Link
      href="/sessions"
      className="inline-flex items-center gap-1 text-xs text-fg-base/60 hover:text-fg-base"
    >
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
      All sessions
    </Link>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "warning";
}) {
  const valueClass = tone === "warning" && value !== "0"
    ? "text-amber-600 dark:text-amber-400"
    : "text-fg-strong";
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-fg-base/50">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {hint && <p className="text-[10px] text-fg-base/40">{hint}</p>}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(d: Date): string {
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)}d ago`;
  return d.toISOString().slice(0, 10);
}

