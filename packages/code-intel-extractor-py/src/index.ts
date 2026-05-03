// Public surface of @inariwatch/code-intel-extractor-py.

export {
  PyrightLspClient,
  pathToFileUri,
  fileUriToPath,
  resolveLangserverPath,
} from "./lsp.js";
export type {
  PyrightLspClientOptions,
  Position,
  Range,
  Location,
  SymbolInformation,
  DocumentSymbol,
  DocumentSymbolResult,
  Hover,
  MarkupContent,
  ServerLogMessage,
} from "./lsp.js";

export { runExtractor } from "./extractor.js";
export { extractSymbols, type SymbolEmission } from "./symbols.js";
export { extractReferences } from "./references.js";
export { extractImports } from "./imports.js";
export { extractTypeFacts } from "./type-facts.js";
export { parseHoverText, type ParsedHover } from "./hover-parse.js";
export { mapLspKind, visibilityFromName, type KindMapResult } from "./kind-map.js";
export { astHash } from "./ast-hash.js";
export {
  buildFqn,
  fqnFile,
  fqnLeafName,
  fqnOwnerChain,
  fqnParent,
  normalizePath,
} from "./fqn.js";

export type {
  CodeImport,
  CodeReference,
  CodeSymbol,
  CodeTypeFact,
  ExtractorOptions,
  ExtractorOutput,
  ImportedName,
  ParamType,
  ReferenceKind,
  SideEffects,
  SymbolKind,
  Visibility,
} from "./types.js";
