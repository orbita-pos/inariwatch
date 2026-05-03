// Python import parser. Pyright doesn't expose imports cleanly via LSP
// (`textDocument/documentSymbol` doesn't include them, `--dependencies` flag
// is mutually exclusive with `--outputjson`), so we parse them ourselves.
//
// Grammar covered (matches Python's `import_stmt` / `import_from` from the
// Python language reference):
//
//   import a
//   import a as b
//   import a.b.c
//   import a, b, c
//   import a as x, b as y
//   from a import b
//   from a import b, c
//   from a import b as x
//   from a import (b, c, d)              # parenthesized for line wrapping
//   from a import (
//       b,
//       c as cc,
//   )
//   from . import a
//   from .. import b
//   from ..a.b import c
//   from a import *                       # star re-export
//
// Out of scope for v0.1: `__import__("foo")`, `importlib.import_module("foo")`.
// Those are dynamic imports — best-effort detection lands in Phase 2 part 2.
//
// Resolution: `targetModule` is the raw module specifier (`"a.b"` / `".x"`).
// `resolvedFile` is set when `<repo_path>/<module_path>.py` or
// `<repo_path>/<module_path>/__init__.py` exists, else null. Relative imports
// are resolved against the source file's directory.

import * as path from "node:path";
import * as fs from "node:fs";

import { normalizePath } from "./fqn.js";
import type { CodeImport, ImportedName } from "./types.js";

export interface ExtractImportsParams {
  source: string;            // file contents
  filePath: string;          // repo-relative + forward-slashed
  rootDir: string;           // absolute repo root
}

interface RawImportLine {
  text: string;              // logical line (multi-line statements joined)
  startLine: number;         // 1-based source line number for the FIRST physical line
}

export function extractImports(params: ExtractImportsParams): CodeImport[] {
  const { source, filePath, rootDir } = params;
  const out: CodeImport[] = [];
  const sourceDir = path.dirname(path.join(rootDir, filePath));

  for (const stmt of collectImportStatements(source)) {
    const text = stmt.text;
    if (text.startsWith("import ")) {
      const tail = text.slice("import ".length);
      for (const item of splitTopLevelCommas(tail)) {
        const aliased = parseAliased(item);
        if (!aliased) continue;
        out.push({
          sourceFile: filePath,
          targetModule: aliased.name,
          resolvedFile: resolveModule(aliased.name, sourceDir, rootDir, /*relative*/ false, /*depth*/ 0),
          importedNames: aliased.alias && aliased.alias !== aliased.name
            ? [{ local: aliased.alias, original: aliased.name }]
            : null,
        });
      }
      continue;
    }
    if (text.startsWith("from ")) {
      const fromMatch = /^from\s+([.\w]+)\s+import\s+([\s\S]+)$/.exec(text);
      if (!fromMatch) continue;
      const moduleSpec = fromMatch[1]!;
      const namesRaw = fromMatch[2]!.trim().replace(/^\(|\)$/g, "").trim();
      const isRelative = moduleSpec.startsWith(".");
      const dotPrefix = /^(\.+)/.exec(moduleSpec)?.[1] ?? "";
      const moduleNoDots = moduleSpec.slice(dotPrefix.length);
      const importedNames: Array<string | ImportedName> = [];
      let isStar = false;

      for (const item of splitTopLevelCommas(namesRaw)) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (trimmed === "*") {
          isStar = true;
          importedNames.push({ local: "*", original: "*" });
          continue;
        }
        const aliased = parseAliased(trimmed);
        if (!aliased) continue;
        if (aliased.alias && aliased.alias !== aliased.name) {
          importedNames.push({ local: aliased.alias, original: aliased.name });
        } else {
          importedNames.push(aliased.name);
        }
      }

      out.push({
        sourceFile: filePath,
        targetModule: moduleSpec,
        resolvedFile: resolveModule(
          moduleNoDots || ".",
          sourceDir,
          rootDir,
          isRelative,
          dotPrefix.length,
        ),
        importedNames: importedNames.length > 0 ? importedNames : isStar ? [{ local: "*", original: "*" }] : null,
      });
    }
  }

  return out;
}

interface AliasedName { name: string; alias: string | null }

function parseAliased(text: string): AliasedName | null {
  const m = /^([.\w]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1]!, alias: m[2] ?? null };
}

/**
 * Collect top-level `import ...` and `from ... import ...` statements from a
 * Python source. Joins parenthesized line continuations and `\\`-continued
 * lines into a single logical statement. Skips comments and string literals.
 */
function collectImportStatements(source: string): RawImportLine[] {
  const out: RawImportLine[] = [];
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const stripped = stripCommentSafe(raw);
    const trimmed = stripped.trimStart();
    if (!trimmed.startsWith("import ") && !trimmed.startsWith("from ")) {
      i++;
      continue;
    }
    // We only care about TOP-LEVEL imports (no leading whitespace). This
    // matches PEP 8 and the way persist.ts treats import edges as file-scoped.
    if (raw.length !== raw.trimStart().length) {
      i++;
      continue;
    }
    const startLine = i + 1;
    let collected = trimmed;
    // Continue with `(...)` until balanced.
    let depth = parenDepth(collected);
    let j = i + 1;
    while (depth > 0 && j < lines.length) {
      const next = stripCommentSafe(lines[j] ?? "");
      collected += " " + next.trim();
      depth += parenDepth(next);
      j++;
    }
    // Continue with `\`-continued lines.
    while (collected.endsWith("\\") && j < lines.length) {
      collected = collected.slice(0, -1).trim();
      const next = stripCommentSafe(lines[j] ?? "");
      collected += " " + next.trim();
      j++;
    }
    out.push({ text: collected.replace(/\s+/g, " ").trim(), startLine });
    i = Math.max(j, i + 1);
  }
  return out;
}

/** Strip trailing `# ...` comment from a line, ignoring `#` inside strings. */
function stripCommentSafe(line: string): string {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch as '"' | "'";
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parenDepth(line: string): number {
  let inStr: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch as '"' | "'";
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch as '"' | "'";
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out;
}

function resolveModule(
  moduleName: string,
  sourceDir: string,
  rootDir: string,
  isRelative: boolean,
  relativeDepth: number,
): string | null {
  if (!moduleName || moduleName === ".") {
    if (!isRelative) return null;
    // `from . import x` — same directory.
    return null; // The bare `from . import x` doesn't resolve to one file; the imported names are.
  }
  let baseDir: string;
  if (isRelative) {
    baseDir = sourceDir;
    for (let i = 1; i < relativeDepth; i++) {
      baseDir = path.dirname(baseDir);
    }
  } else {
    baseDir = rootDir;
  }
  const parts = moduleName.split(".");
  const tryFile = path.join(baseDir, ...parts) + ".py";
  if (safeIsFile(tryFile)) {
    return relPathOrNull(tryFile, rootDir);
  }
  const tryInit = path.join(baseDir, ...parts, "__init__.py");
  if (safeIsFile(tryInit)) {
    return relPathOrNull(tryInit, rootDir);
  }
  return null;
}

function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function relPathOrNull(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath);
  if (!rel || rel.startsWith("..")) return null;
  return normalizePath(rel);
}
