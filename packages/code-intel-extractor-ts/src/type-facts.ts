// Compute structured type facts for a symbol — params, return type,
// generic params, throws, side-effect summary.
//
// `throws` is parsed from JSDoc `@throws` tags only. Detecting throws
// from AST flow is a static-analysis problem outside Phase 1's scope.
//
// `sideEffects` is a coarse heuristic, NOT a guarantee: looks for known
// patterns (db client method calls, fetch/axios/got calls, fs writes).
// Phase 3 may replace this with a proper effect inference pass.

import * as ts from "typescript";

import type { CodeTypeFact, ParamType, SideEffects, SymbolKind } from "./types.js";

const DB_CLIENT_NAMES = new Set([
  "db", "drizzle", "knex", "pg", "prisma", "supabase", "redis", "mongoose",
]);

const HTTP_CLIENT_NAMES = new Set([
  "fetch", "axios", "got", "ky", "request",
]);

const FS_WRITE_METHODS = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "unlink", "unlinkSync", "rename", "renameSync",
]);

export interface ExtractTypeFactsParams {
  declaration: ts.Declaration;
  checker: ts.TypeChecker;
  symbolFqn: string;
  symbolKind: SymbolKind;
}

export function extractTypeFacts(params: ExtractTypeFactsParams): CodeTypeFact | null {
  const { declaration, checker, symbolFqn, symbolKind } = params;

  // Type facts are meaningful for function-shaped declarations and types.
  // Plain `variable` rows skip this.
  const isFunctionLike =
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isConstructorDeclaration(declaration) ||
    ts.isGetAccessor(declaration) ||
    ts.isSetAccessor(declaration);

  if (!isFunctionLike) return null;

  const sig = checker.getSignatureFromDeclaration(declaration);
  const paramTypes: ParamType[] = sig
    ? sig.getParameters().map((p, idx) => paramFromSymbol(p, declaration, checker, idx))
    : [];

  const returnType = sig
    ? safeTypeToString(sig.getReturnType(), checker)
    : null;

  const genericParams = collectGenericParams(declaration);
  const throws = collectThrows(declaration);
  const sideEffects = inferSideEffects(declaration);

  // If everything is empty/null, drop the row — keeps the table sparse.
  if (
    paramTypes.length === 0 &&
    !returnType &&
    !genericParams &&
    !throws &&
    !sideEffects
  ) {
    return null;
  }

  return {
    symbolFqn,
    symbolKind,
    paramTypes: paramTypes.length > 0 ? paramTypes : null,
    returnType,
    genericParams,
    throws,
    sideEffects,
  };
}

function paramFromSymbol(
  symbol: ts.Symbol,
  enclosing: ts.Declaration,
  checker: ts.TypeChecker,
  index: number,
): ParamType {
  const valDecl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  let optional = false;
  let defaultValue: string | null = null;
  let typeStr = "any";
  let name = symbol.getName();

  if (valDecl && ts.isParameter(valDecl)) {
    optional = !!valDecl.questionToken || !!valDecl.initializer;
    if (valDecl.initializer) {
      defaultValue = valDecl.initializer.getText();
    }
    if (ts.isIdentifier(valDecl.name)) name = valDecl.name.text;
    const t = checker.getTypeOfSymbolAtLocation(symbol, enclosing);
    typeStr = safeTypeToString(t, checker) ?? "any";
  } else {
    const t = checker.getTypeOfSymbolAtLocation(symbol, enclosing);
    typeStr = safeTypeToString(t, checker) ?? "any";
  }

  if (!name || name === "__0") name = `arg${index}`;

  return { name, type: typeStr, optional, defaultValue };
}

function collectGenericParams(decl: ts.Declaration): string[] | null {
  const node = decl as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> };
  if (!node.typeParameters || node.typeParameters.length === 0) return null;
  return node.typeParameters.map((tp) => tp.getText());
}

function collectThrows(decl: ts.Declaration): string[] | null {
  const sf = decl.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.getFullText(), decl.getFullStart());
  if (!ranges) return null;
  const out = new Set<string>();
  for (const r of ranges) {
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const text = sf.getFullText().slice(r.pos, r.end);
    if (!text.startsWith("/**")) continue;
    const matches = text.matchAll(/@throws\s+(?:\{?([^}\s]+)\}?)?/g);
    for (const m of matches) {
      if (m[1]) out.add(m[1]);
    }
  }
  return out.size > 0 ? Array.from(out) : null;
}

function inferSideEffects(decl: ts.Declaration): SideEffects | null {
  if (!isFunctionWithBody(decl)) return null;
  const body = decl.body!;
  let readsDb = false;
  let writesDb = false;
  const callsExternal = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (HTTP_CLIENT_NAMES.has(callee.text)) callsExternal.add(callee.text);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const root = leftmostIdentifier(callee);
        const methodName = ts.isIdentifier(callee.name) ? callee.name.text : "";
        if (root) {
          if (DB_CLIENT_NAMES.has(root.text)) {
            if (/^(insert|update|delete|upsert|create|drop|truncate)/i.test(methodName)) {
              writesDb = true;
            } else {
              readsDb = true;
            }
          }
          if (HTTP_CLIENT_NAMES.has(root.text)) {
            callsExternal.add(root.text);
          }
        }
        if (FS_WRITE_METHODS.has(methodName)) {
          // Treat fs writes as an external side effect.
          callsExternal.add(`fs.${methodName}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);

  if (!readsDb && !writesDb && callsExternal.size === 0) return null;
  return {
    readsDb,
    writesDb,
    callsExternal: Array.from(callsExternal).sort(),
  };
}

function isFunctionWithBody(
  decl: ts.Declaration,
): decl is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return (
    (ts.isFunctionDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isConstructorDeclaration(decl) ||
      ts.isGetAccessor(decl) ||
      ts.isSetAccessor(decl)) &&
    !!decl.body
  );
}

function leftmostIdentifier(expr: ts.Expression): ts.Identifier | null {
  let cur: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? cur : null;
}

function safeTypeToString(t: ts.Type, checker: ts.TypeChecker): string | null {
  try {
    return checker.typeToString(
      t,
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType,
    );
  } catch {
    return null;
  }
}
