/**
 * Code Intelligence v2 — multi-language extractor dispatcher.
 *
 * Phase 2.3 wires Python alongside TypeScript. The TS and Python extractor
 * binaries are independent — each owns its own language's parser/type-resolver
 * and emits structurally-identical record shapes
 * (`CodeSymbol` / `CodeReference` / `CodeTypeFact` / `CodeImport`).
 *
 * Dispatch rules:
 *
 * - **Incremental (`changedFiles` set)** — bucket the changed files by
 *   language and call ONLY the extractors whose buckets are non-empty. Files
 *   that don't match a known language are silently dropped (warn through the
 *   diagnostics array so the indexer can surface them).
 * - **Full re-index (`changedFiles` empty/undefined)** — probe the repo for
 *   the presence of `.py` / `.ts*` files and invoke each present language's
 *   extractor over the WHOLE repo. The per-language extractor walks its own
 *   files; we don't pre-list them.
 *
 * Both extractors run in parallel — they use disjoint subprocesses
 * (TS: in-process `ts.createProgram`; Python: spawned `pyright-langserver`).
 *
 * Output is the merged superset. The `language` column on each `code_symbols`
 * row tells the query API how to interpret the row downstream — no further
 * post-processing needed.
 */

import { runExtractor as defaultRunTsExtractor } from "@inariwatch/code-intel-extractor-ts";
import type {
  ExtractorOptions as TsExtractorOptions,
  ExtractorOutput as TsExtractorOutput,
} from "@inariwatch/code-intel-extractor-ts";

import { runExtractor as defaultRunPyExtractor } from "@inariwatch/code-intel-extractor-py";
import type {
  ExtractorOptions as PyExtractorOptions,
  ExtractorOutput as PyExtractorOutput,
} from "@inariwatch/code-intel-extractor-py";

import {
  bucketFilesByLanguage,
  detectLanguagesPresent,
} from "./language-detect";

export type RunTsExtractor = (opts: TsExtractorOptions) => Promise<TsExtractorOutput>;
export type RunPyExtractor = (opts: PyExtractorOptions) => Promise<PyExtractorOutput>;

export interface MultiExtractorOptions {
  repoPath: string;
  /** Repo-relative changed paths. If empty/undefined, do a full re-index. */
  changedFiles?: string[];
  /** Forwarded to the TS extractor. Ignored by the Python extractor. */
  tsconfigPath?: string;
  /**
   * Per-language extractor seams — Phase 2.3 tests inject stubs here. Production
   * code defaults to the in-process binaries from each workspace package.
   */
  tsExtractor?: RunTsExtractor;
  pyExtractor?: RunPyExtractor;
  /**
   * Override for `detectLanguagesPresent`. Tests inject a stub so they don't
   * need a real on-disk repo. Production code uses the default walker.
   */
  detectLanguages?: (repoPath: string) => Set<"typescript" | "python">;
}

/**
 * The merged output. Shape matches the TS extractor's `ExtractorOutput` so
 * the persist layer doesn't need to know about the dispatcher. The two
 * extractors agree on the record shapes — see
 * `packages/code-intel-extractor-py/src/types.ts` doc-comment.
 */
export type MultiExtractorOutput = TsExtractorOutput;

export async function runMultiExtractor(
  opts: MultiExtractorOptions,
): Promise<MultiExtractorOutput> {
  const t0 = Date.now();
  const runTs = opts.tsExtractor ?? defaultRunTsExtractor;
  const runPy = opts.pyExtractor ?? defaultRunPyExtractor;
  const detect = opts.detectLanguages ?? detectLanguagesPresent;

  const fullReindex = !opts.changedFiles || opts.changedFiles.length === 0;
  const diagnostics: string[] = [];

  // Plan the per-language calls.
  const tasks: Array<Promise<TsExtractorOutput | PyExtractorOutput>> = [];

  if (fullReindex) {
    const present = detect(opts.repoPath);
    if (present.has("typescript")) {
      tasks.push(
        runTs({
          repoPath: opts.repoPath,
          tsconfigPath: opts.tsconfigPath,
        }),
      );
    }
    if (present.has("python")) {
      tasks.push(
        runPy({
          repoPath: opts.repoPath,
        }),
      );
    }
  } else {
    const buckets = bucketFilesByLanguage(opts.changedFiles!);
    if (buckets.unknown.length > 0) {
      diagnostics.push(
        `dispatcher: ${buckets.unknown.length} changed file(s) of unknown language skipped: ${buckets.unknown.slice(0, 3).join(", ")}${buckets.unknown.length > 3 ? "…" : ""}`,
      );
    }
    if (buckets.typescript.length > 0) {
      tasks.push(
        runTs({
          repoPath: opts.repoPath,
          changedFiles: buckets.typescript,
          tsconfigPath: opts.tsconfigPath,
        }),
      );
    }
    if (buckets.python.length > 0) {
      tasks.push(
        runPy({
          repoPath: opts.repoPath,
          changedFiles: buckets.python,
        }),
      );
    }
  }

  // Empty plan → return an empty extraction. Indexer treats this as a no-op.
  if (tasks.length === 0) {
    return emptyOutput(opts.repoPath, diagnostics, Date.now() - t0);
  }

  const results = await Promise.all(tasks);
  return mergeOutputs(opts.repoPath, results, diagnostics, Date.now() - t0);
}

function emptyOutput(
  repoPath: string,
  diagnostics: string[],
  durationMs: number,
): MultiExtractorOutput {
  return {
    repoPath,
    symbols: [],
    references: [],
    typeFacts: [],
    imports: [],
    diagnostics,
    filesProcessed: 0,
    durationMs,
  };
}

function mergeOutputs(
  repoPath: string,
  results: Array<TsExtractorOutput | PyExtractorOutput>,
  extraDiagnostics: string[],
  durationMs: number,
): MultiExtractorOutput {
  // The two ExtractorOutput types are structurally identical (the Python
  // extractor's types.ts is a verbatim mirror) — so the cast below is safe
  // at runtime. We keep the explicit assertion to make the intent obvious.
  const merged: MultiExtractorOutput = {
    repoPath,
    symbols: [],
    references: [],
    typeFacts: [],
    imports: [],
    diagnostics: [...extraDiagnostics],
    filesProcessed: 0,
    durationMs,
  };
  for (const r of results) {
    merged.symbols.push(...(r.symbols as MultiExtractorOutput["symbols"]));
    merged.references.push(...(r.references as MultiExtractorOutput["references"]));
    merged.typeFacts.push(...(r.typeFacts as MultiExtractorOutput["typeFacts"]));
    merged.imports.push(...(r.imports as MultiExtractorOutput["imports"]));
    merged.diagnostics.push(...r.diagnostics);
    merged.filesProcessed += r.filesProcessed;
  }
  return merged;
}
