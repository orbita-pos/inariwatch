/**
 * Code Intelligence v2 — semantic query API.
 *
 * Per CODE_INTELLIGENCE_V2_HANDOFF.md §1.4. Read-side surface for the
 * v2 module. Every query is repo-scoped and hits Postgres directly via
 * Drizzle. No embedding calls in the primary path — those stay on v1.
 *
 * Target latency budget (Phase 3 acceptance): P95 < 50 ms on a 100k-symbol
 * repo. Index design (migration 0079) supports this:
 *   - findReferences / blastRadius walk `idx_code_references_target` (btree).
 *   - findDefinition / getSymbolByFqn use `code_symbols_fqn_unique` (unique).
 *   - typeAt scans `idx_code_symbols_repo_file` then filters by line.
 *   - searchSemantic does fuzzy on `code_symbols.name` (idx_code_symbols_name).
 *   - whoImports walks `idx_code_imports_target`.
 */

import { and, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  codeImports,
  codeReferences,
  codeSymbols,
  codeTypeFacts,
  type CodeImport,
  type CodeReference,
  type CodeSymbol,
  type CodeTypeFact,
} from "@/lib/db/schema";

// ── Public types ─────────────────────────────────────────────────────────────

export interface SemanticSearchOptions {
  limit?: number;
  fileFilter?: string[];
  /** When true, skip the references/typeFacts enrichment for cheap latency. */
  shallow?: boolean;
}

export interface SemanticSearchResult {
  symbol: CodeSymbol;
  callers: CodeReference[];
  callees: CodeReference[];
  typeFacts: CodeTypeFact | null;
}

export interface BlastRadiusResult {
  symbols: CodeSymbol[];
  depth: number;
}

export interface TypeAtResult {
  type: string;
  symbol: CodeSymbol | null;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_BLAST_DEPTH = 2;
const MAX_ENRICHMENT_REFS = 10;

// ── Top-level queries ────────────────────────────────────────────────────────

/**
 * Every USE-site of the symbol identified by `(symbolFqn, symbolKind?)`.
 * Returns one row per reference. If `symbolKind` is omitted, returns refs
 * targeting any merged-declaration facet of that FQN (interface + namespace
 * sharing the same FQN).
 */
export async function findReferences(
  symbolFqn: string,
  repoId: string,
  symbolKind?: string,
): Promise<CodeReference[]> {
  const symbols = await getSymbolsByFqn(symbolFqn, repoId, symbolKind);
  if (symbols.length === 0) return [];
  const ids = symbols.map((s) => s.id);
  return db
    .select()
    .from(codeReferences)
    .where(
      and(
        eq(codeReferences.repoId, repoId),
        inArray(codeReferences.targetSymbolId, ids),
      ),
    );
}

/**
 * The first declaration matching `(symbolFqn, symbolKind?)`. When merging is
 * in play, prefer the value-bearing kind (class > function > variable >
 * interface > namespace > type > enum). Returns null when nothing matches.
 */
export async function findDefinition(
  symbolFqn: string,
  repoId: string,
  symbolKind?: string,
): Promise<CodeSymbol | null> {
  const rows = await getSymbolsByFqn(symbolFqn, repoId, symbolKind);
  if (rows.length === 0) return null;
  return rows.sort(byKindPreference)[0] ?? null;
}

/**
 * Resolve the symbol that contains the given file:line position. Returns
 * the innermost match (smallest line range that still covers `line`). If
 * a row's start_col/end_col is set we honor `col`, otherwise the line is
 * sufficient.
 */
export async function typeAt(
  filePath: string,
  line: number,
  col: number | null,
  repoId: string,
): Promise<TypeAtResult | null> {
  const rows = await db
    .select()
    .from(codeSymbols)
    .where(
      and(
        eq(codeSymbols.repoId, repoId),
        eq(codeSymbols.filePath, filePath),
        sql`${codeSymbols.startLine} <= ${line}`,
        sql`${codeSymbols.endLine} >= ${line}`,
      ),
    );

  if (rows.length === 0) return null;

  // Pick the smallest range — innermost symbol wins.
  const innermost = rows.reduce((best, cur) => {
    const span = cur.endLine - cur.startLine;
    const bestSpan = best.endLine - best.startLine;
    return span < bestSpan ? cur : best;
  }, rows[0]!);

  // Try to enrich with structured type-facts.
  const [fact] = await db
    .select()
    .from(codeTypeFacts)
    .where(eq(codeTypeFacts.symbolId, innermost.id))
    .limit(1);

  const typeStr = fact?.returnType ?? innermost.returnType ?? innermost.signature ?? innermost.kind;
  return { type: typeStr, symbol: innermost };
}

/**
 * Transitive caller closure of a symbol up to `depth` hops. Returns the
 * unique set of symbols (NOT references) that depend on the seed within
 * the given depth. Default depth = 2 (matches the handoff's container-agent
 * tool default). Cap depth at 5 — beyond that the result becomes too noisy
 * to feed into a remediation prompt.
 */
export async function blastRadius(
  symbolFqn: string,
  repoId: string,
  depth: number = DEFAULT_BLAST_DEPTH,
): Promise<BlastRadiusResult> {
  const safeDepth = Math.max(1, Math.min(depth, 5));
  const seeds = await getSymbolsByFqn(symbolFqn, repoId);
  if (seeds.length === 0) return { symbols: [], depth: safeDepth };

  let frontier = new Set(seeds.map((s) => s.id));
  const visited = new Set<string>(frontier);
  const collected = new Map<string, CodeSymbol>();
  for (const s of seeds) collected.set(s.id, s);

  for (let d = 0; d < safeDepth; d++) {
    if (frontier.size === 0) break;
    const ids = Array.from(frontier);
    const refs = await db
      .select({
        sourceId: codeReferences.sourceSymbolId,
      })
      .from(codeReferences)
      .where(
        and(
          eq(codeReferences.repoId, repoId),
          inArray(codeReferences.targetSymbolId, ids),
          sql`${codeReferences.sourceSymbolId} IS NOT NULL`,
        ),
      );
    const nextIds = refs
      .map((r) => r.sourceId)
      .filter((id): id is string => !!id && !visited.has(id));
    if (nextIds.length === 0) break;

    const nextSymbols = await db
      .select()
      .from(codeSymbols)
      .where(
        and(
          eq(codeSymbols.repoId, repoId),
          inArray(codeSymbols.id, nextIds),
        ),
      );
    for (const s of nextSymbols) {
      collected.set(s.id, s);
      visited.add(s.id);
    }
    frontier = new Set(nextIds);
  }

  // Don't return the seeds themselves — caller usually already has them.
  for (const s of seeds) collected.delete(s.id);
  return { symbols: Array.from(collected.values()), depth: safeDepth };
}

/**
 * Fuzzy name search across symbols in a repo. Primary path is BM25-style
 * fuzzy on `name` (powered by the `idx_code_symbols_name` btree + ILIKE
 * for the wildcard match). When the query is a known FQN, falls through
 * to the exact lookup automatically.
 */
export async function searchSemantic(
  query: string,
  repoId: string,
  opts: SemanticSearchOptions = {},
): Promise<SemanticSearchResult[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const trimmed = query.trim();
  if (!trimmed) return [];

  // FQN fast path — `path::leaf` shape.
  if (trimmed.includes("::")) {
    const sym = await findDefinition(trimmed, repoId);
    return sym ? enrichSymbols([sym], repoId, opts) : [];
  }

  const baseWhere: SQL<unknown>[] = [eq(codeSymbols.repoId, repoId)];
  const lower = trimmed.toLowerCase();
  // Prefix + contains match. Both indexable; both ranked by length (shorter
  // = closer). We use ILIKE against `name`; with the existing
  // (repo_id, name) btree, the planner will use it for the LIKE prefix
  // when the locale allows. Otherwise a sequential scan within the repo —
  // still fast at typical repo size.
  baseWhere.push(or(ilike(codeSymbols.name, `${lower}%`), ilike(codeSymbols.name, `%${lower}%`))!);

  if (opts.fileFilter && opts.fileFilter.length > 0) {
    baseWhere.push(inArray(codeSymbols.filePath, opts.fileFilter));
  }

  const rows = await db
    .select()
    .from(codeSymbols)
    .where(and(...baseWhere))
    .orderBy(sql`length(${codeSymbols.name}) ASC`)
    .limit(limit);

  return enrichSymbols(rows, repoId, opts);
}

/**
 * All edges where `target_module` resolved to `modulePath` (repo-relative)
 * OR matches the raw module specifier verbatim. Used by Phase 1.6's
 * container-agent tools and Phase 1.7's A/B widget.
 */
export async function whoImports(
  modulePath: string,
  repoId: string,
): Promise<CodeImport[]> {
  return db
    .select()
    .from(codeImports)
    .where(
      and(
        eq(codeImports.repoId, repoId),
        or(
          eq(codeImports.resolvedFile, modulePath),
          eq(codeImports.targetModule, modulePath),
        )!,
      ),
    );
}

/**
 * Direct catalogue lookup. Returns the first row matching `(repo_id, fqn)`
 * (or with `kind` when supplied). For declaration-merging cases use
 * `getSymbolsByFqn` instead.
 */
export async function getSymbolByFqn(
  fqn: string,
  repoId: string,
  kind?: string,
): Promise<CodeSymbol | null> {
  const rows = await getSymbolsByFqn(fqn, repoId, kind);
  return rows.length > 0 ? rows[0] ?? null : null;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function getSymbolsByFqn(
  fqn: string,
  repoId: string,
  kind?: string,
): Promise<CodeSymbol[]> {
  const conds: SQL<unknown>[] = [
    eq(codeSymbols.repoId, repoId),
    eq(codeSymbols.fqn, fqn),
  ];
  if (kind) conds.push(eq(codeSymbols.kind, kind));
  return db
    .select()
    .from(codeSymbols)
    .where(and(...conds));
}

const KIND_PRIORITY: Record<string, number> = {
  class: 0,
  function: 1,
  method: 2,
  variable: 3,
  interface: 4,
  namespace: 5,
  type: 6,
  enum: 7,
};

function byKindPreference(a: CodeSymbol, b: CodeSymbol): number {
  const pa = KIND_PRIORITY[a.kind] ?? 99;
  const pb = KIND_PRIORITY[b.kind] ?? 99;
  return pa - pb;
}

async function enrichSymbols(
  symbols: CodeSymbol[],
  repoId: string,
  opts: SemanticSearchOptions,
): Promise<SemanticSearchResult[]> {
  if (symbols.length === 0) return [];
  if (opts.shallow) {
    return symbols.map((s) => ({ symbol: s, callers: [], callees: [], typeFacts: null }));
  }

  const ids = symbols.map((s) => s.id);
  const callersRows = await db
    .select()
    .from(codeReferences)
    .where(
      and(
        eq(codeReferences.repoId, repoId),
        inArray(codeReferences.targetSymbolId, ids),
      ),
    )
    .limit(ids.length * MAX_ENRICHMENT_REFS);

  const calleesRows = await db
    .select()
    .from(codeReferences)
    .where(
      and(
        eq(codeReferences.repoId, repoId),
        inArray(codeReferences.sourceSymbolId, ids),
      ),
    )
    .limit(ids.length * MAX_ENRICHMENT_REFS);

  const factsRows = await db
    .select()
    .from(codeTypeFacts)
    .where(inArray(codeTypeFacts.symbolId, ids));

  const callersBySymbol = bucketBy(callersRows, (r) => r.targetSymbolId);
  const calleesBySymbol = bucketBy(calleesRows, (r) => r.sourceSymbolId ?? "");
  const factsBySymbol = new Map(factsRows.map((f) => [f.symbolId, f]));

  return symbols.map((s) => ({
    symbol: s,
    callers: (callersBySymbol.get(s.id) ?? []).slice(0, MAX_ENRICHMENT_REFS),
    callees: (calleesBySymbol.get(s.id) ?? []).slice(0, MAX_ENRICHMENT_REFS),
    typeFacts: factsBySymbol.get(s.id) ?? null,
  }));
}

function bucketBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const arr = out.get(k);
    if (arr) arr.push(row);
    else out.set(k, [row]);
  }
  return out;
}
