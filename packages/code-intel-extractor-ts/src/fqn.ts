// FQN computation — locked-in format from Phase 1.1 architect decision.
//
//   <file_path>::<owner_chain>
//
// Where `owner_chain` is the dotted path from file scope to the symbol.
// For nested classes/namespaces, parents are joined by `.`.
//
// Declaration merging is NOT disambiguated here. Multiple rows can share an
// FQN and are distinguished by `kind` at the schema level (`UNIQUE (repo_id,
// fqn, kind)`). The extractor MUST NOT suffix FQNs.

const PATH_SEP = "::";
const OWNER_SEP = ".";

export function buildFqn(filePath: string, ownerChain: string[]): string {
  if (ownerChain.length === 0) {
    throw new Error(`buildFqn: empty owner chain for ${filePath}`);
  }
  return `${filePath}${PATH_SEP}${ownerChain.join(OWNER_SEP)}`;
}

export function fqnFile(fqn: string): string {
  const idx = fqn.indexOf(PATH_SEP);
  return idx === -1 ? fqn : fqn.slice(0, idx);
}

export function fqnOwnerChain(fqn: string): string[] {
  const idx = fqn.indexOf(PATH_SEP);
  if (idx === -1) return [];
  return fqn.slice(idx + PATH_SEP.length).split(OWNER_SEP);
}

export function fqnLeafName(fqn: string): string {
  const chain = fqnOwnerChain(fqn);
  return chain[chain.length - 1] ?? "";
}

export function fqnParent(fqn: string): string | null {
  const idx = fqn.indexOf(PATH_SEP);
  if (idx === -1) return null;
  const file = fqn.slice(0, idx);
  const chain = fqn.slice(idx + PATH_SEP.length).split(OWNER_SEP);
  if (chain.length <= 1) return null;
  return `${file}${PATH_SEP}${chain.slice(0, -1).join(OWNER_SEP)}`;
}

// Normalize a repo-relative path to forward slashes so FQNs are stable
// across Windows / POSIX checkouts. Phase 1.3 indexer also writes
// `file_path` columns through this helper.
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
