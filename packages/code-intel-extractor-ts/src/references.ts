// Walk a source file and emit CodeReference rows. Each reference is a
// USE-site of a declared symbol — calls, type refs, extends/implements,
// imports, JSX usages, and re-exports.
//
// Resolution strategy:
//   1. For each `Identifier` node we encounter, ask the type checker for
//      its symbol via `getSymbolAtLocation`.
//   2. Walk symbol declarations and pick the first one we have a FQN for
//      (we built that map in extractor.ts when emitting symbols).
//   3. Determine the enclosing source-symbol (the closest ancestor that's
//      one of our emitted symbols) — that's the `sourceFqn` of the ref.
//
// We deliberately avoid `ts.findReferences` / LanguageService here. With
// the FQN map in hand, an identifier-walk + getSymbolAtLocation gives the
// same answer for the use cases v2 cares about (call sites, type refs,
// imports) at a fraction of the cost.

import * as ts from "typescript";

import { normalizePath } from "./fqn.js";
import type { CodeReference, ReferenceKind, SymbolKind } from "./types.js";

export interface ReferenceTarget {
  fqn: string;
  kind: SymbolKind;
}

export interface ExtractReferencesParams {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  filePath: string;
  // Map from a declaration's `ts.Symbol` (identity) to its emitted FQN/kind.
  // Built by extractor.ts after symbol extraction completes for all files.
  symbolToFqn: Map<ts.Symbol, ReferenceTarget>;
  // Map from a decl node back to its enclosing emitted FQN, used to compute
  // `sourceFqn` (the caller).
  declToOwnerFqn: Map<ts.Node, ReferenceTarget>;
}

export function extractReferences(params: ExtractReferencesParams): CodeReference[] {
  const { sourceFile, checker, filePath, symbolToFqn, declToOwnerFqn } = params;
  const out: CodeReference[] = [];
  const normPath = normalizePath(filePath);

  const visit = (node: ts.Node): void => {
    // Calls — note we look at the called expression's identifier.
    if (ts.isCallExpression(node)) {
      const target = resolveTargetFromExpression(node.expression, checker, symbolToFqn);
      if (target) emitRef(node.expression, target, "call");
    }

    // JSX element usages — <MyComponent /> → reference to MyComponent.
    if (ts.isJsxOpeningLikeElement(node)) {
      const target = resolveTargetFromExpression(node.tagName, checker, symbolToFqn);
      if (target) emitRef(node.tagName, target, "jsx_use");
    }

    // Heritage clauses — extends / implements.
    if (ts.isHeritageClause(node)) {
      const kind: ReferenceKind = node.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of node.types) {
        const target = resolveTargetFromExpression(type.expression, checker, symbolToFqn);
        if (target) emitRef(type.expression, target, kind);
      }
    }

    // Type references — Foo, Foo<T>, Bar.Baz.
    if (ts.isTypeReferenceNode(node)) {
      const target = resolveTargetFromTypeName(node.typeName, checker, symbolToFqn);
      if (target) emitRef(node.typeName, target, "type_ref");
    }

    // Imports — covered separately by imports.ts but we also surface a
    // per-name reference so blast_radius queries can chase them.
    if (ts.isImportDeclaration(node) && node.importClause) {
      const ic = node.importClause;
      if (ic.name) {
        const target = resolveTargetByIdentifier(ic.name, checker, symbolToFqn);
        if (target) emitRef(ic.name, target, "import");
      }
      const named = ic.namedBindings;
      if (named) {
        if (ts.isNamedImports(named)) {
          for (const el of named.elements) {
            const target = resolveTargetByIdentifier(el.name, checker, symbolToFqn);
            if (target) emitRef(el.name, target, "import");
          }
        }
      }
    }

    // Re-exports.
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        if (ts.isIdentifier(el.name)) {
          const target = resolveTargetByIdentifier(el.name, checker, symbolToFqn);
          if (target) emitRef(el.name, target, "re_export");
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return out;

  function emitRef(
    site: ts.Node,
    target: ReferenceTarget,
    kind: ReferenceKind,
  ): void {
    const start = sourceFile.getLineAndCharacterOfPosition(site.getStart(sourceFile));
    const owner = enclosingOwner(site, declToOwnerFqn);
    out.push({
      sourceFqn: owner?.fqn ?? null,
      sourceKind: owner?.kind ?? null,
      targetFqn: target.fqn,
      targetKind: target.kind,
      filePath: normPath,
      line: start.line + 1,
      col: start.character,
      kind,
    });
  }
}

function resolveTargetFromExpression(
  expr: ts.Node,
  checker: ts.TypeChecker,
  symbolToFqn: Map<ts.Symbol, ReferenceTarget>,
): ReferenceTarget | null {
  if (ts.isIdentifier(expr)) {
    return resolveTargetByIdentifier(expr, checker, symbolToFqn);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (ts.isIdentifier(expr.name)) {
      return resolveTargetByIdentifier(expr.name, checker, symbolToFqn);
    }
  }
  return null;
}

function resolveTargetFromTypeName(
  name: ts.EntityName,
  checker: ts.TypeChecker,
  symbolToFqn: Map<ts.Symbol, ReferenceTarget>,
): ReferenceTarget | null {
  if (ts.isIdentifier(name)) {
    return resolveTargetByIdentifier(name, checker, symbolToFqn);
  }
  // QualifiedName: A.B.C — use the rightmost.
  return resolveTargetByIdentifier(name.right, checker, symbolToFqn);
}

function resolveTargetByIdentifier(
  ident: ts.Identifier,
  checker: ts.TypeChecker,
  symbolToFqn: Map<ts.Symbol, ReferenceTarget>,
): ReferenceTarget | null {
  let symbol = checker.getSymbolAtLocation(ident);
  if (!symbol) return null;
  // Resolve aliases (import { foo } → original foo).
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      // Some aliases can't be resolved (circular re-export). Fall through.
    }
  }
  return symbolToFqn.get(symbol) ?? null;
}

function enclosingOwner(
  node: ts.Node,
  declToOwnerFqn: Map<ts.Node, ReferenceTarget>,
): ReferenceTarget | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    const owner = declToOwnerFqn.get(cur);
    if (owner) return owner;
    cur = cur.parent;
  }
  return null;
}
