/**
 * Code Intelligence v2 — language detection.
 *
 * Maps a file path → which extractor should process it. The extractors agree
 * on the output shape (CodeSymbol / CodeReference / CodeTypeFact / CodeImport
 * tagged with `language`), so the indexer can multiplex per-file dispatch
 * without the persist layer caring.
 *
 * Phase 1 supports TypeScript via `@inariwatch/code-intel-extractor-ts`
 * (which transparently handles the JS family too via `allowJs: true`).
 * Phase 2 adds Python via `@inariwatch/code-intel-extractor-py`.
 *
 * Languages outside this set fall through `unknown` and are silently skipped.
 * Adding a new language is: extend the extension set + add the routing case
 * in `multi-extractor.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type DetectedLanguage = "typescript" | "python" | "unknown";

const TS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const PY_EXTENSIONS = new Set([".py"]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".pyright_cache",
  "site-packages",
]);

export function detectLanguageFromPath(filePath: string): DetectedLanguage {
  const lower = filePath.toLowerCase();
  // d.ts is a TS file but the TS extractor skips them — keep classifying as
  // typescript so we don't accidentally route them to Python.
  for (const ext of TS_EXTENSIONS) {
    if (lower.endsWith(ext)) return "typescript";
  }
  for (const ext of PY_EXTENSIONS) {
    if (lower.endsWith(ext)) return "python";
  }
  return "unknown";
}

export interface FileBuckets {
  typescript: string[];
  python: string[];
  unknown: string[];
}

export function bucketFilesByLanguage(files: readonly string[]): FileBuckets {
  const out: FileBuckets = { typescript: [], python: [], unknown: [] };
  for (const f of files) {
    out[detectLanguageFromPath(f)].push(f);
  }
  return out;
}

/**
 * Walk the repo and return which v2-supported languages have at least one
 * source file. Used by the multi-extractor to skip a cold pyright start
 * when the repo has no Python files (and vice versa).
 *
 * Returns as soon as both languages are confirmed present — the worst-case
 * walk is O(repo size) but the common case is O(first hit).
 */
export function detectLanguagesPresent(repoPath: string): Set<Exclude<DetectedLanguage, "unknown">> {
  const found = new Set<Exclude<DetectedLanguage, "unknown">>();
  const stack: string[] = [path.resolve(repoPath)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
        continue;
      }
      if (e.isFile()) {
        const lang = detectLanguageFromPath(e.name);
        if (lang === "typescript") found.add("typescript");
        else if (lang === "python") found.add("python");
        if (found.has("typescript") && found.has("python")) return found;
      }
    }
  }
  return found;
}
