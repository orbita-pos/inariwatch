/**
 * Code Intelligence service — single source of truth.
 * Used by: MCP tools, remediation pipeline, dashboard, Slack bot.
 *
 * Phase 1.5 of Code Intelligence v2 wires `searchCode()` to a flag-gated
 * dispatcher. With `CODE_INTEL_V2=off` (default) it returns the v1 result
 * unchanged — byte-identical for existing callers. With `=shadow` it ALSO
 * runs v2 in the background and writes one row to `code_intel_shadow_log`
 * per call (Phase 1.7 widget reads from there). With `=on` it returns v2
 * results (adapted to the v1 CodeSearchResult shape).
 *
 * Phase 3.1 adds three operator knobs on top of the shadow path:
 *   - `SHADOW_SAMPLE_RATE` env (default 1.0) — fraction of shadow calls
 *     that actually run v2 in parallel.
 *   - `organizations.code_intel_v2_shadow_pct` — per-workspace override.
 *   - `CODE_INTEL_V2_KILL_SHADOW=1` — forces shadow to behave like v1.
 *   - 2× wall-clock timeout guard — abandons v2 when it overshoots and
 *     records `v2_timed_out=true` on the shadow log row.
 */

import { db, codeRepositories, codeChunks, codeIntelShadowLog } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { searchCodeByProject, type CodeSearchResult, type SearchOptions } from "@/lib/code-intelligence/search";
import { indexRepository, type IndexOptions, type IndexProgress } from "@/lib/code-intelligence/indexer";
import {
  resolveCodeIntelEngine,
  type CodeIntelEngine,
} from "@/lib/code-intelligence-v2/flag";
import { searchSemantic } from "@/lib/code-intelligence-v2/queries";
import {
  adaptV2ToV1,
  topFqns as topV2Fqns,
  topFqnsFromV1,
} from "@/lib/code-intelligence-v2/adapter";
import {
  isShadowKilled,
  shouldShadowSample,
  v2AdditionalBudgetMs,
} from "@/lib/code-intelligence-v2/sampling";
import { logCodeIntelEvent } from "@/lib/code-intelligence/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export type CodeIndexStatus = {
  repoId: string;
  owner: string;
  repo: string;
  status: string;
  totalChunks: number;
  lastIndexedAt: Date | null;
  lastIndexedCommit: string | null;
};

export type SearchParams = {
  projectId: string;
  query: string;
  limit?: number;
  includeGraph?: boolean;
  fileFilter?: string[];
  openaiKey?: string;
};

// ── Search ───────────────────────────────────────────────────────────────────

export async function searchCode(params: SearchParams): Promise<CodeSearchResult[]> {
  const engine = resolveCodeIntelEngine({ projectId: params.projectId });

  if (engine === "off") {
    return runV1(params);
  }

  if (engine === "on") {
    const v2 = await runV2(params);
    if (v2) return v2.results;
    // v2 had no repo / no symbols — fall back to v1 transparently so the
    // caller never sees a regression while v2 onboards new repos.
    return runV1(params);
  }

  // Shadow: kill switch first (cheapest — env-only, zero I/O).
  if (isShadowKilled()) {
    return runV1(params);
  }

  // Sampling decision. Reads the global env + the per-workspace pct
  // override; rolls a uniform [0,1) random against the resolved rate.
  // When the dice say "skip", behave exactly like engine=off — no v2,
  // no shadow log row.
  const sample = await shouldShadowSample(params.projectId);
  if (!sample) {
    return runV1(params);
  }

  // Run BOTH engines in parallel. Wrap v2 so it can never reject — the
  // race below abandons it on timeout and a late rejection would
  // surface as an unhandled promise rejection otherwise.
  const v1Started = timed(() => runV1(params));

  const v2Outcome: {
    value: V2SearchOutcome | null;
    durationMs: number;
    error: string | null;
  } = { value: null, durationMs: 0, error: null };

  const v2Tracker = (async () => {
    const t0 = Date.now();
    try {
      v2Outcome.value = await runV2(params);
    } catch (err) {
      v2Outcome.error = errMessage(err);
    }
    v2Outcome.durationMs = Date.now() - t0;
  })();

  // Await v1 (capture both fulfilled and rejected paths).
  let v1Value: CodeSearchResult[] | null = null;
  let v1DurationMs = 0;
  let v1Error: string | null = null;
  let v1Throw: unknown = null;
  try {
    const v1 = await v1Started;
    v1Value = v1.value;
    v1DurationMs = v1.durationMs;
  } catch (err) {
    v1Throw = err;
    v1Error = errMessage(err);
  }

  // Race v2 against the timeout budget. Total v2 budget ≈ 2× v1Ms; the
  // helper takes care of the floor + the in-parallel time already spent.
  const additionalMs = v2AdditionalBudgetMs(v1DurationMs);
  const v2FinishedInBudget = await raceWithTimeout(v2Tracker, additionalMs);

  if (v2FinishedInBudget) {
    await logShadowSample({
      params,
      v1Results: v1Value,
      v1DurationMs,
      v1Error,
      v2: v2Outcome.value,
      v2DurationMs: v2Outcome.durationMs,
      v2Error: v2Outcome.error,
      v2TimedOut: false,
    });
  } else {
    // v2 missed the budget. Log the slow event now so the cutover
    // dashboard sees it on the next read tick. The v2 attempt keeps
    // running in the background; we drain it with a no-op catch so a
    // late rejection doesn't leak as an unhandled rejection.
    v2Tracker.catch(() => undefined);
    await logShadowSample({
      params,
      v1Results: v1Value,
      v1DurationMs,
      v1Error,
      v2: null,
      v2DurationMs: 0,
      v2Error: `v2_slow: budget=${additionalMs}ms exceeded`,
      v2TimedOut: true,
    });
  }

  // v1 is the source of truth in shadow mode. If v1 itself failed,
  // surface the failure to the caller (we don't silently substitute v2).
  if (v1Throw) throw v1Throw;
  return v1Value!;
}

/**
 * Resolve `true` when `p` settles before `ms` elapses, `false` otherwise.
 * Never rejects. Caller is responsible for any cleanup / draining of `p`
 * after a timeout.
 */
function raceWithTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, ms);
    p.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

interface V2SearchOutcome {
  results: CodeSearchResult[];
  rawTopFqns: string[];
}

async function runV1(params: SearchParams): Promise<CodeSearchResult[]> {
  return searchCodeByProject(params.query, params.projectId, {
    limit: params.limit,
    includeGraph: params.includeGraph,
    fileFilter: params.fileFilter,
    openaiKey: params.openaiKey,
  });
}

async function runV2(params: SearchParams): Promise<V2SearchOutcome | null> {
  const repoId = await firstReadyRepoForProject(params.projectId);
  if (!repoId) return null;
  const v2 = await searchSemantic(params.query, repoId, {
    limit: params.limit,
    fileFilter: params.fileFilter,
    shallow: !params.includeGraph,
  });
  return {
    results: adaptV2ToV1(v2),
    rawTopFqns: topV2Fqns(v2),
  };
}

/**
 * Returns the first `ready` v2-indexed repo for a project, or null. Used by
 * the v2 search dispatcher AND by `/api/code-intel-v2/*` endpoints that
 * accept a projectId from the container agent. Phase 3 may evolve this to
 * "best-matching repo" once a project can have multiple connected repos.
 */
export async function firstReadyRepoForProject(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: codeRepositories.id })
    .from(codeRepositories)
    .where(and(eq(codeRepositories.projectId, projectId), eq(codeRepositories.status, "ready")))
    .limit(1);
  return row?.id ?? null;
}

interface ShadowSampleParams {
  params: SearchParams;
  v1Results: CodeSearchResult[] | null;
  v1DurationMs: number;
  v1Error: string | null;
  v2: V2SearchOutcome | null;
  v2DurationMs: number;
  v2Error: string | null;
  /**
   * Phase 3.1 — true when the v2 attempt was abandoned because it missed
   * the 2× wall-clock budget. The cutover dashboard reads this column to
   * surface "v2 too slow on N% of calls" without scraping `v2Error` text.
   */
  v2TimedOut: boolean;
}

async function logShadowSample(s: ShadowSampleParams): Promise<void> {
  try {
    const repoId = (await firstReadyRepoForProject(s.params.projectId)) ?? null;
    await db.insert(codeIntelShadowLog).values({
      repoId,
      projectId: s.params.projectId,
      query: s.params.query,
      v1ResultCount: s.v1Results?.length ?? 0,
      v2ResultCount: s.v2?.results.length ?? 0,
      v1TopFqns: s.v1Results ? topFqnsFromV1(s.v1Results) : [],
      v2TopFqns: s.v2?.rawTopFqns ?? [],
      v1DurationMs: Math.round(s.v1DurationMs),
      v2DurationMs: Math.round(s.v2DurationMs),
      v1Error: s.v1Error,
      v2Error: s.v2Error,
      v2TimedOut: s.v2TimedOut,
    });
  } catch (err) {
    // Shadow logging must never break the caller. Failures get logged
    // and swallowed.
    logCodeIntelEvent({
      event: "search.rerank_failed",
      severity: "warn",
      phase: "v2",
      detail: { stage: "shadow_log", projectId: s.params.projectId },
      error: err,
    });
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, durationMs: Date.now() - t0 };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Resolve the engine name for a request — read by /admin/ops widgets and
 * test code. Re-exported here so consumers stay on the service surface.
 */
export function getCodeIntelEngine(ctx?: {
  workspaceId?: string;
  projectId?: string;
}): CodeIntelEngine {
  return resolveCodeIntelEngine(ctx ?? {});
}

// ── Index status ─────────────────────────────────────────────────────────────

export async function getIndexStatus(projectId: string): Promise<CodeIndexStatus[]> {
  const repos = await db
    .select({
      repoId: codeRepositories.id,
      owner: codeRepositories.githubOwner,
      repo: codeRepositories.githubRepo,
      status: codeRepositories.status,
      totalChunks: codeRepositories.totalChunks,
      lastIndexedAt: codeRepositories.lastIndexedAt,
      lastIndexedCommit: codeRepositories.lastIndexedCommit,
    })
    .from(codeRepositories)
    .where(eq(codeRepositories.projectId, projectId));

  return repos.map((r) => ({
    repoId: r.repoId,
    owner: r.owner,
    repo: r.repo,
    status: r.status,
    totalChunks: r.totalChunks,
    lastIndexedAt: r.lastIndexedAt,
    lastIndexedCommit: r.lastIndexedCommit,
  }));
}

// ── Trigger re-index ─────────────────────────────────────────────────────────

export async function triggerReindex(opts: IndexOptions): Promise<{ repoId: string; chunksIndexed: number }> {
  return indexRepository(opts);
}

// ── Lookup helpers (consumed by webhook + replay + index route) ──────────────
//
// These exist so consumers outside the code-intelligence module never import
// codeRepositories / codeChunks / codeDependencies from `@/lib/db` directly.
// The ESLint rule `inariwatch/no-direct-code-intel-db` enforces that boundary
// (Phase 0.2). Add a method here before reaching for the table.

export type IndexedRepoIdentity = {
  id: string;
};

/**
 * Returns the repo row id when (projectId, owner, repo) is already tracked
 * in `code_repositories`. Used by the GitHub webhook to gate "only re-index
 * repos we've indexed before" without leaking the table outside the module.
 */
export async function findIndexedRepoIdentity(params: {
  projectId: string;
  owner: string;
  repo: string;
}): Promise<IndexedRepoIdentity | null> {
  const [row] = await db
    .select({ id: codeRepositories.id })
    .from(codeRepositories)
    .where(
      and(
        eq(codeRepositories.projectId, params.projectId),
        eq(codeRepositories.githubOwner, params.owner),
        eq(codeRepositories.githubRepo, params.repo),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type RepoIdentity = {
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
};

/**
 * Returns the first connected repo for a project. Used by the replay
 * manifest endpoint to deep-link stack frames into GitHub. Returns null
 * when the project has no indexed repo yet.
 */
export async function getRepoIdentityForProject(projectId: string): Promise<RepoIdentity | null> {
  const [row] = await db
    .select({
      githubOwner: codeRepositories.githubOwner,
      githubRepo: codeRepositories.githubRepo,
      defaultBranch: codeRepositories.defaultBranch,
    })
    .from(codeRepositories)
    .where(eq(codeRepositories.projectId, projectId))
    .limit(1);
  return row ?? null;
}

// ── Stats ────────────────────────────────────────────────────────────────────

export async function getCodeStats(projectId: string): Promise<{
  totalRepos: number;
  totalChunks: number;
  languages: { language: string; count: number }[];
}> {
  const repos = await db
    .select({ id: codeRepositories.id, totalChunks: codeRepositories.totalChunks })
    .from(codeRepositories)
    .where(and(eq(codeRepositories.projectId, projectId), eq(codeRepositories.status, "ready")));

  if (repos.length === 0) {
    return { totalRepos: 0, totalChunks: 0, languages: [] };
  }

  const repoIds = repos.map((r) => r.id);
  const totalChunks = repos.reduce((sum, r) => sum + r.totalChunks, 0);

  const languages = await db.execute<{ language: string; count: number }>(sql`
    SELECT language, count(*)::int as count
    FROM code_chunks
    WHERE repo_id = ANY(${repoIds})
    GROUP BY language
    ORDER BY count DESC
  `);

  return {
    totalRepos: repos.length,
    totalChunks,
    languages: languages.rows,
  };
}

// ── Indexer status helpers (consumed by Code Intel v2 indexer) ────────────────
//
// Phase 1.3 of Code Intelligence v2 introduces an indexer module at
// `web/lib/code-intelligence-v2/indexer.ts`. It needs to flip the
// `code_repositories.status` column as it works through extraction. Per the
// Phase 0 lockdown rule, only this service file may touch the table — so the
// indexer calls these helpers instead of importing `codeRepositories` directly.

export type IndexerRepoStatus = "indexing" | "ready" | "failed";

/**
 * Move a repo into a transient state (e.g. `indexing` while the extractor runs,
 * or `failed` with a sanitized error message). For the success path use
 * `markRepoIndexed()` instead — it bumps `last_indexed_*` and the symbol count.
 */
export async function updateRepoIndexingStatus(params: {
  repoId: string;
  status: IndexerRepoStatus;
  errorMessage: string | null;
}): Promise<void> {
  await db
    .update(codeRepositories)
    .set({
      status: params.status,
      errorMessage: params.errorMessage,
      updatedAt: sql`now()`,
    })
    .where(eq(codeRepositories.id, params.repoId));
}

/**
 * Successful-completion marker. Sets status=ready, clears any error message,
 * stamps `last_indexed_at` + `last_indexed_commit`, and updates the count.
 *
 * Phase 1 stores symbol counts in `total_chunks` for v1/v2 coexistence. Phase 3
 * cutover decides whether to rename the column (`total_symbols`).
 */
export async function markRepoIndexed(params: {
  repoId: string;
  commit?: string;
  totalSymbols: number;
}): Promise<void> {
  await db
    .update(codeRepositories)
    .set({
      status: "ready",
      errorMessage: null,
      lastIndexedCommit: params.commit ?? sql`last_indexed_commit`,
      lastIndexedAt: sql`now()`,
      totalChunks: params.totalSymbols,
      updatedAt: sql`now()`,
    })
    .where(eq(codeRepositories.id, params.repoId));
}
