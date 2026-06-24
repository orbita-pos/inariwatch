// Orchestrate symbol/reference/type-fact/import extraction across a repo.
// Two-pass design:
//   Pass 1: walk all source files, emit symbols, build the
//           ts.Symbol → FQN map used by Pass 2.
//   Pass 2: walk all source files again, emit references, type facts, imports.
//
// Two passes (rather than one) so that references can be resolved against
// the COMPLETE symbol catalogue. Without it, a forward reference (caller
// before callee in extraction order) would resolve to nothing.

import * as ts from "typescript";

import { extractImports } from "./imports.js";
import { createProgram, type ProgramHandle } from "./program.js";
import { extractReferences, type ReferenceTarget } from "./references.js";
import { extractSymbols, type SymbolEmission } from "./symbols.js";
import { extractTypeFacts } from "./type-facts.js";
import type {
  CodeImport,
  CodeReference,
  CodeSymbol,
  CodeTypeFact,
  ExtractorOptions,
  ExtractorOutput,
  SymbolKind,
} from "./types.js";

export async function runExtractor(
  options: ExtractorOptions,
): Promise<ExtractorOutput> {
  const t0 = Date.now();
  const handle = createProgram(options.repoPath, options.tsconfigPath);
  const wantedFiles = filterWanted(handle, options.changedFiles);

  const symbolToFqn = new Map<ts.Symbol, ReferenceTarget>();
  const declToOwnerFqn = new Map<ts.Node, ReferenceTarget>();
  const allEmissions: SymbolEmission[] = [];
  const symbols: CodeSymbol[] = [];
  const diagnostics: string[] = [];

  // Pass 1: symbols.
  for (const sf of wantedFiles) {
    const filePath = handle.toRelative(sf.fileName);
    const language = languageFor(sf);
    try {
      const emissions = extractSymbols({
        sourceFile: sf,
        checker: handle.checker,
        filePath,
        language,
      });
      for (const e of emissions) {
        const target: ReferenceTarget = { fqn: e.symbol.fqn, kind: e.symbol.kind };
        const symbol = handle.checker.getSymbolAtLocation(declName(e.declaration));
        if (symbol) symbolToFqn.set(symbol, target);
        declToOwnerFqn.set(e.declaration, target);
        symbols.push(e.symbol);
        allEmissions.push(e);
      }
    } catch (err) {
      diagnostics.push(`symbols: ${filePath}: ${(err as Error).message}`);
    }
  }

  // Refine parentKind on symbols by looking up the parent FQN in the catalogue.
  const fqnToKind = new Map<string, SymbolKind>();
  for (const s of symbols) {
    fqnToKind.set(`${s.fqn}::${s.kind}`, s.kind);
  }
  // We can't disambiguate the parent's kind cheaply (declaration merging
  // means a single FQN can map to multiple kinds). Best-effort: use the
  // first observed kind for each FQN.
  const fqnFirstKind = new Map<string, SymbolKind>();
  for (const s of symbols) {
    if (!fqnFirstKind.has(s.fqn)) fqnFirstKind.set(s.fqn, s.kind);
  }
  for (const s of symbols) {
    if (s.parentFqn) {
      const k = fqnFirstKind.get(s.parentFqn);
      if (k) s.parentKind = k;
    }
  }

  // Pass 2: references / type facts / imports.
  const references: CodeReference[] = [];
  const typeFacts: CodeTypeFact[] = [];
  const imports: CodeImport[] = [];

  const includeRefs = options.includeReferences !== false;
  const includeTypeFacts = options.includeTypeFacts !== false;
  const includeImports = options.includeImports !== false;

  if (includeRefs) {
    for (const sf of wantedFiles) {
      const filePath = handle.toRelative(sf.fileName);
      try {
        const refs = extractReferences({
          sourceFile: sf,
          checker: handle.checker,
          filePath,
          symbolToFqn,
          declToOwnerFqn,
        });
        references.push(...refs);
      } catch (err) {
        diagnostics.push(`refs: ${filePath}: ${(err as Error).message}`);
      }
    }
  }

  if (includeTypeFacts) {
    for (const e of allEmissions) {
      try {
        const fact = extractTypeFacts({
          declaration: e.declaration,
          checker: handle.checker,
          symbolFqn: e.symbol.fqn,
          symbolKind: e.symbol.kind,
        });
        if (fact) typeFacts.push(fact);
      } catch (err) {
        diagnostics.push(`type-facts: ${e.symbol.fqn}: ${(err as Error).message}`);
      }
    }
  }

  if (includeImports) {
    const resolveModule = makeResolver(handle);
    for (const sf of wantedFiles) {
      const filePath = handle.toRelative(sf.fileName);
      try {
        const imps = extractImports({
          sourceFile: sf,
          filePath,
          rootDir: handle.rootDir,
          resolveModule,
        });
        imports.push(...imps);
      } catch (err) {
        diagnostics.push(`imports: ${filePath}: ${(err as Error).message}`);
      }
    }
  }

  return {
    repoPath: handle.rootDir,
    symbols,
    references,
    typeFacts,
    imports,
    diagnostics,
    filesProcessed: wantedFiles.length,
    durationMs: Date.now() - t0,
  };
}

function filterWanted(
  handle: ProgramHandle,
  changedFiles: string[] | undefined,
): readonly ts.SourceFile[] {
  if (!changedFiles || changedFiles.length === 0) return handle.sourceFiles;
  const wanted = new Set(changedFiles.map((f) => handle.toRelative(f)));
  return handle.sourceFiles.filter((sf) => wanted.has(handle.toRelative(sf.fileName)));
}

function languageFor(sf: ts.SourceFile): string {
  const ext = sf.fileName.toLowerCase();
  if (ext.endsWith(".tsx")) return "tsx";
  if (ext.endsWith(".ts")) return "typescript";
  if (ext.endsWith(".jsx")) return "jsx";
  return "javascript";
}

function declName(decl: ts.Declaration): ts.Node {
  // Access the .name property if it exists; fall back to the declaration itself.
  // Most ts.Declaration subtypes have an optional `name` field.
  const named = decl as { name?: ts.Node };
  return named.name ?? decl;
}

function makeResolver(handle: ProgramHandle): (mod: string, from: string) => string | null {
  const compilerHost = ts.createCompilerHost(handle.program.getCompilerOptions());
  return (moduleName, containingFile) => {
    const result = ts.resolveModuleName(
      moduleName,
      containingFile,
      handle.program.getCompilerOptions(),
      compilerHost,
    );
    return result.resolvedModule?.resolvedFileName ?? null;
  };
}
