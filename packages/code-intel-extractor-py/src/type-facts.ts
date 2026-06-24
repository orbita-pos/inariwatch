// CodeTypeFact rows for function-shaped symbols. Pulls structured info from
// the cached hover (signature → params + return type) plus a coarse
// side-effect heuristic over the symbol's source.
//
// `throws` is parsed from the docstring (Sphinx `:raises:` and Google `Raises:`
// styles). Python doesn't have an exception declaration on the signature, so
// docstring is the only structural source we can rely on. AST-based exception
// flow analysis is out of scope for v0.1.
//
// `sideEffects` is a regex-based scan of the symbol's source. Same approach
// as the TS extractor — looks for known DB clients, HTTP libraries, and
// filesystem write functions. Not a guarantee, but good enough to feed the
// container agent a "this writes to db" hint.

import type { ParsedHover } from "./hover-parse.js";
import type { CodeSymbol, CodeTypeFact, ParamType, SideEffects, SymbolKind } from "./types.js";

const DB_CLIENT_NAMES = new Set([
  "session",
  "cursor",
  "conn",
  "connection",
  "db",
  "engine",
  "psycopg",
  "psycopg2",
  "asyncpg",
  "sqlalchemy",
  "redis",
  "supabase",
  "pymongo",
  "motor",
]);

const HTTP_CLIENT_NAMES = new Set([
  "requests",
  "httpx",
  "urllib",
  "aiohttp",
  "fetch",
  "session",
]);

const FS_WRITE_METHODS = new Set([
  "write",
  "writelines",
  "write_bytes",
  "write_text",
  "unlink",
  "rmdir",
  "rename",
  "remove",
  "rmtree",
]);

export interface ExtractTypeFactsParams {
  symbol: CodeSymbol;
  hover: ParsedHover;
  /** Source of the symbol (def header + body). Used for side-effects + throws. */
  source: string;
  /** Full file source — used to read the docstring if hover doesn't include it. */
  fileSource: string;
  /** 0-based start/end lines of the symbol within the file. */
  startLine: number;
  endLine: number;
}

export function extractTypeFacts(params: ExtractTypeFactsParams): CodeTypeFact | null {
  const { symbol, hover, source, fileSource } = params;

  const isFunctionLike = symbol.kind === "function" || symbol.kind === "method";
  if (!isFunctionLike) return null;

  const paramTypes = stripSelf(hover.paramTypes ?? []);
  const returnType = hover.returnType;
  const generics = inferGenerics(hover, source);
  const throws = extractThrows(symbol.docComment, fileSource, params.startLine, params.endLine);
  const sideEffects = inferSideEffects(source);

  if (
    paramTypes.length === 0 &&
    !returnType &&
    !generics &&
    !throws &&
    !sideEffects
  ) {
    return null;
  }

  return {
    symbolFqn: symbol.fqn,
    symbolKind: symbol.kind as SymbolKind,
    paramTypes: paramTypes.length > 0 ? paramTypes : null,
    returnType,
    genericParams: generics,
    throws,
    sideEffects,
  };
}

function stripSelf(params: ParamType[]): ParamType[] {
  if (params.length === 0) return params;
  const first = params[0]!;
  if (first.name === "self" || first.name === "cls") return params.slice(1);
  return params;
}

function inferGenerics(hover: ParsedHover, source: string): string[] | null {
  // Pyright surfaces TypeVars in the signature like `def foo[T](x: T) -> T`
  // (PEP 695). Extract them from the signature's `[...]` if present.
  if (hover.signature) {
    const m = /\bdef\s+\w+\s*\[([^\]]+)\]/.exec(hover.signature);
    if (m && m[1]) {
      return m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  // Older style: `T = TypeVar("T")` at module scope. We can't see module
  // scope from here, but a function that uses `T` in annotations needs the
  // TypeVar declared somewhere. Skip detection for now.
  void source;
  return null;
}

function extractThrows(
  docComment: string | null,
  fileSource: string,
  startLine: number,
  endLine: number,
): string[] | null {
  const out = new Set<string>();

  // Source-side: any `raise FooError(...)` inside the body.
  const lines = fileSource.split(/\r?\n/);
  for (let i = startLine; i <= Math.min(endLine, lines.length - 1); i++) {
    const line = lines[i] ?? "";
    const m = /\braise\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(line);
    if (m && m[1]) out.add(m[1]);
  }

  // Docstring side: Sphinx `:raises X:` and Google `Raises: X`.
  if (docComment) {
    for (const m of docComment.matchAll(/:raises?\s+([A-Za-z_][A-Za-z0-9_.]*)/g)) {
      if (m[1]) out.add(m[1]);
    }
    const googleMatch = /\bRaises:\s*\n([\s\S]*?)(?:\n\s*\n|$)/i.exec(docComment);
    if (googleMatch?.[1]) {
      for (const m of googleMatch[1].matchAll(/^\s*([A-Z][A-Za-z0-9_.]*)\s*:/gm)) {
        if (m[1]) out.add(m[1]);
      }
    }
  }

  return out.size > 0 ? Array.from(out) : null;
}

function inferSideEffects(source: string): SideEffects | null {
  let readsDb = false;
  let writesDb = false;
  const callsExternal = new Set<string>();

  // db.execute(...) / cursor.fetchall() / session.add(...) / engine.connect()
  for (const m of source.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    const root = m[1]!;
    const method = m[2]!;
    if (DB_CLIENT_NAMES.has(root)) {
      if (/^(insert|update|delete|create|drop|truncate|add|merge|commit|flush|save)/i.test(method)) {
        writesDb = true;
      } else if (/^(select|fetch|find|get|query|scan|count|first|all|one)/i.test(method)) {
        readsDb = true;
      } else if (method === "execute" || method === "executemany" || method === "executescript") {
        // Ambiguous — call it both. Container agent can disambiguate via the SQL string.
        readsDb = true;
        writesDb = true;
      }
    }
    if (HTTP_CLIENT_NAMES.has(root)) {
      callsExternal.add(root);
    }
    if (FS_WRITE_METHODS.has(method) && (root.includes("path") || root.includes("file") || root === "os")) {
      callsExternal.add(`fs.${method}`);
    }
  }

  // Bare-name HTTP calls: `requests.get(...)` already covered above; but
  // also `httpx.AsyncClient(...)`, `aiohttp.ClientSession(...)` get caught.
  for (const lib of HTTP_CLIENT_NAMES) {
    const re = new RegExp(`\\b${lib}\\s*\\.`, "g");
    if (re.test(source)) callsExternal.add(lib);
  }

  if (!readsDb && !writesDb && callsExternal.size === 0) return null;
  return {
    readsDb,
    writesDb,
    callsExternal: Array.from(callsExternal).sort(),
  };
}
