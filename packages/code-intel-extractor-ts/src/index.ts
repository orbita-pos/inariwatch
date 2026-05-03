// Public surface for the TS extractor. The Phase 1.3 indexer pipeline imports
// from here; the CLI binary at ./cli.ts is the spawn-as-subprocess entry.

export { runExtractor } from "./extractor.js";
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
