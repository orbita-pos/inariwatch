/**
 * Code Intelligence v2 — indexer pipeline.
 *
 * Orchestrates: locate the cloned repo → run the per-language extractors via
 * the multi-extractor dispatcher → persist symbols/refs/type-facts/imports →
 * mark the repo `ready`.
 *
 * Coexists with v1's `indexRepository()` — Phase 1.5 service-layer dispatch
 * decides which one runs based on the `CODE_INTEL_V2` flag. Both can run in
 * shadow mode side-by-side without touching each other's tables.
 *
 * Phase 2.3: routing across multiple language extractors lives in
 * `multi-extractor.ts`. Each per-language extractor (TS via
 * `@inariwatch/code-intel-extractor-ts`, Python via
 * `@inariwatch/code-intel-extractor-py`) runs in-process. Mixed-language
 * repos invoke both in parallel.
 *
 * The legacy `extractor` test seam is preserved — when set, the dispatcher
 * is bypassed entirely.
 */

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
import {
  runMultiExtractor,
  type RunPyExtractor,
  type RunTsExtractor,
} from "./multi-extractor";

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
  /**
   * Legacy test seam (Phase 1.3) — caller injects a single combined extractor.
   * When set, the multi-language dispatcher is bypassed entirely. Existing
   * tests that stub one extractor function keep working.
   */
  extractor?: (opts: ExtractorOptions) => Promise<ExtractorOutput>;
  /** Phase 2.3 test seam — overrides the TypeScript extractor only. */
  tsExtractor?: RunTsExtractor;
  /** Phase 2.3 test seam — overrides the Python extractor only. */
  pyExtractor?: RunPyExtractor;
  /** Phase 2.3 test seam — overrides language presence detection. */
  detectLanguages?: (repoPath: string) => Set<"typescript" | "python">;
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

  await updateRepoIndexingStatus({ repoId, status: "indexing", errorMessage: null });
  opts.onProgress?.({ phase: "extracting", message: "extracting symbols" });

  let extraction: ExtractorOutput;
  const tExtractStart = Date.now();
  try {
    if (opts.extractor) {
      // Legacy single-extractor path — preserved for Phase 1.3 test seam
      // back-compat. Production code should use the multi-extractor path.
      extraction = await opts.extractor({
        repoPath,
        changedFiles: opts.changedFiles,
        tsconfigPath: opts.tsconfigPath,
      });
    } else {
      extraction = await runMultiExtractor({
        repoPath,
        changedFiles: opts.changedFiles,
        tsconfigPath: opts.tsconfigPath,
        tsExtractor: opts.tsExtractor,
        pyExtractor: opts.pyExtractor,
        detectLanguages: opts.detectLanguages,
      });
    }
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

