import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { replaySessions, projects, organizationMembers, organizations, codeRepositories } from "@/lib/db/schema";
import { DEFAULT_REPLAY_SETTINGS, type ReplaySettings } from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import { getSessionBlockUrls } from "@/lib/storage/replay-storage";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import {
  aggregateBackendEvents,
  aggregateAiEvents,
  crossLinkBackendAndAi,
  type BackendEvent,
  type AiEvent,
} from "@/lib/fulltrace/manifest-aggregator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ManifestResponse {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  browser: string | null;
  os: string | null;
  viewport: unknown;
  alertId: string | null;
  projectId: string | null;
  organizationId: string;
  blockCount: number;
  totalBytes: number;
  clickSelectors: string[];
  urlsVisited: string[];
  errorFingerprints: string[];
  aiSummary: string | null;
  aiChapters: unknown;
  // Phase E — frustration signals (timestamps already session-relative,
  // populated by lib/jobs/replay-analyze.ts). Empty arrays for sessions
  // that haven't been analyzed yet.
  rageClicks: { timestamp: number; selector: string; count: number }[];
  deadClicks: { timestamp: number; selector: string; mutationsAfter: number }[];
  frustrationScore: number;
  /** Phase F — end-user identity. `email` is null when the project's
   *  `hashEndUserEmails` toggle is on; `emailHash` is always present
   *  alongside (sha256 lowercased) so the UI can display a stable mask. */
  endUser: { id: string | null; email: string | null; emailHash: string | null } | null;
  /** Phase G — Core Web Vitals snapshot. Empty object for sessions that
   *  predate Phase G or where the SDK never observed a metric (headless,
   *  Node, very short sessions). */
  webVitals: Record<string, { value: number; rating: "good" | "needs-improvement" | "poor" }>;
  /** Phase I.c — pre-parsed errors with stack frames. Empty array when
   *  the session had no uncaught errors. The `repo` field carries the
   *  github owner/repo of the linked code repository (if any) so the
   *  player can render "open in GitHub" links per frame. */
  resolvedErrors: unknown[];
  repo: { githubOwner: string; githubRepo: string; defaultBranch: string } | null;
  blocks: { index: number; startMs: number; endMs: number; url: string }[];
  /** VAR Q1 — FullTrace backend track. Substrate I/O events from every
   *  recording with a matching session_id, normalized to session-relative ms. */
  backendEvents: BackendEvent[];
  /** VAR Q1 — FullTrace AI track. Alerts + diagnoses + remediation steps
   *  for this session, in chronological order. */
  aiEvents: AiEvent[];
}

/**
 * GET /api/replay/[sessionId]/manifest
 *
 * Returns metadata + signed R2 URLs for every block in the session.
 * Requires session auth + membership in the session's organization
 * (or ownership of the org). Signed URLs expire in 5 minutes; the
 * client refetches the manifest if it needs more time.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  if (!sessionId || sessionId.length > 128) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  const [row] = await db
    .select({
      id: replaySessions.id,
      sessionId: replaySessions.sessionId,
      organizationId: replaySessions.organizationId,
      projectId: replaySessions.projectId,
      alertId: replaySessions.alertId,
      startedAt: replaySessions.startedAt,
      endedAt: replaySessions.endedAt,
      durationMs: replaySessions.durationMs,
      blockCount: replaySessions.blockCount,
      totalBytes: replaySessions.totalBytes,
      clickSelectors: replaySessions.clickSelectors,
      urlsVisited: replaySessions.urlsVisited,
      errorFingerprints: replaySessions.errorFingerprints,
      browser: replaySessions.browser,
      os: replaySessions.os,
      viewport: replaySessions.viewport,
      aiSummary: replaySessions.aiSummary,
      aiChapters: replaySessions.aiChapters,
      rageClicks: replaySessions.rageClicks,
      deadClicks: replaySessions.deadClicks,
      frustrationScore: replaySessions.frustrationScore,
      endUserId: replaySessions.endUserId,
      endUserEmail: replaySessions.endUserEmail,
      endUserEmailHash: replaySessions.endUserEmailHash,
      webVitals: replaySessions.webVitals,
      resolvedErrors: replaySessions.resolvedErrors,
    })
    .from(replaySessions)
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);

  if (!row || !row.organizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!isReplayV2Enabled(row.organizationId)) {
    return NextResponse.json({ error: "Replay V2 not enabled" }, { status: 403 });
  }

  // Authorization: user must be the org owner OR a member
  const [access] = await db
    .select({ role: organizationMembers.role, ownerId: organizations.ownerId })
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
        eq(organizations.id, row.organizationId),
        or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
      ),
    )
    .limit(1);

  if (!access) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Generate signed URLs for all blocks (5 min TTL)
  let blocks: { index: number; startMs: number; endMs: number; url: string }[];
  try {
    blocks = await getSessionBlockUrls(row.organizationId, row.sessionId, row.blockCount, 300);
  } catch (e) {
    console.error("[replay/manifest] R2 sign failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  }

  // VAR Q1 — FullTrace data fetched in parallel with the rest. Aggregator
  // returns [] when no Substrate / AI activity exists, so the player's
  // panels gracefully render an empty state instead of erroring.
  const baseTimeMs = row.startedAt.getTime();
  const [backendEvents, aiEvents, endUserPayload, repoPayload] = await Promise.all([
    aggregateBackendEvents(row.sessionId, baseTimeMs).catch((e) => {
      console.error("[replay/manifest] aggregateBackendEvents failed:", e instanceof Error ? e.message : e);
      return [];
    }),
    aggregateAiEvents(row.sessionId, baseTimeMs).catch((e) => {
      console.error("[replay/manifest] aggregateAiEvents failed:", e instanceof Error ? e.message : e);
      return [];
    }),
    buildEndUserPayload(row.projectId, row.endUserId, row.endUserEmail, row.endUserEmailHash),
    buildRepoPayload(row.projectId),
  ]);

  // Final cross-link pass: alerts ↔ backend exceptions / 5xx. Mutates
  // both arrays in place. Cheap (O(alerts × failures), both small).
  crossLinkBackendAndAi(backendEvents, aiEvents);

  const response: ManifestResponse = {
    sessionId: row.sessionId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationMs: row.durationMs,
    browser: row.browser,
    os: row.os,
    viewport: row.viewport,
    alertId: row.alertId,
    projectId: row.projectId,
    organizationId: row.organizationId,
    blockCount: row.blockCount,
    totalBytes: row.totalBytes,
    clickSelectors: row.clickSelectors,
    urlsVisited: row.urlsVisited,
    errorFingerprints: row.errorFingerprints,
    aiSummary: row.aiSummary,
    aiChapters: row.aiChapters,
    rageClicks: Array.isArray(row.rageClicks) ? (row.rageClicks as ManifestResponse["rageClicks"]) : [],
    deadClicks: Array.isArray(row.deadClicks) ? (row.deadClicks as ManifestResponse["deadClicks"]) : [],
    frustrationScore: row.frustrationScore ?? 0,
    endUser: endUserPayload,
    webVitals: (row.webVitals ?? {}) as ManifestResponse["webVitals"],
    resolvedErrors: Array.isArray(row.resolvedErrors) ? row.resolvedErrors : [],
    repo: repoPayload,
    blocks,
    backendEvents,
    aiEvents,
  };

  return NextResponse.json(response);
}

/**
 * Build the manifest's `endUser` payload, applying the project's privacy
 * toggle. When `hashEndUserEmails` is true, the raw email is dropped and
 * only the hash flows to the client. Returns null when no identity was
 * captured at all (the typical case for sessions whose host page never
 * set `window.__INARIWATCH_USER__`).
 */
async function buildEndUserPayload(
  projectId: string | null,
  endUserId: string | null,
  endUserEmail: string | null,
  endUserEmailHash: string | null,
): Promise<ManifestResponse["endUser"]> {
  if (!endUserId && !endUserEmail && !endUserEmailHash) return null;

  let hashEmails = DEFAULT_REPLAY_SETTINGS.hashEndUserEmails;
  if (projectId) {
    const [proj] = await db
      .select({ replaySettings: projects.replaySettings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const settings = (proj?.replaySettings ?? {}) as ReplaySettings;
    hashEmails = settings.hashEndUserEmails ?? DEFAULT_REPLAY_SETTINGS.hashEndUserEmails;
  }

  return {
    // Mask id alongside email when the toggle is on. Customers occasionally
    // ship `user.id` as an email-shaped value (e.g. when their app uses
    // email as the primary key); without this, the toggle would protect
    // emails-via-email but leak emails-via-id.
    id: hashEmails ? null : endUserId,
    // When the privacy toggle is on, the raw email must not leave the server.
    // We still surface the hash so the dashboard can render a stable "User …abc12" pill.
    email: hashEmails ? null : endUserEmail,
    emailHash: endUserEmailHash,
  };
}

/**
 * Look up the project's linked GitHub repo so the player's Errors panel
 * can build "open in GitHub" links per stack frame. Returns null when no
 * code repository is connected — the panel falls back to plain frame text.
 */
async function buildRepoPayload(
  projectId: string | null,
): Promise<ManifestResponse["repo"]> {
  if (!projectId) return null;
  const [row] = await db
    .select({
      githubOwner: codeRepositories.githubOwner,
      githubRepo: codeRepositories.githubRepo,
      defaultBranch: codeRepositories.defaultBranch,
    })
    .from(codeRepositories)
    .where(eq(codeRepositories.projectId, projectId))
    .limit(1);
  if (!row) return null;
  return {
    githubOwner: row.githubOwner,
    githubRepo: row.githubRepo,
    defaultBranch: row.defaultBranch,
  };
}
