// /admin/ops Code Intelligence baseline (v1) endpoint.
//
// Phase 0.3 of Code Intelligence v2 — exposes the metrics we need to
// quantify v2's improvement once it lands. Read-only aggregations against
// `code_chunks`, `code_repositories`, `code_dependencies`. Admin-only.
//
// Surfaced in the dashboard via web/app/(dashboard)/admin/ops/widgets/code-intel-baseline.tsx
// per the Phase 0 handoff in CODE_INTELLIGENCE_V2_HANDOFF.md.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

// Drizzle's `db.execute<T>` constrains `T extends Record<string, unknown>`.
// Same pattern as web/app/api/admin/router/receipts/summary/route.ts.
type ChunkTotalsRow = {
  total_chunks: number;
  with_embedding: number;
  by_voyage: number;
  by_openai: number;
} & Record<string, unknown>;

type RepoTotalsRow = {
  total: number;
  ready: number;
  indexing: number;
  failed: number;
} & Record<string, unknown>;

type DependencyAmbiguityRow = {
  total_edges: number;
  homonym_poisoned_edges: number;
} & Record<string, unknown>;

type LanguageRow = {
  language: string;
  count: number;
} & Record<string, unknown>;

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email || email !== process.env.ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Chunk totals + embedding coverage. `embedding_model_version` arrives in
  // migration 0078 (Phase 0.1) — fall back to a single bucket if the column
  // hasn't been migrated yet, so /admin/ops doesn't 500 mid-rollout.
  const chunkTotals = await db.execute<ChunkTotalsRow>(sql`
    SELECT
      COUNT(*)::int                                                       AS total_chunks,
      SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END)::int          AS with_embedding,
      SUM(CASE WHEN embedding_model_version = 'voyage-code-3'
               THEN 1 ELSE 0 END)::int                                     AS by_voyage,
      SUM(CASE WHEN embedding_model_version = 'openai-text-embedding-3-small'
               THEN 1 ELSE 0 END)::int                                     AS by_openai
    FROM code_chunks
  `);

  const repoTotals = await db.execute<RepoTotalsRow>(sql`
    SELECT
      COUNT(*)::int                                          AS total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END)::int    AS ready,
      SUM(CASE WHEN status = 'indexing' THEN 1 ELSE 0 END)::int AS indexing,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int   AS failed
    FROM code_repositories
  `);

  // Homonym-poisoned edges = edges whose target chunk has the same `name`
  // as at least one OTHER chunk in the same repo. The current call-graph
  // builder matches on bare names, so these edges may point at the wrong
  // function. v2 (Glean-style) fixes this by resolving FQNs.
  const ambiguity = await db.execute<DependencyAmbiguityRow>(sql`
    WITH name_counts AS (
      SELECT repo_id, name, COUNT(*) AS n
      FROM code_chunks
      GROUP BY repo_id, name
    )
    SELECT
      COUNT(*)::int AS total_edges,
      SUM(CASE WHEN nc.n > 1 THEN 1 ELSE 0 END)::int AS homonym_poisoned_edges
    FROM code_dependencies d
    JOIN code_chunks tgt ON tgt.id = d.target_chunk_id
    JOIN name_counts nc
      ON nc.repo_id = tgt.repo_id AND nc.name = tgt.name
  `);

  const languages = await db.execute<LanguageRow>(sql`
    SELECT language, COUNT(*)::int AS count
    FROM code_chunks
    GROUP BY language
    ORDER BY count DESC
    LIMIT 10
  `);

  const chunkRow = readRows<ChunkTotalsRow>(chunkTotals)[0] ?? {
    total_chunks: 0,
    with_embedding: 0,
    by_voyage: 0,
    by_openai: 0,
  };
  const repoRow = readRows<RepoTotalsRow>(repoTotals)[0] ?? {
    total: 0,
    ready: 0,
    indexing: 0,
    failed: 0,
  };
  const ambiguityRow = readRows<DependencyAmbiguityRow>(ambiguity)[0] ?? {
    total_edges: 0,
    homonym_poisoned_edges: 0,
  };
  const langRows = readRows<LanguageRow>(languages);

  const totalChunks = chunkRow.total_chunks ?? 0;
  const withEmbedding = chunkRow.with_embedding ?? 0;
  const totalEdges = ambiguityRow.total_edges ?? 0;
  const poisoned = ambiguityRow.homonym_poisoned_edges ?? 0;

  return NextResponse.json({
    repos: {
      total: repoRow.total ?? 0,
      ready: repoRow.ready ?? 0,
      indexing: repoRow.indexing ?? 0,
      failed: repoRow.failed ?? 0,
    },
    chunks: {
      total: totalChunks,
      withEmbedding,
      embeddingCoveragePct:
        totalChunks > 0 ? Number(((withEmbedding / totalChunks) * 100).toFixed(2)) : 0,
      byModel: {
        "voyage-code-3": chunkRow.by_voyage ?? 0,
        "openai-text-embedding-3-small": chunkRow.by_openai ?? 0,
      },
    },
    dependencies: {
      totalEdges,
      homonymPoisonedEdges: poisoned,
      poisonedPct:
        totalEdges > 0 ? Number(((poisoned / totalEdges) * 100).toFixed(2)) : 0,
    },
    languages: langRows.map((r) => ({ language: r.language, count: r.count })),
  });
}

function readRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in (result as Record<string, unknown>) &&
    Array.isArray((result as { rows: unknown[] }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
