# @inariwatch/code-intel-extractor-py

**Phase 2 of Code Intelligence v2** — see `CODE_INTELLIGENCE_V2_HANDOFF.md` and
`CODE_INTELLIGENCE_V2_STATUS_phase2.md` for context. Mirror of the Phase 1
TypeScript extractor (`@inariwatch/code-intel-extractor-ts`) but for Python.

Reads a Python repo and emits the same four record shapes that migration 0079
stores, tagged with `language='python'` so the schema, query API, and
container-agent tools work without changes:

- `CodeSymbol` — declarations (functions, classes, methods, types, exported vars)
- `CodeReference` — use-sites (calls, type refs, imports, base classes)
- `CodeTypeFact` — structured type info per symbol (params, return, throws, side effects)
- `CodeImport` — file→file import edges

Output is JSON to stdout by default — same contract as the TS extractor.

## Integration mode (locked in Phase 2.1)

The handoff (`CODE_INTELLIGENCE_V2_HANDOFF.md` §2.1) recommended invoking
pyright in `--outputjson` subprocess mode and parsing the structured output.
That recommendation **does not match what the flag actually returns**: as of
pyright 1.1.380, `--outputjson` emits a payload of the shape

```json
{
  "version": "1.1.380",
  "time": "...",
  "generalDiagnostics": [],
  "summary": { "filesAnalyzed": 1, "errorCount": 0, "warningCount": 0, ... }
}
```

i.e. **diagnostics only**. There is no `symbols`, `references`, `types`, or
`definitions` array in the output. Pyright also rejects combining `--outputjson`
with `--dependencies`, so the import-graph dump is not available either.

The right surface for symbols / references / types is the language-server
protocol — that is exactly what pyright was designed to provide via
`pyright-langserver --stdio`. The Phase 2.1 LSP probe (`src/lsp.ts` +
`src/__tests__/lsp-smoke.test.ts`) confirms pyright 1.1.380 advertises and
serves all of:

- `textDocument/documentSymbol` → declarations with kind / range / containerName
- `textDocument/hover` → fully-formed signatures (`"(function) def add(\n    a: int,\n    b: int\n) -> int"`)
- `textDocument/references` → declaration + every use-site
- `textDocument/definition`, `textDocument/typeDefinition`, `workspace/symbol`,
  `documentHighlight`, `callHierarchy` (available; not needed for v0.1)

So:

> **Phase 2.1 decision: invoke `pyright-langserver --stdio` as a subprocess and
> talk JSON-RPC over stdio.** `--outputjson` is reserved for surfaces that need
> only diagnostics (e.g., a future health widget on `/admin/ops`). The Phase 2.2
> extractor speaks LSP per-file via the `PyrightLspClient` in `src/lsp.ts`.

Pyright version is pinned to `1.1.380` in `package.json`. Bumping the pin is
gated on re-running the smoke test — the LSP capabilities and hover format are
stable across recent pyright minors but `documentSymbol` `kind` numbers and
`containerName` semantics are LSP-spec-driven and unlikely to drift.

### Why not embed pyright-internal as a library

The handoff explicitly forbade it (bundle weight + TS-on-TS coupling), and the
LSP path makes it unnecessary. We get all the semantic info via JSON-RPC
without owning pyright's internal API surface.

### Why not use Python's own `ast` module

Two reasons. First, it requires Python on the host running the extractor — the
TS extractor is self-contained, the Python extractor should be too. Second,
`ast` only gives us syntax, not types. Pyright gives us both.

## Usage

```bash
# Run the smoke test (Phase 2.1 deliverable)
npm test

# Phase 2.2: full extractor CLI (lands next commit)
node ./src/cli.ts --repo-path /tmp/some-clone
```

## FQN format

Same as the TS extractor:

```
<file_path>::<owner_chain>
```

Examples:

- `app/main.py::create_user`
- `app/main.py::UserService.find_by_id`
- `app/utils/dates.py::format_iso`

Owner chain follows source-level nesting (modules / classes / nested
functions). The extractor MUST NOT suffix FQNs to disambiguate; the
schema's `UNIQUE (repo_id, fqn, kind)` constraint encodes any merging,
same as TypeScript declaration merging.

## Granularity

Top-level + class members + dataclass fields. Local variables and nested
function-local symbols are NOT emitted. Same posture as the TS extractor.

## Hard rules

- Reuse pyright. Never reinvent type resolution.
- Skip `__pycache__` and `.venv` / `venv` / `env` directories for symbol
  extraction (still resolve imports from them when needed).
- No AI calls. The extractor is purely structural. Any AI features that
  consume extractor output go through `@inariwatch/ai-router`.
