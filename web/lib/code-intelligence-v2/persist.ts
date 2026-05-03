/**
 * Code Intelligence v2 — persist layer.
 *
 * Maps the extractor's record shapes (CodeSymbol / CodeReference / CodeTypeFact /
 * CodeImport from `@inariwatch/code-intel-extractor-ts`) onto the migration 0079
 * tables. Idempotent: re-running with the same input replaces rows for the same
 * `(repo_id, fqn, kind)` symbol on conflict, so an incremental indexer can call
 * `persistRepoExtraction` per file without orchestrating deletes.
 *
 * Scoping: every write in this module is scoped to `repoId`. The caller owns
 * enforcing whether to clear the prior state (full re-index) or merge
 * (incremental).
 */

import { db } from "@/lib/db";
import {
  codeImports,
  codeReferences,
  codeSymbols,
  codeTypeFacts,
} from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  CodeImport,
  CodeReference,
  CodeSymbol,
  CodeTypeFact,
  ExtractorOutput,
} from "@inariwatch/code-intel-extractor-ts";

const SYMBOL_BATCH = 200;
const REFERENCE_BATCH = 500;
const IMPORT_BATCH = 200;
const TYPE_FACT_BATCH = 200;

export interface PersistOptions {
  repoId: string;
  /**
   * When true, every prior row for this repo is cleared before insert.
   * Use for full re-index. For per-file incremental, leave false and pass
   * `clearedFilePaths` so we only purge the rows that belong to changed
   * files.
   */
  fullReindex?: boolean;
  /**
   * Repo-relative file paths whose existing rows should be cleared before
   * the new insert. Honored only when `fullReindex !== true`.
   */
  clearedFilePaths?: string[];
}

export interface PersistResult {
  symbolsInserted: number;
  referencesInserted: number;
  typeFactsInserted: number;
  importsInserted: number;
}

/**
 * Persist a single ExtractorOutput batch for one repo. Caller passes the
 * extractor result + `repoId`; this module owns the SQL boundary.
 */
export async function persistRepoExtraction(
  extraction: ExtractorOutput,
  options: PersistOptions,
): Promise<PersistResult> {
  const { repoId } = options;

  if (options.fullReindex) {
    await clearRepoState(repoId);
  } else if (options.clearedFilePaths && options.clearedFilePaths.length > 0) {
    await clearFiles(repoId, options.clearedFilePaths);
  }

  const symbolIdByKey = await insertSymbols(repoId, extraction.symbols);
  const refsInserted = await insertReferences(
    repoId,
    extraction.references,
    symbolIdByKey,
  );
  const factsInserted = await insertTypeFacts(extraction.typeFacts, symbolIdByKey);
  const importsInserted = await insertImports(repoId, extraction.imports);

  return {
    symbolsInserted: symbolIdByKey.size,
    referencesInserted: refsInserted,
    typeFactsInserted: factsInserted,
    importsInserted,
  };
}

/**
 * Wipes every v2 row owned by a repo. Used for full re-index. The 4 tables
 * cascade on `code_repositories.id`, but during a re-index we keep the repo
 * row in place — so we delete the children explicitly.
 */
export async function clearRepoState(repoId: string): Promise<void> {
  await db.delete(codeImports).where(eq(codeImports.repoId, repoId));
  await db.delete(codeReferences).where(eq(codeReferences.repoId, repoId));
  // type_facts cascades from symbols → wipe symbols last (cascade picks it up).
  await db.delete(codeSymbols).where(eq(codeSymbols.repoId, repoId));
}

/**
 * Wipes only rows whose `file_path` is in the given list. Used for
 * incremental re-index. References scoped to those source files are also
 * dropped because their target symbols may have moved.
 */
export async function clearFiles(repoId: string, filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return;
  await db
    .delete(codeImports)
    .where(and(eq(codeImports.repoId, repoId), inArray(codeImports.sourceFile, filePaths)));
  await db
    .delete(codeReferences)
    .where(and(eq(codeReferences.repoId, repoId), inArray(codeReferences.filePath, filePaths)));
  await db
    .delete(codeSymbols)
    .where(and(eq(codeSymbols.repoId, repoId), inArray(codeSymbols.filePath, filePaths)));
}

async function insertSymbols(
  repoId: string,
  symbols: readonly CodeSymbol[],
): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();
  if (symbols.length === 0) return idByKey;

  for (let i = 0; i < symbols.length; i += SYMBOL_BATCH) {
    const batch = symbols.slice(i, i + SYMBOL_BATCH).map((s) => ({
      repoId,
      fqn: s.fqn,
      kind: s.kind,
      name: s.name,
      filePath: s.filePath,
      startLine: s.startLine,
      endLine: s.endLine,
      startCol: s.startCol,
      endCol: s.endCol,
      signature: s.signature,
      returnType: s.returnType,
      isAsync: s.isAsync,
      isExported: s.isExported,
      isStatic: s.isStatic,
      isAbstract: s.isAbstract,
      visibility: s.visibility,
      docComment: s.docComment,
      // parentId resolution happens in a second pass once every row has
      // an id. Phase 1 stores top-level symbols only, so most rows have
      // no parent at all.
      parentId: null,
      language: s.language,
      astHash: s.astHash,
    }));

    // Idempotency: ON CONFLICT (repo_id, fqn, kind) DO UPDATE.
    const inserted = await db
      .insert(codeSymbols)
      .values(batch)
      .onConflictDoUpdate({
        target: [codeSymbols.repoId, codeSymbols.fqn, codeSymbols.kind],
        set: {
          name: sql`EXCLUDED.name`,
          filePath: sql`EXCLUDED.file_path`,
          startLine: sql`EXCLUDED.start_line`,
          endLine: sql`EXCLUDED.end_line`,
          startCol: sql`EXCLUDED.start_col`,
          endCol: sql`EXCLUDED.end_col`,
          signature: sql`EXCLUDED.signature`,
          returnType: sql`EXCLUDED.return_type`,
          isAsync: sql`EXCLUDED.is_async`,
          isExported: sql`EXCLUDED.is_exported`,
          isStatic: sql`EXCLUDED.is_static`,
          isAbstract: sql`EXCLUDED.is_abstract`,
          visibility: sql`EXCLUDED.visibility`,
          docComment: sql`EXCLUDED.doc_comment`,
          language: sql`EXCLUDED.language`,
          astHash: sql`EXCLUDED.ast_hash`,
          indexedAt: sql`now()`,
        },
      })
      .returning({ id: codeSymbols.id, fqn: codeSymbols.fqn, kind: codeSymbols.kind });

    for (const row of inserted) {
      idByKey.set(symbolKey(row.fqn, row.kind), row.id);
    }
  }

  // Resolve parent ids in a second pass.
  await resolveParentIds(repoId, symbols, idByKey);
  return idByKey;
}

async function resolveParentIds(
  repoId: string,
  symbols: readonly CodeSymbol[],
  idByKey: Map<string, string>,
): Promise<void> {
  for (const s of symbols) {
    if (!s.parentFqn || !s.parentKind) continue;
    const parentId = idByKey.get(symbolKey(s.parentFqn, s.parentKind));
    const childId = idByKey.get(symbolKey(s.fqn, s.kind));
    if (!parentId || !childId) continue;
    await db
      .update(codeSymbols)
      .set({ parentId })
      .where(and(eq(codeSymbols.repoId, repoId), eq(codeSymbols.id, childId)));
  }
}

async function insertReferences(
  repoId: string,
  references: readonly CodeReference[],
  idByKey: Map<string, string>,
): Promise<number> {
  if (references.length === 0) return 0;
  let inserted = 0;
  const rows: Array<typeof codeReferences.$inferInsert> = [];

  for (const r of references) {
    const targetId = idByKey.get(symbolKey(r.targetFqn, r.targetKind));
    if (!targetId) continue; // Target symbol not in catalogue — skip.
    const sourceId = r.sourceFqn && r.sourceKind
      ? idByKey.get(symbolKey(r.sourceFqn, r.sourceKind)) ?? null
      : null;
    rows.push({
      repoId,
      sourceSymbolId: sourceId,
      targetSymbolId: targetId,
      filePath: r.filePath,
      line: r.line,
      col: r.col,
      kind: r.kind,
    });
  }

  for (let i = 0; i < rows.length; i += REFERENCE_BATCH) {
    const batch = rows.slice(i, i + REFERENCE_BATCH);
    await db.insert(codeReferences).values(batch);
    inserted += batch.length;
  }
  return inserted;
}

async function insertTypeFacts(
  facts: readonly CodeTypeFact[],
  idByKey: Map<string, string>,
): Promise<number> {
  if (facts.length === 0) return 0;
  let inserted = 0;
  const rows: Array<typeof codeTypeFacts.$inferInsert> = [];

  for (const f of facts) {
    const symbolId = idByKey.get(symbolKey(f.symbolFqn, f.symbolKind));
    if (!symbolId) continue;
    rows.push({
      symbolId,
      paramTypes: f.paramTypes,
      returnType: f.returnType,
      genericParams: f.genericParams,
      throws: f.throws,
      sideEffects: f.sideEffects,
    });
  }

  for (let i = 0; i < rows.length; i += TYPE_FACT_BATCH) {
    const batch = rows.slice(i, i + TYPE_FACT_BATCH);
    await db.insert(codeTypeFacts).values(batch);
    inserted += batch.length;
  }
  return inserted;
}

async function insertImports(
  repoId: string,
  imports: readonly CodeImport[],
): Promise<number> {
  if (imports.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < imports.length; i += IMPORT_BATCH) {
    const batch = imports.slice(i, i + IMPORT_BATCH).map((imp) => ({
      repoId,
      sourceFile: imp.sourceFile,
      targetModule: imp.targetModule,
      resolvedFile: imp.resolvedFile,
      importedNames: imp.importedNames,
    }));
    await db.insert(codeImports).values(batch);
    inserted += batch.length;
  }
  return inserted;
}

function symbolKey(fqn: string, kind: string): string {
  return `${fqn}::${kind}`;
}
