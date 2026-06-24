// FQN computation — IDENTICAL format to the TS extractor (Phase 1.1):
//
//   <file_path>::<owner_chain>
//
// `owner_chain` = dotted path from module scope to the symbol. For Python:
//
//   app/main.py::create_user
//   app/services/users.py::UserService.find_by_id
//   app/models.py::User.__init__
//
// Schema's UNIQUE(repo_id, fqn, kind) enforces declaration merging; we MUST NOT
// suffix FQNs to disambiguate.

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

/** Forward-slash a Windows path so FQNs are stable across OSes. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
