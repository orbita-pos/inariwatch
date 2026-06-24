// Cross-symbol references via `textDocument/references`. Pyright returns
// every USE-site of the symbol at a position (calls, type annotations,
// inheritance, imports). We classify the use-site by inspecting the source
// line — a coarse but adequate v0.1 heuristic.
//
// One LSP request per accepted symbol. Pyright caches the binding result so
// subsequent requests on the same file are sub-50ms.

import { fileUriToPath, pathToFileUri, type Location, type PyrightLspClient } from "./lsp.js";
import { normalizePath } from "./fqn.js";
import type { CodeReference, ReferenceKind, SymbolKind } from "./types.js";
import type { SymbolEmission } from "./symbols.js";

export interface ExtractReferencesParams {
  client: PyrightLspClient;
  /** Map from a file's URI to the file's source contents. Used to classify use-sites. */
  fileSources: Map<string, string>;
  /** Map from a file URI to its repo-relative forward-slashed path. */
  uriToPath: Map<string, string>;
  /** Symbols emitted by Phase 2.2 symbols.ts — keyed by `${uri}` for parent-of-reference lookup. */
  emissionsByUri: Map<string, SymbolEmission[]>;
  /** Repo root (absolute, forward-slashed). Used to filter out external library refs. */
  repoRootUri: string;
  /** Symbols to gather references for. */
  emissions: SymbolEmission[];
}

export async function extractReferences(
  params: ExtractReferencesParams,
): Promise<CodeReference[]> {
  const out: CodeReference[] = [];
  const { client, fileSources, uriToPath, emissionsByUri, repoRootUri, emissions } = params;

  // Pre-build per-file line-range indexes for source-fqn lookup.
  const enclosingIndex = new Map<string, EnclosingIndex>();
  for (const [uri, fileEmissions] of emissionsByUri) {
    enclosingIndex.set(uri, buildEnclosingIndex(fileEmissions));
  }

  for (const e of emissions) {
    const declUri = pathToFileUri(absoluteFromRel(e.symbol.filePath, repoRootUri));
    // Pyright resolves references via the position of the NAME, not the
    // start of the def/class line. The extractor stores that as `nameAnchor`.
    const refs = await safeReferences(client, declUri, e.nameAnchor);

    const declAnchorLine = e.nameAnchor.line + 1;
    const declAnchorCol = e.nameAnchor.character;

    for (const loc of refs) {
      // Skip references in files outside the repo root.
      if (!loc.uri.startsWith(repoRootUri)) continue;
      const refPath = uriToPath.get(loc.uri) ?? normalizePath(fileUriToPath(loc.uri));
      const refLine = loc.range.start.line + 1;
      const refCol = loc.range.start.character;

      // Skip the declaration site itself — only useful as one of the two
      // (decl + use) refs. References at the same position as the symbol's
      // name anchor are the declaration.
      if (
        refPath === e.symbol.filePath &&
        refLine === declAnchorLine &&
        Math.abs(refCol - declAnchorCol) <= e.symbol.name.length
      ) {
        continue;
      }

      const sourceText = fileSources.get(loc.uri);
      const lineText = sourceText
        ? (sourceText.split(/\r?\n/)[loc.range.start.line] ?? "")
        : "";

      const refKind = classifyReferenceKind(lineText, refCol, e.symbol.name);
      const enclosing = lookupEnclosing(enclosingIndex.get(loc.uri), refLine);

      out.push({
        sourceFqn: enclosing?.fqn ?? null,
        sourceKind: enclosing?.kind ?? null,
        targetFqn: e.symbol.fqn,
        targetKind: e.symbol.kind,
        filePath: refPath,
        line: refLine,
        col: refCol,
        kind: refKind,
      });
    }
  }
  return out;
}

interface EnclosingIndex {
  /** Sorted by `startLine` ASC. Each entry covers `[startLine, endLine]`. */
  ranges: Array<{ startLine: number; endLine: number; fqn: string; kind: SymbolKind }>;
}

function buildEnclosingIndex(emissions: SymbolEmission[]): EnclosingIndex {
  const ranges = emissions
    .filter((e) => e.symbol.kind === "function" || e.symbol.kind === "method" || e.symbol.kind === "class")
    .map((e) => ({
      startLine: e.symbol.startLine,
      endLine: e.symbol.endLine,
      fqn: e.symbol.fqn,
      kind: e.symbol.kind,
    }))
    // Inner ranges first — narrower wins.
    .sort((a, b) => {
      const spanA = a.endLine - a.startLine;
      const spanB = b.endLine - b.startLine;
      return spanA - spanB;
    });
  return { ranges };
}

function lookupEnclosing(
  index: EnclosingIndex | undefined,
  line: number,
): { fqn: string; kind: SymbolKind } | null {
  if (!index) return null;
  for (const r of index.ranges) {
    if (line >= r.startLine && line <= r.endLine) {
      return { fqn: r.fqn, kind: r.kind };
    }
  }
  return null;
}

function classifyReferenceKind(
  lineText: string,
  col: number,
  symbolName: string,
): ReferenceKind {
  if (!lineText) return "call";

  // Quick contextual probes around the reference column.
  const before = lineText.slice(Math.max(0, col - 16), col);
  const after = lineText.slice(col + symbolName.length, col + symbolName.length + 16);

  // class X(Foo, Bar): / class X(metaclass=Foo):
  if (/\bclass\s+\w+\s*\(/.test(lineText) && col > lineText.indexOf("(")) {
    // Inside a class's base-class list and not assignment.
    return "extends";
  }

  // Type annotation: `name: Foo` or `name: Foo[T]` or `-> Foo`.
  if (/[\->]\s*$/.test(before)) return "type_ref";
  if (/:\s*$/.test(before)) return "type_ref";
  if (/^\s*Optional\b|^\s*Union\b|^\s*List\b|^\s*Dict\b|^\s*Tuple\b/.test(after)) return "type_ref";

  // Import statement (covered separately in imports.ts but useful when the
  // reference happens to land on an `import X` line).
  if (/^\s*from\s+|^\s*import\s+/.test(lineText)) return "import";

  // Default — call/usage.
  return "call";
}

function absoluteFromRel(relPath: string, repoRootUri: string): string {
  // repoRootUri is `file:///c%3A/...` or `file:///usr/...`. Decode and
  // forward-slash, then append the rel path.
  const root = fileUriToPath(repoRootUri);
  return `${root}/${relPath}`;
}

async function safeReferences(
  client: PyrightLspClient,
  uri: string,
  position: { line: number; character: number },
): Promise<Location[]> {
  try {
    return await client.references(uri, position, true);
  } catch {
    return [];
  }
}
