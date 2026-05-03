// Map LSP `SymbolKind` numbers to the v2 `CodeSymbol.kind` enum.
//
// LSP enum (https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind):
//   1 File           7 Property      13 Variable      19 Object      25 Operator
//   2 Module         8 Field         14 Constant      20 Key         26 TypeParameter
//   3 Namespace      9 Constructor   15 String        21 Null
//   4 Package       10 Enum          16 Number        22 EnumMember
//   5 Class         11 Interface     17 Boolean       23 Struct
//   6 Method        12 Function      18 Array         24 Event
//
// Pyright uses these for Python:
//   - 5  Class               → "class"
//   - 6  Method              → "method"
//   - 7  Property            → "method"   (Python @property — accessor on a class)
//   - 9  Constructor         → "method"   (rare; pyright also uses 6 for __init__)
//   - 10 Enum                → "enum"
//   - 11 Interface           → "interface" (pyright doesn't emit — Python has no `interface`,
//                                            but Protocol classes COULD be reported here in
//                                            future pyright versions)
//   - 12 Function            → "function" (or "method" if containerName is a class — caller
//                                          resolves)
//   - 13 Variable            → "variable"
//   - 14 Constant            → "variable" (UPPER_CASE module-level)
//   - 22 EnumMember          → "variable"
//   - 23 Struct              → "class"     (pyright uses for `dataclass` — same shape)
//   - 26 TypeParameter       → "type"
//
// Local variables and function parameters also come back as kind=13. The
// extractor filters those out via containerName / parent rules — see symbols.ts.

import type { SymbolKind } from "./types.js";

export interface KindMapResult {
  kind: SymbolKind;
  /** True when this is a class member that should not appear at module scope. */
  isClassMember?: boolean;
}

/**
 * Resolve the v2 `CodeSymbol.kind` for an LSP `SymbolInformation`.
 *
 * `parentIsClass` — true when the symbol's `containerName` resolves to an
 * already-emitted class. Needed because LSP returns kind=12 (Function) for a
 * `def` inside a class even though we want to record it as `method`.
 */
export function mapLspKind(lspKind: number, parentIsClass: boolean): KindMapResult | null {
  switch (lspKind) {
    case 5: // Class
      return { kind: "class" };
    case 6: // Method
    case 7: // Property
    case 9: // Constructor
      return { kind: "method", isClassMember: true };
    case 10: // Enum
      return { kind: "enum" };
    case 11: // Interface
      return { kind: "interface" };
    case 12: // Function
      return parentIsClass
        ? { kind: "method", isClassMember: true }
        : { kind: "function" };
    case 13: // Variable
    case 14: // Constant
    case 22: // EnumMember
      return { kind: "variable" };
    case 23: // Struct (dataclass)
      return { kind: "class" };
    case 26: // TypeParameter
      return { kind: "type" };
    default:
      return null;
  }
}

/**
 * Normalize a name's visibility per Python convention. Single underscore is
 * the canonical "private to the module / class" marker; double-underscore
 * triggers name mangling but pyright reports the unmangled name. We treat
 * both as "private". Dunder methods (__init__, __str__, ...) are public.
 */
export function visibilityFromName(name: string): "private" | null {
  if (!name.startsWith("_")) return null;
  // Dunder method (leading + trailing underscores) — public.
  if (/^__.+__$/.test(name)) return null;
  return "private";
}
