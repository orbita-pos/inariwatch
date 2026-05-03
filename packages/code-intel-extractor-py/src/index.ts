// Public surface of @inariwatch/code-intel-extractor-py.
//
// Phase 2.1 ships only the LSP client. Phase 2.2 layers on the extractor
// (symbols.ts, references.ts, type-facts.ts, imports.ts, extractor.ts).

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
