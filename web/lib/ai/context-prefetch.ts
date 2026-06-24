/**
 * Smart context pre-fetch for the agentic loop (PR #7).
 *
 * Motivation from E2E v5–v8: the agent spent its FIRST turn (and sometimes
 * turn 4/5/6 on retries) calling read_file on the bug file + directly
 * imported files. Every read_file costs a turn + a GitHub API round-trip
 * (~200 ms each). For a 3-turn success, that's a third of the loop spent
 * on reads the pipeline could have queued up-front.
 *
 * This module:
 *   1. Takes a list of "seed" file paths (typically diagnosis.filesToRead,
 *      which the diagnose step already extracted from the stack trace).
 *   2. Scans their JS/TS imports with a simple regex (no TS AST to keep
 *      it cheap + language-light) and resolves relative imports to repo
 *      paths.
 *   3. Fetches each import from GitHub up to a bounded depth / count cap.
 *   4. Returns a Map<path, content> the caller can pass to runAgenticLoop
 *      as `prefetchedFiles`.
 *
 * The agentic-loop's read_file handler treats prefetched entries the same
 * as freshly-read ones — the model doesn't need to know anything changed;
 * it just gets a "(already read — returning cached content)" response if
 * it asks anyway.
 *
 * Caveats:
 *   - We skip node_modules / bare specifiers. Only relative imports are
 *     followed.
 *   - Depth is capped at 1 level of transitive resolution from the seeds.
 *     Two-hop imports are left to the agent's read_file tool.
 *   - Total prefetched files is capped (default 8) to keep the first
 *     API call's prompt size reasonable — cost scales with turn-1 tokens.
 *   - Files that fail to fetch are silently skipped (GH 404s, private
 *     submodules, etc. are not worth failing the prefetch for).
 */

import type * as ghMod from "@/lib/services/github-api";

export interface PrefetchOptions {
  /** Max number of files to include in the prefetch map. Default 8. */
  maxFiles?: number;
  /** Max chars per file (files beyond this are dropped). Default 15 000. */
  maxFileBytes?: number;
  /** How many import hops to follow from the seeds. Default 1. */
  maxHops?: number;
}

export interface PrefetchResult {
  files: Map<string, string>;
  /** Paths that came from the seed list vs. the import scan. */
  sources: { seeds: string[]; imports: string[] };
  /** Imports that were resolved but skipped (cap hit, fetch failed). */
  skipped: string[];
}

const JS_TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * Main entrypoint. Fetches seeds and their 1-hop imports from the repo.
 */
export async function prefetchContext(
  gh: typeof ghMod,
  token: string,
  owner: string,
  repo: string,
  ref: string,
  seeds: string[],
  repoFiles: string[],
  opts: PrefetchOptions = {},
): Promise<PrefetchResult> {
  const maxFiles = opts.maxFiles ?? 8;
  const maxFileBytes = opts.maxFileBytes ?? 15_000;
  const maxHops = opts.maxHops ?? 1;

  const files = new Map<string, string>();
  const importSources: string[] = [];
  const skipped: string[] = [];
  const repoFileSet = new Set(repoFiles);

  // Walk the queue breadth-first. `depth` tracks hops from the seed.
  const queue: { path: string; depth: number }[] = seeds.map((p) => ({ path: p, depth: 0 }));
  const seenPaths = new Set<string>();

  while (queue.length > 0 && files.size < maxFiles) {
    const { path, depth } = queue.shift()!;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    if (!isSafePath(path)) {
      skipped.push(path);
      continue;
    }

    let content: string | null;
    try {
      content = await gh.getFileContent(token, owner, repo, path, ref);
    } catch {
      content = null;
    }
    if (content === null) {
      skipped.push(path);
      continue;
    }

    const trimmed = content.slice(0, maxFileBytes);
    files.set(path, trimmed);
    if (depth > 0) importSources.push(path);

    if (depth < maxHops && JS_TS_EXT.test(path)) {
      const imports = extractRelativeImports(trimmed);
      for (const spec of imports) {
        const resolved = resolveImport(spec, path, repoFileSet);
        if (resolved && !seenPaths.has(resolved)) {
          queue.push({ path: resolved, depth: depth + 1 });
        }
      }
    }
  }

  // Everything still in the queue after the cap is "skipped" for the
  // caller's visibility, but we don't fetch it.
  for (const q of queue) {
    if (!files.has(q.path)) skipped.push(q.path);
  }

  return {
    files,
    sources: { seeds: seeds.filter((s) => files.has(s)), imports: importSources },
    skipped,
  };
}

/**
 * Extract bare module specifiers from relative import / require / dynamic
 * import statements. Tuned for the common JS/TS forms — we accept some
 * false negatives (template-literal imports, re-exports via `export
 * { a } from './x'` we handle, but dense/minified code may slip).
 */
export function extractRelativeImports(source: string): string[] {
  const specs: string[] = [];
  // Statement boundaries: start of string, newline, OR `;` (so `import A
  // from "a"; import "b"` on the same line still gets both imports).
  const patterns = [
    // import X from "./x";  import "./x";  import type { A } from "./x"
    /(?:^|[\n;])\s*import\s+(?:[^"';]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    // export { A } from "./x";  export * from "./x";
    /(?:^|[\n;])\s*export\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/g,
    // require("./x") — can appear inside any expression
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // import("./x") — dynamic, can appear in expressions
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      // Only relative imports. Bare specifiers are npm packages; we do
      // not want to pre-fetch node_modules contents.
      if (spec.startsWith(".") || spec.startsWith("/")) specs.push(spec);
    }
  }
  return Array.from(new Set(specs));
}

/**
 * Resolve a relative import specifier against the importing file's path
 * and the full list of files in the repo. Handles:
 *   - Direct hits: "./foo" → "dir/foo.ts" / "dir/foo.tsx" / "dir/foo/index.ts"
 *   - TS path aliases like "@/lib/x": callers should strip those before
 *     calling or we just fail to resolve (safe — handler logs as skipped).
 */
export function resolveImport(
  spec: string,
  importerPath: string,
  repoFiles: Set<string>,
): string | null {
  const importerDir = importerPath.split("/").slice(0, -1).join("/");
  const base = spec.startsWith(".") ? normalizePath(`${importerDir}/${spec}`) : null;
  if (!base) return null;

  // Exact hit.
  if (repoFiles.has(base)) return base;

  // Try extensions.
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    if (repoFiles.has(base + ext)) return base + ext;
  }

  // Try <base>/index.<ext>.
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    const idx = `${base}/index${ext}`;
    if (repoFiles.has(idx)) return idx;
  }
  return null;
}

function normalizePath(p: string): string {
  // Resolve "../" and "./" segments without invoking Node's path module
  // (we may run this in an edge runtime later).
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function isSafePath(p: string): boolean {
  // Keep this in sync with the agentic-loop BLOCKED_FILE_PATTERNS —
  // defensive duplicate so pre-fetch can't leak secrets even if callers
  // skip the loop's block list.
  const filename = p.split("/").pop() ?? p;
  if (p.includes("..") || p.startsWith("/")) return false;
  if (/^\.env/.test(filename)) return false;
  if (/\.(env|pem|key|cert|p12|pfx)$/i.test(filename)) return false;
  if (/secrets?\./i.test(filename) || /credentials?\./i.test(filename)) return false;
  if (/private[_-]?key/i.test(filename) || /serviceaccount/i.test(filename)) return false;
  return true;
}
