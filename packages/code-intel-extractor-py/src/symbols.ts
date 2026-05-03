// Convert pyright's LSP documentSymbol output (flat SymbolInformation[] with
// containerName) into our `CodeSymbol[]` shape.
//
// Granularity (locked Phase 1.1, applies to the Python extractor too):
// top-level + class members only. Function-local variables, parameters, and
// nested function declarations are NOT emitted.
//
// Filtering rules:
//   1. Top-level symbol (no containerName) → keep if its mapped kind is
//      function/class/variable/enum/type/namespace.
//   2. Symbol with containerName matching an ALREADY-ACCEPTED class → keep
//      if its mapped kind is method/variable. Promote kind=12 (Function) to
//      "method" via mapLspKind(parentIsClass=true).
//   3. Symbol whose containerName matches an accepted function/method →
//      DROP. (These are parameters or function-local vars.)
//
// Hover-driven enrichment:
//   For each accepted symbol we issue ONE `textDocument/hover` request to
//   pyright at the symbol's start position. The returned plaintext is parsed
//   into signature/return-type/param-types (see hover-parse.ts). One round-trip
//   per symbol: 1ms per call locally, ~10-30ms over a forwarded LSP. We dedupe
//   by source position to avoid hovering the same symbol twice (rare but
//   possible if pyright merges declarations).

import { astHash } from "./ast-hash.js";
import { buildFqn, normalizePath } from "./fqn.js";
import { mapLspKind, visibilityFromName } from "./kind-map.js";
import type {
  PyrightLspClient,
  Position,
  SymbolInformation,
} from "./lsp.js";
import { parseHoverText, type ParsedHover } from "./hover-parse.js";
import type { CodeSymbol, ParamType, SymbolKind, Visibility } from "./types.js";

export interface SymbolEmission {
  symbol: CodeSymbol;
  /** LSP origin record — Phase 2.2 references.ts uses this to issue follow-up requests. */
  origin: SymbolInformation;
  /** Cached hover parse — Phase 2.2 type-facts.ts re-uses this. */
  hover: ParsedHover;
  /**
   * Position of the identifier name within the source. Pyright's `references`
   * and `hover` requests need the position of the NAME, not the start of the
   * `def`/`class` line. Stored once during extraction so the references pass
   * doesn't have to re-locate it.
   */
  nameAnchor: { line: number; character: number };
}

export interface ExtractSymbolsParams {
  client: PyrightLspClient;
  uri: string;
  filePath: string;          // repo-relative, forward-slashed
  source: string;            // file contents — used for ast-hash + class-extends parsing
  symbols: SymbolInformation[];
}

export async function extractSymbols(
  params: ExtractSymbolsParams,
): Promise<SymbolEmission[]> {
  const { client, uri, filePath, source, symbols } = params;

  // First pass — accept top-level symbols. We need this before processing
  // class members so the containerName lookup can resolve.
  const accepted: SymbolEmission[] = [];
  // Index by source-line range so a symbol can find its parent without
  // ambiguity even when two classes share a name (rare in real code, but
  // the schema's UNIQUE(repo_id, fqn, kind) doesn't help us here because
  // the containerName lookup is name-only).
  const acceptedClassesByName = new Map<string, SymbolEmission[]>();
  const acceptedFunctionsByName = new Set<string>();

  // Sort symbols by start line so parents always precede their children.
  const ordered = symbols
    .slice()
    .sort((a, b) => {
      const al = a.location.range.start.line;
      const bl = b.location.range.start.line;
      if (al !== bl) return al - bl;
      return a.location.range.start.character - b.location.range.start.character;
    });

  const sourceLines = source.split(/\r?\n/);

  for (const lspSym of ordered) {
    const containerName = lspSym.containerName?.trim() ?? "";
    let parent: SymbolEmission | null = null;
    let parentIsClass = false;

    if (containerName) {
      // Find the closest accepted class with matching name whose range
      // contains this symbol's range. (Closest = innermost.)
      const candidates = acceptedClassesByName.get(containerName) ?? [];
      let best: SymbolEmission | null = null;
      let bestSpan = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        if (rangeContains(c.origin.location.range, lspSym.location.range)) {
          const span = lineSpan(c.origin.location.range);
          if (span < bestSpan) {
            best = c;
            bestSpan = span;
          }
        }
      }
      if (best) {
        parent = best;
        parentIsClass = true;
      } else if (acceptedFunctionsByName.has(containerName)) {
        // Container is an accepted function — this is a function-local symbol.
        continue;
      } else {
        // Unknown container — keep walking; this might be a method on a
        // dataclass we'll see later, but if not, we drop. For v0.1, drop.
        continue;
      }
    }

    const mapped = mapLspKind(lspSym.kind, parentIsClass);
    if (!mapped) continue;
    if (mapped.isClassMember && !parent) continue; // method without a class parent — drop

    const name = lspSym.name;
    if (!name || name === "<lambda>") continue;

    // Filter out function-local class members (e.g., a class defined inside a
    // method): if any ancestor in containerName chain isn't a class we
    // accepted, drop. Handled above.

    // Build owner chain from parent's chain + this name.
    const ownerChain = parent
      ? [...ownerChainOf(parent.symbol), name]
      : [name];
    const fqn = buildFqn(filePath, ownerChain);

    const range = lspSym.location.range;
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const startCol = range.start.character;
    const endCol = range.end.character;

    // Pull the source slice for ast-hash + decorator/abstract detection.
    const symSource = sliceSource(sourceLines, range.start.line, range.end.line);

    // Find the actual def/class/var line within the range — pyright sometimes
    // includes decorator lines in the symbol range, so range.start.line may
    // point at `@abstractmethod` rather than `def read`. Locating the def/
    // class line gives us the right anchor for both decorator scanning AND
    // for the hover request (pyright wants the position of the NAME, not the
    // start of the line).
    const defLineIdx = findDeclarationLine(
      sourceLines,
      range.start.line,
      range.end.line,
      name,
      mapped.kind,
    );
    const defLine = sourceLines[defLineIdx] ?? "";
    const nameCol = findIdentifierColumn(defLine, name);

    const decorators = collectDecoratorsBefore(sourceLines, defLineIdx);
    const isAbstract = decorators.some((d) => /\babstractmethod\b/.test(d));
    const isStatic =
      decorators.some((d) => /\b(staticmethod|classmethod)\b/.test(d)) ||
      (mapped.kind === "variable" && parentIsClass); // class-level vars are static

    const hover = await safeHover(client, uri, {
      line: defLineIdx,
      character: nameCol,
    });
    const parsedHover = parseHoverText(hoverPlaintext(hover));

    const isAsync =
      parsedHover.isAsync ||
      /^\s*async\s+def\b/.test(symSource);

    const visibility: Visibility | null = visibilityFromName(name);

    const docComment = extractDocstring(sourceLines, range.start.line, range.end.line);

    const sig = parsedHover.signature;
    const retType = parsedHover.returnType ?? parsedHover.variableType;

    const symbol: CodeSymbol = {
      fqn,
      kind: mapped.kind,
      name,
      filePath: normalizePath(filePath),
      startLine,
      endLine,
      startCol,
      endCol,
      signature: sig,
      returnType: retType,
      isAsync,
      isExported: !name.startsWith("_") || /^__.+__$/.test(name),
      isStatic,
      isAbstract,
      visibility,
      docComment,
      parentFqn: parent ? parent.symbol.fqn : null,
      parentKind: parent ? parent.symbol.kind : null,
      language: "python",
      astHash: astHash(mapped.kind, symSource),
    };

    const emission: SymbolEmission = {
      symbol,
      origin: lspSym,
      hover: parsedHover,
      nameAnchor: { line: defLineIdx, character: nameCol },
    };
    accepted.push(emission);

    if (mapped.kind === "class" || mapped.kind === "interface" || mapped.kind === "enum") {
      const arr = acceptedClassesByName.get(name) ?? [];
      arr.push(emission);
      acceptedClassesByName.set(name, arr);
    }
    if (mapped.kind === "function" || mapped.kind === "method") {
      acceptedFunctionsByName.add(name);
    }
  }

  return accepted;
}

function rangeContains(outer: SymbolInformation["location"]["range"], inner: SymbolInformation["location"]["range"]): boolean {
  if (outer.start.line < inner.start.line) {
    if (outer.end.line > inner.end.line) return true;
    if (outer.end.line === inner.end.line && outer.end.character >= inner.end.character) return true;
    return false;
  }
  if (outer.start.line === inner.start.line) {
    if (outer.start.character > inner.start.character) return false;
    if (outer.end.line > inner.end.line) return true;
    if (outer.end.line === inner.end.line && outer.end.character >= inner.end.character) return true;
  }
  return false;
}

function lineSpan(r: SymbolInformation["location"]["range"]): number {
  return r.end.line - r.start.line;
}

function ownerChainOf(s: CodeSymbol): string[] {
  if (!s.parentFqn) return [s.name];
  // The owner chain is the parent's owner chain + this symbol's name. We
  // recover it by re-parsing the parent's FQN. The FQN format is
  // `<file>::<a>.<b>.<c>` so the chain is everything after `::` split by `.`.
  const idx = s.fqn.indexOf("::");
  if (idx < 0) return [s.name];
  return s.fqn.slice(idx + 2).split(".");
}

function sliceSource(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine, endLine + 1).join("\n");
}

function collectDecoratorsBefore(lines: string[], defLineIdx: number): string[] {
  const out: string[] = [];
  for (let i = defLineIdx - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("@")) {
      out.push(trimmed.slice(1));
      continue;
    }
    break;
  }
  return out;
}

/**
 * Locate the line containing the actual `def`/`class`/variable declaration
 * within a SymbolInformation range. Pyright sometimes anchors the range at
 * a decorator instead of the `def`/`class` line, so we scan within the
 * range for the canonical declaration line.
 *
 * Falls back to `range.start.line` if no match is found (defensive).
 */
function findDeclarationLine(
  lines: string[],
  startLine: number,
  endLine: number,
  name: string,
  kind: SymbolKind,
): number {
  const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordBoundary = new RegExp(`\\b${escName}\\b`);
  const isFunctionLike = kind === "function" || kind === "method";

  const upperBound = Math.min(endLine, startLine + 50);
  for (let i = startLine; i <= upperBound && i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (isFunctionLike) {
      if ((trimmed.startsWith("def ") || trimmed.startsWith("async def ")) && wordBoundary.test(line)) {
        return i;
      }
    } else if (kind === "class" || kind === "interface" || kind === "enum") {
      if (trimmed.startsWith("class ") && wordBoundary.test(line)) return i;
    } else {
      // Variable / constant / type alias — name appears at left of `:` or `=`.
      if (wordBoundary.test(line)) return i;
    }
  }
  return startLine;
}

function findIdentifierColumn(line: string, name: string): number {
  const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b${escName}\\b`).exec(line);
  return m ? m.index : 0;
}

function extractDocstring(lines: string[], startLine: number, endLine: number): string | null {
  // Find the first non-blank, non-comment line after the def/class signature.
  // Skip past the signature itself (which may span multiple lines via `(...)`).
  let i = startLine + 1;
  // Skip continuation lines of the signature — heuristic: while the line ends
  // with `,` `(` `[` `\`, keep going.
  while (i < lines.length && /[,([\\]\s*$/.test(lines[i] ?? "")) i++;
  // Move past blank/comment lines.
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    break;
  }
  if (i > endLine) return null;
  const candidate = (lines[i] ?? "").trim();
  if (!candidate) return null;

  // Triple-quoted string?
  const tripleMatch = /^([rRbBuU]?)("""|''')([\s\S]*)$/.exec(candidate);
  if (!tripleMatch) return null;
  const quote = tripleMatch[2]!;
  let body = tripleMatch[3] ?? "";
  if (body.endsWith(quote)) {
    return body.slice(0, -quote.length).trim() || null;
  }
  // Multi-line — keep collecting until we see the closing triple quote.
  const parts: string[] = [body];
  for (let j = i + 1; j <= endLine && j < lines.length; j++) {
    const next = lines[j] ?? "";
    const closeIdx = next.indexOf(quote);
    if (closeIdx >= 0) {
      parts.push(next.slice(0, closeIdx));
      return dedentDoc(parts.join("\n")).trim() || null;
    }
    parts.push(next);
  }
  return dedentDoc(parts.join("\n")).trim() || null;
}

function dedentDoc(s: string): string {
  const lines = s.split(/\r?\n/);
  // Compute the minimum indentation among non-empty non-first lines.
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    if (!ln.trim()) continue;
    const m = /^(\s*)/.exec(ln);
    const indent = m?.[1]?.length ?? 0;
    if (indent < min) min = indent;
  }
  if (!isFinite(min) || min === 0) return s;
  return lines
    .map((ln, idx) => (idx === 0 ? ln : ln.slice(min)))
    .join("\n");
}

async function safeHover(client: PyrightLspClient, uri: string, position: Position) {
  try {
    return await client.hover(uri, position);
  } catch {
    return null;
  }
}

function hoverPlaintext(h: ReturnType<PyrightLspClient["hover"]> extends Promise<infer T> ? T : never): string {
  if (!h) return "";
  const c = h.contents as
    | string
    | { kind?: string; value?: string }
    | Array<string | { value?: string }>;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === "string" ? x : x?.value ?? "")).join("\n");
  }
  if (c && typeof c === "object" && "value" in c) return c.value ?? "";
  return "";
}

/** Re-export ParamType for downstream consumers — hover-parse owns the parse. */
export type { ParamType };
/** Tiny helper consumed by extractor.ts to avoid duplicating the kind union. */
export type { SymbolKind };
