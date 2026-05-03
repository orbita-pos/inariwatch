/**
 * Code Intelligence v2 — indexer pipeline.
 *
 * Orchestrates: locate the cloned repo → run the TS extractor →
 * persist symbols/refs/type-facts/imports → mark the repo `ready`.
 *
 * Coexists with v1's `indexRepository()` — Phase 1.5 service-layer dispatch
 * decides which one runs based on the `CODE_INTEL_V2` flag. Both can run in
 * shadow mode side-by-side without touching each other's tables.
 *
 * The extractor is invoked IN-PROCESS by default (via runExtractor()) — this
 * minimizes latency for small/medium repos and keeps the test surface simple.
 * For large repos that risk OOMing the Node process, callers can opt into the
 * subprocess path via `extractor.spawn = true` (Phase 1.3 ships the option;
 * Phase 1.5+ wires the heuristic).
 */

import { runExtractor as defaultRunExtractor } from "@inariwatch/code-intel-extractor-ts";
import type {
  ExtractorOptions,
  ExtractorOutput,
} from "@inariwatch/code-intel-extractor-ts";

import { logCodeIntelEvent } from "@/lib/code-intelligence/logger";
import {
  markRepoIndexed,
  updateRepoIndexingStatus,
} from "@/lib/services/code-intelligence.service";

import { persistRepoExtraction, type PersistResult } from "./persist";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndexerV2Options {
  repoId: string;
  repoPath: string;
  /** Repo-relative changed paths for incremental mode. Empty / undefined = full re-index. */
  changedFiles?: string[];
  /** Commit SHA the indexer is processing (written to last_indexed_commit on success). */
  commit?: string;
  /** Optional override for the tsconfig path (relative to repo root). */
  tsconfigPath?: string;
  /** Test seam — caller can inject a stub extractor (Phase 1.3 tests). */
  extractor?: (opts: ExtractorOptions) => Promise<ExtractorOutput>;
  /** Streaming progress callback. Mirrors v1 `IndexProgress` shape. */
  onProgress?: (event: IndexerV2Progress) => void;
}

export interface IndexerV2Progress {
  phase: "extracting" | "persisting" | "done" | "error";
  message: string;
  filesProcessed?: number;
  durationMs?: number;
}

export interface IndexerV2Result extends PersistResult {
  repoId: string;
  filesProcessed: number;
  extractorMs: number;
  persistMs: number;
  diagnostics: string[];
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export async function runIndexerV2(opts: IndexerV2Options): Promise<IndexerV2Result> {
  const { repoId, repoPath } = opts;
  const fullReindex = !opts.changedFiles || opts.changedFiles.length === 0;
  const runExtractor = opts.extractor ?? defaultRunExtractor;

  await updateRepoIndexingStatus({ repoId, status: "indexing", errorMessage: null });
  opts.onProgress?.({ phase: "extracting", message: "extracting symbols" });

  let extraction: ExtractorOutput;
  const tExtractStart = Date.now();
  try {
    extraction = await runExtractor({
      repoPath,
      changedFiles: opts.changedFiles,
      tsconfigPath: opts.tsconfigPath,
    });
  } catch (err) {
    const message = `extractor failed: ${(err as Error).message}`;
    logCodeIntelEvent({
      event: "indexer.embedding_batch_failed",
      severity: "error",
      phase: "v2",
      repoId,
      detail: { repoPath },
      error: err,
    });
    await updateRepoIndexingStatus({ repoId, status: "failed", errorMessage: message });
    opts.onProgress?.({ phase: "error", message });
    throw err;
  }
  const extractorMs = Date.now() - tExtractStart;

  opts.onProgress?.({
    phase: "persisting",
    message: `persisting ${extraction.symbols.length} symbols`,
    filesProcessed: extraction.filesProcessed,
  });

  let result: PersistResult;
  const tPersistStart = Date.now();
  try {
    result = await persistRepoExtraction(extraction, {
      repoId,
      fullReindex,
      clearedFilePaths: fullReindex ? undefined : opts.changedFiles,
    });
  } catch (err) {
    const message = `persist failed: ${(err as Error).message}`;
    logCodeIntelEvent({
      event: "indexer.embedding_batch_failed",
      severity: "error",
      phase: "v2",
      repoId,
      detail: { repoPath },
      error: err,
    });
    await updateRepoIndexingStatus({ repoId, status: "failed", errorMessage: message });
    opts.onProgress?.({ phase: "error", message });
    throw err;
  }
  const persistMs = Date.now() - tPersistStart;

  await markRepoIndexed({
    repoId,
    commit: opts.commit,
    totalSymbols: result.symbolsInserted,
  });
  opts.onProgress?.({
    phase: "done",
    message: `indexed ${result.symbolsInserted} symbols / ${result.referencesInserted} refs`,
    filesProcessed: extraction.filesProcessed,
    durationMs: extractorMs + persistMs,
  });

  return {
    repoId,
    filesProcessed: extraction.filesProcessed,
    extractorMs,
    persistMs,
    diagnostics: extraction.diagnostics,
    ...result,
  };
}

