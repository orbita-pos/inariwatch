// Record shapes emitted by the extractor. These mirror the migration 0079
// table columns 1:1 — Phase 1.3 indexer maps them straight to Postgres rows
// without further transformation.
//
// Field nullability matches the SQL: anything optional in SQL is `string | null`
// or omitted in TS. Anything `NOT NULL DEFAULT false` is `boolean` (never
// undefined) so the indexer can insert without a coalesce.

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
  tsconfigPath?: string;
  language?: "ts" | "tsx";
  // When true, emit references/type facts/imports. Default true. Set false
  // for hot loops that only need the symbol catalogue.
  includeReferences?: boolean;
  includeTypeFacts?: boolean;
  includeImports?: boolean;
}
