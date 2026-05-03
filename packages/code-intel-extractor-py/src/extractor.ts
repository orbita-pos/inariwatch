// Phase 2.2 orchestrator. Spawns one pyright-langserver session, walks all
// `.py` files in the repo, and produces an `ExtractorOutput` whose record
// shapes match `@inariwatch/code-intel-extractor-ts`. Phase 1.3's indexer
// pipeline can consume either source — language column = "python" tells the
// query API how to interpret rows.
//
// Pipeline per file:
//   1. didOpen
//   2. documentSymbol → flat SymbolInformation[]
//   3. extractSymbols → CodeSymbol[] + cached hover per symbol
//   4. extractReferences (one references request per accepted symbol)
//   5. extractTypeFacts (uses the cached hover — no extra LSP round-trips)
//   6. extractImports (Python-source regex; no LSP)
//
// Repo walk skips:
//   - `__pycache__/`, `.venv/`, `venv/`, `env/`, `.tox/`, `.mypy_cache/`,
//     `.pytest_cache/`, `node_modules/`, `dist/`, `build/`, `site-packages/`
//   - hidden directories (`.<name>`)

import * as fs from "node:fs";
import * as path from "node:path";

import {
  PyrightLspClient,
  pathToFileUri,
} from "./lsp.js";
import type { SymbolInformation } from "./lsp.js";
import { extractImports } from "./imports.js";
import { extractReferences } from "./references.js";
import { extractSymbols, type SymbolEmission } from "./symbols.js";
import { extractTypeFacts } from "./type-facts.js";
import type {
  CodeImport,
  CodeReference,
  CodeSymbol,
  CodeTypeFact,
  ExtractorOptions,
  ExtractorOutput,
} from "./types.js";

const SKIP_DIRS = new Set([
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".pyright_cache",
  "node_modules",
  "dist",
  "build",
  "site-packages",
]);

export async function runExtractor(
  options: ExtractorOptions,
): Promise<ExtractorOutput> {
  const t0 = Date.now();
  const repoPath = path.resolve(options.repoPath);
  const repoRootUri = pathToFileUri(repoPath);

  const wantedFiles = collectFiles(repoPath, options.changedFiles);
  const diagnostics: string[] = [];

  const client = new PyrightLspClient({
    rootUri: repoRootUri,
    cwd: repoPath,
  });
  await client.start();

  const includeRefs = options.includeReferences !== false;
  const includeTypeFacts = options.includeTypeFacts !== false;
  const includeImports = options.includeImports !== false;
  const warmup = options.warmupBeforeQuery !== false;

  const symbols: CodeSymbol[] = [];
  const references: CodeReference[] = [];
  const typeFacts: CodeTypeFact[] = [];
  const imports: CodeImport[] = [];

  // Cache the source text + uri/path map for the references pass.
  const fileSources = new Map<string, string>();
  const uriToPath = new Map<string, string>();
  const emissionsByUri = new Map<string, SymbolEmission[]>();

  try {
    for (const absPath of wantedFiles) {
      const relPath = forwardSlashRelative(repoPath, absPath);
      let source: string;
      try {
        source = fs.readFileSync(absPath, "utf8");
      } catch (err) {
        diagnostics.push(`read: ${relPath}: ${(err as Error).message}`);
        continue;
      }
      const uri = pathToFileUri(absPath);
      fileSources.set(uri, source);
      uriToPath.set(uri, relPath);

      client.didOpen(uri, "python", source);
      if (warmup) {
        // Pyright binds asynchronously; first request on a freshly-opened
        // file races the binder. A small sleep is the cheapest fix; the
        // alternative is request retry with backoff, which buys nothing.
        await sleep(40);
      }

      let docSyms: SymbolInformation[];
      try {
        const result = await client.documentSymbol(uri);
        docSyms = (result as SymbolInformation[]).filter((s) => s && s.location);
      } catch (err) {
        diagnostics.push(`documentSymbol: ${relPath}: ${(err as Error).message}`);
        continue;
      }

      let emissions: SymbolEmission[];
      try {
        emissions = await extractSymbols({
          client,
          uri,
          filePath: relPath,
          source,
          symbols: docSyms,
        });
      } catch (err) {
        diagnostics.push(`symbols: ${relPath}: ${(err as Error).message}`);
        continue;
      }

      emissionsByUri.set(uri, emissions);
      for (const e of emissions) symbols.push(e.symbol);

      if (includeImports) {
        try {
          const imps = extractImports({ source, filePath: relPath, rootDir: repoPath });
          imports.push(...imps);
        } catch (err) {
          diagnostics.push(`imports: ${relPath}: ${(err as Error).message}`);
        }
      }

      if (includeTypeFacts) {
        const sourceLines = source.split(/\r?\n/);
        for (const e of emissions) {
          try {
            const fact = extractTypeFacts({
              symbol: e.symbol,
              hover: e.hover,
              source: sourceLines.slice(e.symbol.startLine - 1, e.symbol.endLine).join("\n"),
              fileSource: source,
              startLine: e.symbol.startLine - 1,
              endLine: e.symbol.endLine - 1,
            });
            if (fact) typeFacts.push(fact);
          } catch (err) {
            diagnostics.push(`type-facts: ${e.symbol.fqn}: ${(err as Error).message}`);
          }
        }
      }
    }

    if (includeRefs) {
      // Run references AFTER all files are open + symbols emitted so that
      // cross-file references resolve.
      const allEmissions: SymbolEmission[] = [];
      for (const e of emissionsByUri.values()) allEmissions.push(...e);
      try {
        const refs = await extractReferences({
          client,
          fileSources,
          uriToPath,
          emissionsByUri,
          repoRootUri,
          emissions: allEmissions,
        });
        references.push(...refs);
      } catch (err) {
        diagnostics.push(`references: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.stop();
  }

  return {
    repoPath,
    symbols,
    references,
    typeFacts,
    imports,
    diagnostics,
    filesProcessed: wantedFiles.length,
    durationMs: Date.now() - t0,
  };
}

function collectFiles(repoPath: string, changedFiles?: string[]): string[] {
  if (changedFiles && changedFiles.length > 0) {
    return changedFiles
      .map((f) => path.resolve(repoPath, f))
      .filter((f) => f.endsWith(".py") && safeIsFile(f));
  }
  const out: string[] = [];
  walk(repoPath, repoPath, out);
  return out;
}

function walk(dir: string, repoRoot: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), repoRoot, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".py")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function forwardSlashRelative(rootDir: string, absPath: string): string {
  return path.relative(rootDir, absPath).replace(/\\/g, "/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
