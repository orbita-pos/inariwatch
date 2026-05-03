/**
 * Code Intelligence service — single source of truth.
 * Used by: MCP tools, remediation pipeline, dashboard, Slack bot.
 */

import { db, codeRepositories, codeChunks } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { searchCodeByProject, type CodeSearchResult, type SearchOptions } from "@/lib/code-intelligence/search";
import { indexRepository, type IndexOptions, type IndexProgress } from "@/lib/code-intelligence/indexer";

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
  return searchCodeByProject(params.query, params.projectId, {
    limit: params.limit,
    includeGraph: params.includeGraph,
    fileFilter: params.fileFilter,
    openaiKey: params.openaiKey,
  });
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
