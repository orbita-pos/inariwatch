import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { cronLog, pingCronHealth } from "@/lib/cron-utils";

/**
 * GET /api/cron/pool-rehydrate
 *
 * Fase 2b — keeps the inari-staging warm-container pool populated.
 *
 * Scans remediation_sessions for the top N most-active projects in the
 * last 7 days and calls POST /pool/warm on the Go server for each of
 * them. The Go server's per-project and global caps are the authority;
 * this cron is best-effort: pool-full (HTTP 409) responses are normal
 * and not counted as errors.
 *
 * Kill switch:
 *   - CONTAINER_POOL_ENABLED=false (default) → route is a no-op and
 *     returns {skipped: "pool disabled"} so operators can see the flag
 *     state from the cron response.
 *   - STAGING_SERVER_URL + STAGING_API_SECRET missing → same no-op.
 *
 * Cadence: operator schedules the call every 15 min from the Go server's
 * cron scheduler (internal/cron/scheduler.go). Until that entry lands,
 * the route is callable manually with Bearer CRON_SECRET.
 *
 * Auth: Bearer CRON_SECRET (timing-safe compare) — same gate as every
 * other cron route.
 */

const CRON_SECRET = process.env.CRON_SECRET;
const ROUTE = "pool-rehydrate" as const;

// Scan window + batch sizes — kept as module constants so ops can see
// them without reading code. If operator wants to tune, they go through
// PR review (these aren't per-environment knobs).
const ACTIVE_PROJECTS_WINDOW_DAYS = 7;
const TOP_N_PROJECTS = 50;
const PER_CALL_TIMEOUT_MS = 15_000;

interface ActiveProject {
  projectId: string;
  repo: string | null;
  defaultBranch: string | null;
  sessionCount: number;
}

interface RehydrateOutcome {
  projectId: string;
  status: "warmed" | "pool-full" | "skipped" | "error";
  httpStatus?: number;
  reason?: string;
}

export async function GET(req: Request) {
  const start = Date.now();

  // Timing-safe Bearer CRON_SECRET check. Fail closed when unset.
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.CONTAINER_POOL_ENABLED !== "true") {
    cronLog(ROUTE, { skipped: "pool disabled", duration_ms: Date.now() - start });
    await pingCronHealth(ROUTE, true);
    return NextResponse.json({ ok: true, skipped: "pool disabled" });
  }

  const stagingUrl = process.env.STAGING_SERVER_URL;
  const stagingSecret = process.env.STAGING_API_SECRET;
  if (!stagingUrl || !stagingSecret) {
    cronLog(ROUTE, { skipped: "staging not configured", duration_ms: Date.now() - start });
    await pingCronHealth(ROUTE, true);
    return NextResponse.json({ ok: true, skipped: "staging not configured" });
  }

  const active = await selectActiveProjects();
  const outcomes = await Promise.all(
    active.map((p) => rehydrateProject(p, stagingUrl, stagingSecret)),
  );

  const warmed = outcomes.filter((o) => o.status === "warmed").length;
  const poolFull = outcomes.filter((o) => o.status === "pool-full").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const errors = outcomes.filter((o) => o.status === "error");

  cronLog(ROUTE, {
    scanned: active.length,
    warmed,
    pool_full: poolFull,
    skipped,
    errors: errors.length,
    duration_ms: Date.now() - start,
  });
  await pingCronHealth(ROUTE, errors.length === 0);

  return NextResponse.json({
    ok: true,
    scanned: active.length,
    warmed,
    poolFull,
    skipped,
    errorCount: errors.length,
    errors: errors.slice(0, 10), // cap response size
  });
}

/**
 * Pull the TOP_N_PROJECTS most-active projects in the last 7 days,
 * joined with the default repo + branch so /pool/warm has enough
 * context to clone. Projects without a default repo are returned but
 * rehydrateProject skips them (pool warm needs repo + ref).
 */
async function selectActiveProjects(): Promise<ActiveProject[]> {
  const rows = await db.execute<{
    project_id: string;
    repo: string | null;
    default_branch: string | null;
    session_count: string;
  }>(sql`
    SELECT
      rs.project_id,
      COALESCE(p.repo, rs.repo) AS repo,
      p.default_branch AS default_branch,
      COUNT(*)::text AS session_count
    FROM remediation_sessions rs
    LEFT JOIN projects p ON p.id = rs.project_id
    WHERE rs.created_at > now() - (${ACTIVE_PROJECTS_WINDOW_DAYS}::text || ' days')::interval
    GROUP BY rs.project_id, p.repo, p.default_branch, rs.repo
    ORDER BY COUNT(*) DESC
    LIMIT ${TOP_N_PROJECTS}
  `);

  const list =
    (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  return (list as Record<string, unknown>[]).map((r) => ({
    projectId: String(r.project_id),
    repo: r.repo ? String(r.repo) : null,
    defaultBranch: r.default_branch ? String(r.default_branch) : null,
    sessionCount: parseInt(String(r.session_count ?? "0"), 10),
  }));
}

/**
 * Dispatch a single /pool/warm call. Maps Go server responses onto the
 * RehydrateOutcome shape the aggregator counts.
 *
 * - 201 Created → warmed
 * - 409 Conflict → pool-full (expected once caps saturate)
 * - any other non-2xx → error (surfaced in the response)
 * - missing repo/ref → skipped
 */
async function rehydrateProject(
  project: ActiveProject,
  stagingUrl: string,
  stagingSecret: string,
): Promise<RehydrateOutcome> {
  if (!project.repo || !project.defaultBranch) {
    return { projectId: project.projectId, status: "skipped", reason: "missing repo or branch" };
  }

  // Repo field is stored as "owner/name"; Go server's clone path wants
  // a full URL. Mirror the shape remediate.ts already builds.
  const repoUrl = project.repo.startsWith("http")
    ? project.repo
    : `https://github.com/${project.repo}.git`;

  try {
    const res = await fetch(`${stagingUrl}/pool/warm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stagingSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project_id: project.projectId,
        repo: repoUrl,
        ref: project.defaultBranch,
      }),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });

    if (res.status === 201) {
      return { projectId: project.projectId, status: "warmed", httpStatus: 201 };
    }
    if (res.status === 409) {
      return { projectId: project.projectId, status: "pool-full", httpStatus: 409 };
    }

    const body = await res.text().catch(() => "");
    return {
      projectId: project.projectId,
      status: "error",
      httpStatus: res.status,
      reason: body.slice(0, 200),
    };
  } catch (err) {
    return {
      projectId: project.projectId,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
