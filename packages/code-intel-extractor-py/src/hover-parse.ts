// Pyright's hover output is plaintext — the LSP server returns it as a
// MarkupContent { kind: "plaintext", value: "..." }. Format examples (verified
// against pyright 1.1.380 in src/__tests__/hover-parse.test.ts):
//
//   Function:
//     "(function) def add(\n    a: int,\n    b: int\n) -> int"
//
//   Method:
//     "(method) def greet(self) -> str"
//
//   Async function:
//     "(function) async def fetch(url: str) -> bytes"
//
//   Class:
//     "(class) Greeter"
//
//   Module-level variable:
//     "(variable) x: int"
//     "(constant) MAX_RETRIES: Final[int] = 5"
//
//   Property accessor:
//     "(property) def name(self) -> str"
//
//   Decorated function (e.g., @lru_cache):
//     "(function) def cached(...) -> T"
//
// We parse only the bits we need for v0.1: kind word, async-ness, signature,
// param list, return type, variable type. Anything we can't parse safely
// returns null in the field.

import type { ParamType } from "./types.js";

export interface ParsedHover {
  /** "function" | "method" | "class" | "variable" | "constant" | "property" | ... */
  kindWord: string | null;
  /** Full re-rendered signature: `def name(...) -> RetType`. null for non-functions. */
  signature: string | null;
  /** Return type as a single string (`"int"`, `"User | None"`, ...). null if no annotation. */
  returnType: string | null;
  /** Parsed parameter list (name + type + optional + default). null for non-functions. */
  paramTypes: ParamType[] | null;
  /** Variable / constant type annotation (`"int"`, `"Final[int]"`, ...). null otherwise. */
  variableType: string | null;
  /** True if hover begins with `async def`. */
  isAsync: boolean;
}

const EMPTY: ParsedHover = {
  kindWord: null,
  signature: null,
  returnType: null,
  paramTypes: null,
  variableType: null,
  isAsync: false,
};

export function parseHoverText(text: string): ParsedHover {
  if (!text) return EMPTY;
  const trimmed = text.trim();

  // Pyright sometimes wraps hover in a Markdown code fence — strip it.
  const stripped = trimmed
    .replace(/^```python\n?/i, "")
    .replace(/```$/, "")
    .trim();

  // Leading "(kindword) " marker.
  const kindMatch = /^\(([a-zA-Z_][a-zA-Z0-9_ ]*?)\)\s*([\s\S]*)$/.exec(stripped);
  const kindWord = kindMatch?.[1]?.trim() ?? null;
  const body = kindMatch ? kindMatch[2]!.trim() : stripped;

  // Detect a function-like body: `def NAME(...)` or `async def NAME(...)`,
  // optionally with a return annotation and either inline or multi-line.
  const fnMatch = matchFunctionBody(body);
  if (fnMatch) {
    return {
      kindWord,
      signature: fnMatch.signature,
      returnType: fnMatch.returnType,
      paramTypes: fnMatch.paramTypes,
      variableType: null,
      isAsync: fnMatch.isAsync,
    };
  }

  // Variable / constant: `name: Type` or `name: Type = default`.
  const varMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+?)(?:\s*=\s*[\s\S]*)?$/.exec(body);
  if (varMatch) {
    return {
      ...EMPTY,
      kindWord,
      variableType: varMatch[2]!.trim(),
    };
  }

  // Class: just the class name (no body).
  if (kindWord === "class") {
    return { ...EMPTY, kindWord };
  }

  return { ...EMPTY, kindWord };
}

interface FunctionParseResult {
  signature: string;
  returnType: string | null;
  paramTypes: ParamType[];
  isAsync: boolean;
}

function matchFunctionBody(body: string): FunctionParseResult | null {
  // Normalize whitespace inside the body so the parser is line-agnostic.
  // We keep the raw body around for deciding async-ness.
  const isAsync = /^\s*async\s+def\b/.test(body);
  const head = body.replace(/^\s*(?:async\s+)?def\s+/, "");
  if (head === body && !/^\s*\(/.test(body)) {
    // Not a function-shaped hover.
    return null;
  }
  // `head` is now `NAME(...) -> RetType` (possibly across lines).
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(head);
  if (!nameMatch) return null;
  const name = nameMatch[1]!;
  const afterName = head.slice(nameMatch[0].length); // starts right after `(`

  // Find the matching close-paren respecting nested brackets/strings.
  const close = findClosingParen(afterName);
  if (close < 0) return null;
  const paramsRaw = afterName.slice(0, close);
  const tail = afterName.slice(close + 1).trim();

  let returnType: string | null = null;
  if (tail.startsWith("->")) {
    returnType = tail.slice(2).trim();
    // Pyright appends the docstring after the signature, separated by a blank
    // line. Truncate the return type at the first newline so we don't capture
    // the docstring as part of the type.
    const nlIdx = returnType.indexOf("\n");
    if (nlIdx >= 0) returnType = returnType.slice(0, nlIdx).trim();
    // Strip a trailing colon (pyright sometimes appends `:` for definitions).
    if (returnType.endsWith(":")) returnType = returnType.slice(0, -1).trim();
  }

  const paramTypes = parseParamList(paramsRaw);
  const signature = `${isAsync ? "async " : ""}def ${name}(${rerenderParams(paramTypes)})${returnType ? ` -> ${returnType}` : ""}`;

  return { signature, returnType, paramTypes, isAsync };
}

function findClosingParen(s: string): number {
  let depth = 1; // we're already inside the outer (
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') {
      // Skip a string literal.
      const quote = ch;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\") i++; // skip escape
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0 && ch === ")") return i;
    }
    i++;
  }
  return -1;
}

/**
 * Split a parameter list on top-level commas (ignoring commas inside [], (), {}).
 * Each item is parsed as `name: type` or `name: type = default` or just `name`.
 */
function parseParamList(raw: string): ParamType[] {
  if (!raw.trim()) return [];
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      items.push(raw.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  if (start < raw.length) items.push(raw.slice(start).trim());

  const out: ParamType[] = [];
  for (const item of items) {
    const cleaned = item.trim();
    if (!cleaned) continue;
    // Skip pyright bookkeeping markers like `*`, `/`, `**kwargs`-only positional
    // markers — only when they appear bare. (Real `*args`/`**kwargs` stay.)
    if (cleaned === "*" || cleaned === "/") continue;
    out.push(parseSingleParam(cleaned));
  }
  return out;
}

function parseSingleParam(raw: string): ParamType {
  // Possible shapes:
  //   self
  //   name
  //   name: Type
  //   name: Type = default
  //   *args: Type
  //   **kwargs: Type
  //   name=default
  let name = raw;
  let typeStr = "Unknown";
  let defaultValue: string | null = null;
  let optional = false;

  // Extract default first (rightmost top-level `=`).
  const eqIdx = topLevelEqualsIndex(raw);
  if (eqIdx >= 0) {
    defaultValue = raw.slice(eqIdx + 1).trim();
    name = raw.slice(0, eqIdx).trim();
    optional = true;
  }

  // Extract type annotation.
  const colonIdx = topLevelColonIndex(name);
  if (colonIdx >= 0) {
    typeStr = name.slice(colonIdx + 1).trim();
    name = name.slice(0, colonIdx).trim();
  }

  // `*` / `**` prefixes stay on the name; downstream rendering preserves them.
  // `Optional[X]` / `X | None` annotations imply optionality even without a default.
  if (!optional && /(?:^Optional\[|\|\s*None\b|\bNone\s*\|)/.test(typeStr)) {
    optional = true;
  }

  return {
    name: name || "_",
    type: typeStr,
    optional,
    defaultValue,
  };
}

function topLevelEqualsIndex(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "=" && depth === 0) {
      // Skip `==`, `!=`, `>=`, `<=` — those are inside default expressions.
      const prev = s[i - 1];
      const next = s[i + 1];
      if (prev === "=" || prev === "!" || prev === ">" || prev === "<" || next === "=") continue;
      return i;
    }
  }
  return -1;
}

function topLevelColonIndex(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

function rerenderParams(params: ParamType[]): string {
  return params
    .map((p) => {
      const tail = p.defaultValue ? ` = ${p.defaultValue}` : "";
      const typed = p.type && p.type !== "Unknown" ? `: ${p.type}` : "";
      return `${p.name}${typed}${tail}`;
    })
    .join(", ");
}
