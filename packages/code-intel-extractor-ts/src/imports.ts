// File→file import edges. Used by the Phase 1.3 indexer for transitive
// invalidation: when source_file changes, every file that imports it via
// resolved_file is queued for re-extraction.
//
// `resolved_file` is NULL for external modules (e.g. "react") — we don't
// chase node_modules. Phase 1.4 query API can decide what to do with NULL
// rows (e.g. surface as "external dep" without a path).

import * as path from "node:path";
import * as ts from "typescript";

import { normalizePath } from "./fqn.js";
import type { CodeImport, ImportedName } from "./types.js";

export interface ExtractImportsParams {
  sourceFile: ts.SourceFile;
  filePath: string;        // repo-relative + forward-slashed
  rootDir: string;         // absolute repo root
  resolveModule: (moduleName: string, containingFile: string) => string | null;
}

export function extractImports(params: ExtractImportsParams): CodeImport[] {
  const { sourceFile, filePath, rootDir, resolveModule } = params;
  const out: CodeImport[] = [];
  const containingFile = sourceFile.fileName;

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const targetModule = literalText(stmt.moduleSpecifier);
      if (!targetModule) continue;
      const resolved = resolveModule(targetModule, containingFile);
      const resolvedFile = relPathOrNull(resolved, rootDir);
      const importedNames = collectImportedNames(stmt.importClause);
      out.push({
        sourceFile: filePath,
        targetModule,
        resolvedFile,
        importedNames: importedNames.length > 0 ? importedNames : null,
      });
      continue;
    }
    // export { foo } from "./bar"   — same edge shape as import.
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      const targetModule = literalText(stmt.moduleSpecifier);
      if (!targetModule) continue;
      const resolved = resolveModule(targetModule, containingFile);
      const resolvedFile = relPathOrNull(resolved, rootDir);
      const importedNames = collectReExportedNames(stmt);
      out.push({
        sourceFile: filePath,
        targetModule,
        resolvedFile,
        importedNames: importedNames.length > 0 ? importedNames : null,
      });
    }
  }
  return out;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function collectImportedNames(
  ic: ts.ImportClause | undefined,
): Array<string | ImportedName> {
  if (!ic) return [];
  const out: Array<string | ImportedName> = [];

  if (ic.name) out.push(ic.name.text);

  const named = ic.namedBindings;
  if (!named) return out;

  if (ts.isNamespaceImport(named)) {
    out.push({ local: named.name.text, original: "*" });
    return out;
  }
  for (const el of named.elements) {
    if (el.propertyName && el.propertyName.text !== el.name.text) {
      out.push({ local: el.name.text, original: el.propertyName.text });
    } else {
      out.push(el.name.text);
    }
  }
  return out;
}

function collectReExportedNames(
  decl: ts.ExportDeclaration,
): Array<string | ImportedName> {
  const out: Array<string | ImportedName> = [];
  const clause = decl.exportClause;
  if (!clause) {
    // export * from "..." — represent as the namespace re-export sentinel.
    out.push({ local: "*", original: "*" });
    return out;
  }
  if (ts.isNamespaceExport(clause)) {
    out.push({ local: clause.name.text, original: "*" });
    return out;
  }
  for (const el of clause.elements) {
    if (el.propertyName && el.propertyName.text !== el.name.text) {
      out.push({ local: el.name.text, original: el.propertyName.text });
    } else {
      out.push(el.name.text);
    }
  }
  return out;
}

function relPathOrNull(absPath: string | null, rootDir: string): string | null {
  if (!absPath) return null;
  const rel = path.relative(rootDir, absPath);
  if (!rel || rel.startsWith("..")) return null;
  return normalizePath(rel);
}
