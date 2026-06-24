// Record shapes emitted by the Python extractor. STRUCTURALLY IDENTICAL to the
// TS extractor's `@inariwatch/code-intel-extractor-ts/src/types.ts` so the
// Phase 1.3 indexer + persist layer accept either source. The Phase 1
// reviewer locked the TS shapes; we mirror them verbatim here.
//
// Differences vs TS:
//   - `language` is always `"python"`
//   - `visibility` follows Python convention: leading-underscore names → "private",
//     everything else → null (Python has no formal access modifier)
//   - `isAbstract` is set when a method is decorated with `@abstractmethod` or
//     when a class explicitly inherits from `abc.ABC` / `abc.ABCMeta`
//   - JSX kinds (`jsx_use`) are unreachable but kept in the union so the indexer
//     stays language-agnostic

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "type"
  | "variable"
  | "interface"
  | "enum"
  | "namespace";

export type ReferenceKind =
  | "call"
  | "import"
  | "type_ref"
  | "extends"
  | "implements"
  | "re_export"
  | "jsx_use";

export type Visibility = "public" | "private" | "protected" | "internal";

export interface CodeSymbol {
  fqn: string;
  kind: SymbolKind;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  startCol: number | null;
  endCol: number | null;
  signature: string | null;
  returnType: string | null;
  isAsync: boolean;
  isExported: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  visibility: Visibility | null;
  docComment: string | null;
  parentFqn: string | null;
  parentKind: SymbolKind | null;
  language: string;
  astHash: string;
}

export interface CodeReference {
  sourceFqn: string | null;
  sourceKind: SymbolKind | null;
  targetFqn: string;
  targetKind: SymbolKind;
  filePath: string;
  line: number;
  col: number | null;
  kind: ReferenceKind;
}

export interface ParamType {
  name: string;
  type: string;
  optional: boolean;
  defaultValue: string | null;
}

export interface SideEffects {
  readsDb: boolean;
  writesDb: boolean;
  callsExternal: string[];
}

export interface CodeTypeFact {
  symbolFqn: string;
  symbolKind: SymbolKind;
  paramTypes: ParamType[] | null;
  returnType: string | null;
  genericParams: string[] | null;
  throws: string[] | null;
  sideEffects: SideEffects | null;
}

export interface ImportedName {
  local: string;
  original: string;
}

export interface CodeImport {
  sourceFile: string;
  targetModule: string;
  resolvedFile: string | null;
  importedNames: Array<string | ImportedName> | null;
}

export interface ExtractorOutput {
  repoPath: string;
  symbols: CodeSymbol[];
  references: CodeReference[];
  typeFacts: CodeTypeFact[];
  imports: CodeImport[];
  diagnostics: string[];
  filesProcessed: number;
  durationMs: number;
}

export interface ExtractorOptions {
  repoPath: string;
  changedFiles?: string[];
  includeReferences?: boolean;
  includeTypeFacts?: boolean;
  includeImports?: boolean;
  /**
   * When true (default), wait briefly after `didOpen` before issuing the first
   * `documentSymbol` request to give pyright time to bind the file. Set false
   * in tests that prepare the document differently.
   */
  warmupBeforeQuery?: boolean;
}
