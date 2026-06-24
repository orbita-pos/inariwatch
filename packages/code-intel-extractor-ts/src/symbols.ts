// Walk a source file and emit CodeSymbol rows.
//
// Granularity (locked Phase 1.1): top-level + class members only. Local
// variables, function parameters, and block-scoped declarations are NOT
// emitted. Anything declared at file scope, plus members of classes /
// interfaces / namespaces / enums, qualifies.
//
// Owner chain (FQN dotted path) follows source-level nesting:
//   class A { method b() {} }              → A, A.b
//   namespace N { export class A {} }       → N, N.A
//   interface I { f(): void; }              → I, I.f

import * as ts from "typescript";

import { astHash } from "./ast-hash.js";
import { buildFqn, normalizePath } from "./fqn.js";
import type { CodeSymbol, SymbolKind, Visibility } from "./types.js";

export interface SymbolEmission {
  symbol: CodeSymbol;
  declaration: ts.Declaration;
}

export interface ExtractSymbolsParams {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  filePath: string;       // already repo-relative + forward-slashed
  language: string;       // "typescript" | "tsx" | "javascript"
}

export function extractSymbols(params: ExtractSymbolsParams): SymbolEmission[] {
  const { sourceFile, checker, filePath, language } = params;
  const out: SymbolEmission[] = [];

  walkStatements(sourceFile.statements, [], false);
  return out;

  function walkStatements(
    stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
    ownerChain: string[],
    inExportContext: boolean,
  ): void {
    for (const stmt of stmts) {
      visit(stmt, ownerChain, inExportContext);
    }
  }

  function visit(node: ts.Node, ownerChain: string[], inExportContext: boolean): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      emit(node, node.name.text, "function", ownerChain, isExported(node) || inExportContext);
      return;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const exported = isExported(node) || inExportContext;
      const next = [...ownerChain, node.name.text];
      emit(node, node.name.text, "class", ownerChain, exported);
      for (const member of node.members) {
        visitClassMember(member, next, exported);
      }
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      const exported = isExported(node) || inExportContext;
      const next = [...ownerChain, node.name.text];
      emit(node, node.name.text, "interface", ownerChain, exported);
      for (const member of node.members) {
        visitInterfaceMember(member, next, exported);
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      emit(node, node.name.text, "type", ownerChain, isExported(node) || inExportContext);
      return;
    }
    if (ts.isEnumDeclaration(node)) {
      const exported = isExported(node) || inExportContext;
      const next = [...ownerChain, node.name.text];
      emit(node, node.name.text, "enum", ownerChain, exported);
      for (const member of node.members) {
        const memberName = enumMemberName(member);
        if (memberName) {
          emitNamed(member, memberName, "variable", next, exported, /*isStatic*/ true);
        }
      }
      return;
    }
    if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const exported = isExported(node) || inExportContext;
      const next = [...ownerChain, node.name.text];
      emit(node, node.name.text, "namespace", ownerChain, exported);
      const body = node.body;
      if (body && ts.isModuleBlock(body)) {
        walkStatements(body.statements, next, exported);
      } else if (body && ts.isModuleDeclaration(body)) {
        // namespace A.B { … }
        visit(body, next, exported);
      }
      return;
    }
    if (ts.isVariableStatement(node)) {
      const exported = isExported(node) || inExportContext;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        emit(decl, decl.name.text, "variable", ownerChain, exported);
      }
      return;
    }
    // Re-export / export-from statements don't introduce new symbols themselves;
    // their use-sites are captured by references.ts.
  }

  function visitClassMember(
    member: ts.ClassElement,
    ownerChain: string[],
    classExported: boolean,
  ): void {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      emit(member, member.name.text, "method", ownerChain, classExported);
      return;
    }
    if (ts.isConstructorDeclaration(member)) {
      emit(member, "constructor", "method", ownerChain, classExported);
      return;
    }
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      emit(member, member.name.text, "variable", ownerChain, classExported);
      return;
    }
    if (
      (ts.isGetAccessor(member) || ts.isSetAccessor(member)) &&
      member.name &&
      ts.isIdentifier(member.name)
    ) {
      emit(member, member.name.text, "method", ownerChain, classExported);
      return;
    }
  }

  function visitInterfaceMember(
    member: ts.TypeElement,
    ownerChain: string[],
    interfaceExported: boolean,
  ): void {
    if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
      emit(member, member.name.text, "method", ownerChain, interfaceExported);
      return;
    }
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      emit(member, member.name.text, "variable", ownerChain, interfaceExported);
      return;
    }
  }

  function emit(
    node: ts.Declaration,
    name: string,
    kind: SymbolKind,
    ownerChain: string[],
    exported: boolean,
  ): void {
    emitNamed(node, name, kind, ownerChain, exported);
  }

  function emitNamed(
    node: ts.Declaration,
    name: string,
    kind: SymbolKind,
    ownerChain: string[],
    exported: boolean,
    forceStatic = false,
  ): void {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const fullChain = [...ownerChain, name];
    const fqn = buildFqn(filePath, fullChain);
    const parentChain = ownerChain;
    const parentFqn = parentChain.length > 0 ? buildFqn(filePath, parentChain) : null;

    const signature = computeSignature(node, checker);
    const returnType = computeReturnType(node, checker);

    const symbol: CodeSymbol = {
      fqn,
      kind,
      name,
      filePath: normalizePath(filePath),
      startLine: start.line + 1,
      endLine: end.line + 1,
      startCol: start.character,
      endCol: end.character,
      signature,
      returnType,
      isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
      isExported: exported,
      isStatic: forceStatic || hasModifier(node, ts.SyntaxKind.StaticKeyword),
      isAbstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
      visibility: computeVisibility(node),
      docComment: extractDocComment(node, sourceFile),
      parentFqn,
      parentKind: parentChain.length > 0 ? "class" : null, // refined later in extractor.ts
      language,
      astHash: astHash(node, sourceFile),
    };

    out.push({ symbol, declaration: node });
  }
}

function isExported(node: ts.HasModifiers): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return !!mods?.some((m) => m.kind === kind);
}

function computeVisibility(node: ts.Node): Visibility | null {
  if (!ts.canHaveModifiers(node)) return null;
  const mods = ts.getModifiers(node);
  if (!mods) return null;
  for (const m of mods) {
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return "private";
    if (m.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
    if (m.kind === ts.SyntaxKind.PublicKeyword) return "public";
  }
  return null;
}

function computeSignature(node: ts.Declaration, checker: ts.TypeChecker): string | null {
  // Function-like declarations: build "(...) => Return" string.
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    const sig = checker.getSignatureFromDeclaration(node);
    if (sig) {
      try {
        return checker.signatureToString(
          sig,
          node,
          ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType,
        );
      } catch {
        return null;
      }
    }
  }
  return null;
}

function computeReturnType(node: ts.Declaration, checker: ts.TypeChecker): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    const sig = checker.getSignatureFromDeclaration(node);
    if (sig) {
      try {
        return checker.typeToString(sig.getReturnType());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractDocComment(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const ranges = ts.getLeadingCommentRanges(sourceFile.getFullText(), node.getFullStart());
  if (!ranges) return null;
  const doc = ranges
    .filter((r) => r.kind === ts.SyntaxKind.MultiLineCommentTrivia)
    .map((r) => sourceFile.getFullText().slice(r.pos, r.end))
    .find((text) => text.startsWith("/**"));
  if (!doc) return null;
  return doc
    .replace(/^\/\*\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

function enumMemberName(member: ts.EnumMember): string | null {
  const name = member.name;
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}
