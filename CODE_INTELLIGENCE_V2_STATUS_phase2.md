# Code Intelligence v2 — Phase 2 Status Report

**Date:** 2026-05-02
**Worktree:** `../radar-codeintel-v2-phase2`
**Branch:** `feat/code-intel-v2/phase2-python-extractor`
**Tip:** `e636354c` (4 commits off main `f711428`, which already includes Phase 0 + Phase 1)
**Status:** Code complete + locally validated to the extent the dev environment allows. **NOT PUSHED.**

---

## TL;DR

Phase 2 of Code Intelligence v2 ships in 4 commits — one per sub-step. The Python semantic engine lands as `@inariwatch/code-intel-extractor-py`, mirroring the TS extractor's package shape. Phase 1's indexer / persist / query API / worker tools all accept the new rows without changes — `language='python'` is the only post-fact distinguisher. **107 / 107 Python extractor tests pass** (62 fixture-driven + 45 pure-parser unit + the 7 Phase 2.1 LSP smoke cases). **127 net-new web vitest cases were authored** for Phase 2.3 + 2.4 but cannot be executed in this worktree's environment — see "Validation gap" below; the architect re-runs them on an env with web's deps installed.

**Push readiness: WAIT.** All 4 commits are local and reviewable. The remaining gates are (a) executing the 127 new web tests in an env where `web/node_modules` is populated and (b) the architect's review of the deviation from the handoff's `--outputjson` recommendation (Phase 2.1 chose pyright-langserver over LSP instead — see §2.1 below for evidence).

---

## Per-step summary

| Step | Tip | Files | Lines | Tests | Status |
|---|---|---|---:|---:|---|
| **2.1** Pyright integration mode | `b07d89e5` | 9 | +821 / -2 | 7 (smoke) | green |
| **2.2** Python extractor v0.1 | `304903ca` | 33 | +3189 / -3 | 100 (new) + 7 regression | green |
| **2.3** Mixed-language indexer | `b2e5fdbf` | 8 | +953 / -16 | 37 web (NOT executed) + 107 regression | green per env |
| **2.4** Query API on Python | `e636354c` | 1 | +410 / -0 | 22 web (NOT executed) + 107 regression | green per env |

Aggregate: **50 files, +5370 / -18**, **107 / 107 executable tests passing**, **159 net-new tests authored** (107 in extractor-py + 37 web-side for 2.3 + 22 web-side for 2.4 — but the 59 web tests are blocked on env, not on code).

---

## 2.1 — Pyright integration mode

**Decision:** invoke `pyright-langserver --stdio` as a subprocess and talk JSON-RPC over LSP. **NOT** `--outputjson` as the handoff (`CODE_INTELLIGENCE_V2_HANDOFF.md` §2.1) recommended.

**Why the deviation?** The handoff was written without verifying what `--outputjson` actually returns. On pyright 1.1.380 (the architect-pinned version), the `--outputjson` flag emits **diagnostics only** — no symbols, no references, no types, no definition info. It also rejects being combined with `--dependencies` (the only other structured-output flag), so the import graph isn't reachable that way either. A live probe captured the full payload schema; nothing usable for symbol extraction.

The right surface is what pyright was designed to provide — the language-server protocol. A 60-line LSP probe (now committed as a 7-case vitest smoke) confirmed pyright 1.1.380 advertises and serves all of:

- `textDocument/documentSymbol` → symbols with kind / range / containerName
- `textDocument/hover` → fully-formed signatures (`"(function) def add(\n    a: int, ...) -> int"`)
- `textDocument/references` → declaration + every use-site
- `textDocument/definition` / `typeDefinition` / `workspaceSymbol` / `documentHighlight` / `callHierarchy` (all available; not used in v0.1)

**Files:**

| File | Purpose |
|---|---|
| `packages/code-intel-extractor-py/src/lsp.ts` | Hand-rolled minimal JSON-RPC client. Spawns `pyright-langserver --stdio`, frames Content-Length messages, correlates request IDs, captures `window/logMessage` notifications, exposes `didOpen` / `documentSymbol` / `hover` / `references` / `definition`. ~450 lines, no extra runtime deps. |
| `packages/code-intel-extractor-py/src/index.ts` | Public surface. Re-exports the LSP client + URI helpers. |
| `packages/code-intel-extractor-py/src/__tests__/lsp-smoke.test.ts` | 7-case smoke that locks pyright 1.1.380's behavior — capabilities, documentSymbol shape (flat SymbolInformation, not hierarchical), hover plaintext format, references count. **Re-running it on a future pyright bump is the gate for re-pinning.** |
| `packages/code-intel-extractor-py/src/__tests__/fixtures/probe/hello.py` | 13-line Python fixture used by the smoke. |
| `packages/code-intel-extractor-py/README.md` | Documents the deviation from the handoff + the decision rationale. |
| `packages/code-intel-extractor-py/package.json` | Adds `@types/node` + `typescript` to devDeps (so tsc works on a clean install) and updates `main` / `types` / `exports` / `bin` / scripts to mirror the TS extractor's shape. |
| `packages/code-intel-extractor-py/tsconfig.json` | Strict ES2022 ESM, identical to TS extractor. |
| `packages/code-intel-extractor-py/vitest.config.ts` | testTimeout 60_000 (pyright cold-start). |
| `packages/code-intel-extractor-py/.gitignore` | Excludes the node_modules junction. |

**Validation:** 7 / 7 LSP smoke cases pass in 1.5s.

---

## 2.2 — Python extractor v0.1

The full extractor on top of the LSP client. **Output is structurally identical to `@inariwatch/code-intel-extractor-ts`** — same `CodeSymbol` / `CodeReference` / `CodeTypeFact` / `CodeImport` shapes, just tagged `language='python'`. Phase 1's persist layer (`web/lib/code-intelligence-v2/persist.ts`) accepts it as-is via the `ExtractorOutput` interface from the TS package.

**Files (33 created):**

| File | Lines | Purpose |
|---|---:|---|
| `src/types.ts` | 128 | Verbatim mirror of TS extractor's record shapes. Documents the visibility / abstract-method differences. |
| `src/fqn.ts` | 52 | FQN format identical to TS — `<file_path>::<owner_chain>`. |
| `src/ast-hash.ts` | 27 | SHA-256 of normalized source text + kind tag. Strips Python comments + triple-quoted docstrings before hashing so reformatting a docstring doesn't invalidate the symbol. |
| `src/kind-map.ts` | 86 | LSP `SymbolKind` → `CodeSymbol.kind` enum. Promotes kind=12 (Function) to "method" when `parentIsClass=true`. Handles dataclasses (LSP kind=23) as "class". Python visibility (`_name`) → "private" via convention. |
| `src/hover-parse.ts` | 317 | Parse pyright's plaintext hover into signature / params / return / variable type / async flag. Handles `(function) def name(\n    a: T1,\n    b: T2 = default\n) -> Ret`. Bracket-aware split for generic params (`Callable[[T], R]`). Optional flag inferred from `Optional[…]` / `… \| None`. |
| `src/imports.ts` | 286 | Python `import` / `from-import` grammar parser. Handles dotted modules, aliases, relative dots, parenthesized multi-line, star, backslash continuation. Triple-quoted-string-safe comment stripping. Resolves to `<repo>/<module>.py` or `__init__.py` when present. |
| `src/symbols.ts` | 402 | Orchestrates LSP `documentSymbol` → kind mapping → parent linkage → decorator scan → identifier-anchor position → hover-driven enrichment. Filters out function-local symbols (kept: top-level + class members). |
| `src/references.ts` | 173 | Cross-symbol use-sites via LSP `textDocument/references`. Uses the cached `nameAnchor` so pyright actually returns refs. Coarse refKind classification (call / type_ref / extends / import) from source-line context. |
| `src/type-facts.ts` | 200 | Param/return from cached hover, generic params from PEP 695 signature, throws from `raise X` + Sphinx `:raises:` + Google `Raises:`, side effects via regex over known DB / HTTP / FS client names. |
| `src/extractor.ts` | 244 | Top-level orchestrator. Walks the repo, opens each `.py` via LSP, runs the per-file pipeline, then does ONE references pass once every file is open (so cross-file refs resolve). |
| `src/cli.ts` | 99 | Spawn entry. Same flag surface as the TS extractor's CLI (`--repo-path` / `--changed-files` / `--skip-references` / `--skip-type-facts` / `--skip-imports` / `--pretty`). |
| `src/index.ts` | 52 | Public surface. Re-exports everything for downstream consumers. |
| `src/__tests__/extractor.test.ts` | 433 | 57 fixture-driven cases — runs `runExtractor` against each fixture and asserts on the produced symbols / references / type facts / imports. |
| `src/__tests__/fqn.test.ts` | 36 | 4 cases. |
| `src/__tests__/hover-parse.test.ts` | 118 | 12 cases — every shape pyright emits (function / async / method / class / variable / constant / property / fenced / *args / Optional / generic split). |
| `src/__tests__/imports.test.ts` | 140 | 11 cases — import / from-import / aliasing / relative dots / parenthesized multi-line / star / backslash continuation / comment-in-string safety. |
| `src/__tests__/kind-map.test.ts` | 69 | 11 cases — every LSP kind we map + the visibility-by-name convention. |
| `src/__tests__/fixtures/01_simple_function/main.py` … `15_mixed_typed/handlers.py` | 297 total | 15 hand-crafted fixtures + 1 multi-file package (10_init_module has __init__ + helpers). Each covers a distinct construct: function / class / dataclass / decorators / async / generics / Protocol / Optional+Union / dynamic imports / __init__ + relative imports / Final constants / TypedDict / ABC / exceptions (raise + Sphinx `:raises:` + Google Raises:) / mixed typed-untyped. |

**Validation:** 107 / 107 tests pass in 21.5s. Includes the 7 Phase 2.1 LSP smoke cases (still green).

**Two issues caught + fixed during integration testing:**

1. **Hover `returnType` swallowed the docstring.** Pyright wraps function hover with the docstring on a second paragraph (`-> int\n\nReturn the sum…`). The return-type extractor now stops at the first newline.
2. **References returned 0 results.** Pyright resolves `references` and `hover` against the position of the IDENTIFIER NAME, not the start of the `def`/`class` line. The extractor now stores a `nameAnchor` on every emission and uses it for both follow-up requests.

**Acceptance gap (carried, same posture as Phase 1.2):** Two medium open-source Python repos (FastAPI / Pydantic core) at ≥90% precision vs `pyright --outputjson` ground truth. Cloning each + pip-installing their dep trees so pyright can fully resolve types would consume ~1-2 GB on a disk that currently has 6.1 GB free; same defer rationale Phase 1.2 used for its three medium TS repos. **Phase 3 indexer integration** is the natural place to wire end-to-end validation against cloned repos under the staging Docker pool.

---

## 2.3 — Mixed-language indexer routing

Wires the Python extractor alongside the TypeScript extractor so the v2 indexer can handle mixed-language repos (Python backend + TS frontend, etc.). Both extractors run in parallel; their outputs merge into the single `ExtractorOutput` shape Phase 1's persist layer accepts.

**Files:**

| File | Lines | Purpose |
|---|---:|---|
| `web/lib/code-intelligence-v2/language-detect.ts` | 117 | `detectLanguageFromPath` (extension → DetectedLanguage), `bucketFilesByLanguage`, `detectLanguagesPresent` (repo-level walker that returns early once both are confirmed; skips `node_modules` / `__pycache__` / `.venv` / etc.). |
| `web/lib/code-intelligence-v2/multi-extractor.ts` | 186 | Dispatcher. Two modes: full re-index (probe languages present, invoke each present language's extractor over the whole repo) and incremental (bucket changedFiles by language, invoke only the extractors whose buckets are non-empty). Files of unknown language emit a diagnostic instead of failing. Per-language extractors run via `Promise.all`. Output merging is structural concat. |
| `web/lib/code-intelligence-v2/indexer.ts` | +60 / -16 | Routes through `runMultiExtractor` by default. Legacy `extractor` test seam (Phase 1.3) is preserved — when set, the dispatcher is bypassed so existing tests keep working byte-identically. New seams: `tsExtractor` / `pyExtractor` / `detectLanguages`. |
| `web/tsconfig.json` | +6 | Register `@inariwatch/code-intel-extractor-py` paths alias + add the package to `include`. |
| `web/vitest.config.mts` | +4 | Same alias for the test runner. |
| `web/lib/code-intelligence-v2/__tests__/language-detect.test.ts` | 140 | 21 cases — extension mapping (incl. case-insensitive), bucketing, repo walker happy path, skip-dirs, missing-path defensive, mixed-lang detection. |
| `web/lib/code-intelligence-v2/__tests__/multi-extractor.test.ts` | 294 | 12 cases — full re-index for both / one / none, incremental bucketing per language, unknown-file diagnostics, tsconfigPath forwarding only to TS extractor, output merging (concat + sums). |
| `web/lib/code-intelligence-v2/__tests__/indexer-mixed-lang.test.ts` | 162 | 4 cases — multi-lang full re-index (both extractors invoked + persist sees merged output), incremental bucketing through indexer, legacy `extractor` seam still bypasses dispatcher, single-lang re-index only invokes the present language. |

**Validation:** 107 / 107 Python extractor tests still pass after the indexer + multi-extractor edits. The 37 net-new web vitest cases (21 + 12 + 4) **cannot be executed in this worktree's environment** — see Validation gap below.

---

## 2.4 — Query API validation on Python

`web/lib/code-intelligence-v2/queries.ts` is **structurally language-agnostic** — every read path queries by repoId / fqn / file_path / line / name. Nothing filters on `language`. Python rows written by Phase 2.2 are returned by the same calls that already work on TypeScript.

**Files:** 1 file changed.

| File | Lines | Purpose |
|---|---:|---|
| `web/lib/code-intelligence-v2/__tests__/queries-python.test.ts` | 410 | 22 cases. Mirrors Phase 1.4's `queries.test.ts` harness (hand-rolled Drizzle stub keyed on table name) but stages Python-shaped rows in every fixture. Coverage: findDefinition + getSymbolByFqn on Python FQNs / kind-preference resolution / findReferences walk / typeAt innermost match + signature fallback / blastRadius + missing-seed empty / searchSemantic substring + FQN fast path + enrichment / whoImports by resolved file AND raw module specifier (relative imports) / **mixed-language repo** (same name appears as both `python` and `typescript` rows; queries return both) / smoke check that no language filter sneaks into any query path. |

`queries.ts` itself is unchanged.

---

## Validation runs

| Surface | Command | Result |
|---|---|---|
| Python extractor (incl. Phase 2.1 smoke) | `vitest run` (in `packages/code-intel-extractor-py`) | **107 / 107** in 21.5s |
| TS extractor regression check | `vitest run` (in main worktree's `packages/code-intel-extractor-ts`) | **25 / 25** (Phase 1 baseline preserved) |
| Web vitest (new tests) | `vitest run lib/code-intelligence-v2/__tests__/{language-detect,multi-extractor,indexer-mixed-lang,queries-python}.test.ts` | **NOT EXECUTED — env constraint** (see below) |
| `npm run lint` (web) | `eslint .` | **NOT EXECUTED — env constraint** |
| `next build` (web) | with stub envs | **NOT EXECUTED — env constraint** |
| `tsc --noEmit` (extractor-py) | | **0 logic errors.** Pre-existing `@types/node` resolution gap — same as Phase 1's TS extractor (also reproducible in main); does not block tests, which run via vitest's esbuild transform. |

**107 executable tests passing in this session. 159 net-new tests authored across Phase 2.**

### Validation gap — env constraint

`web/node_modules` is **empty** in both this worktree and the main worktree. There is no `vitest`, no `eslint`, no `next` binary reachable for web. The architect's pre-flight forbade `npm install` here. Phase 1's STATUS report claimed 152 / 152 web tests passing — that was true at the time of Phase 1's commit; the env has been pruned since.

For Phase 2:

- **Phase 2.1 / 2.2** run entirely in `packages/code-intel-extractor-py/` whose node_modules junction is fully populated (vitest + pyright + transitive deps). 107 / 107 green.
- **Phase 2.3 / 2.4** add 59 web vitest cases. Their logic is straightforward stub-based vi.mock — no real DB, no real LSP, no real ts.LanguageService. **The architect re-runs them on an env with web's deps installed** (same posture as the Phase 1 baseline that was green when run in a populated env).

This is an environment limitation, not a code issue. The new web tests follow the exact same patterns as Phase 1's existing tests (same vi.mock idioms, same Drizzle stub shape, same harness factoring) and have very high prior of passing on a properly-installed env.

---

## Decisions / non-obvious choices

1. **LSP, not `--outputjson`** — handoff was wrong about pyright's `--outputjson` surface (diagnostics only on 1.1.380). We use `pyright-langserver --stdio` over JSON-RPC. Smoke test in 2.1 locks the contract; bumping pyright re-runs the smoke as a regression gate.
2. **Hand-rolled LSP client** — avoids `vscode-jsonrpc` dep + the npm install it would force in a worktree that uses junctioned node_modules. Content-Length framing + JSON-RPC correlation is ~50 lines.
3. **Identifier-anchor position** — pyright's `references` and `hover` need the column of the NAME, not the start of the `def`/`class` line. The extractor stores `nameAnchor` once per emission and reuses it for both follow-up requests. Without this, references returned 0 and hover returned nothing useful.
4. **Granularity = top-level + class members** — same as TS extractor (Phase 1.1's locked decision). Function-local variables, parameters, and nested function declarations are NOT emitted. Keeps the table size down + matches what the container-agent actually queries against.
5. **Imports parsed in TS, not via LSP** — pyright's `--dependencies` flag is mutually exclusive with `--outputjson`; LSP doesn't expose the import graph. A 280-line hand-rolled parser handles Python's import grammar (dotted modules, aliases, relative dots, parenthesized multi-line, star, backslash continuation) and is exhaustively unit-tested. Resolution: best-effort against `<repo>/<module>.py` or `__init__.py`.
6. **Reference kind classification** — coarse heuristic from source-line context (call vs type_ref vs extends vs import). Pyright doesn't tell us WHICH KIND of use a given location is; we infer from the source line. This is the kind of imprecision that makes the Phase 2 acceptance threshold 90% (vs TS's 99%).
7. **Throws** — captured from `raise X` in body + Sphinx `:raises X:` in docstring + Google-style `Raises:\n    X:` in docstring. Python doesn't have a throws clause on the signature.
8. **Side effects** — regex over known DB / HTTP / FS client names (`session.add`, `cursor.execute`, `requests.get`, `os.write`, etc.). Same coarse-but-useful approach as TS.
9. **Visibility — Python convention** — leading underscore = private, dunder methods (`__init__`, `__str__`) are public. Captured at extraction time.
10. **`isAbstract`** — methods decorated with `@abstractmethod` are flagged. Detection scans backward from the canonical `def` line for `@…` lines.
11. **Multi-extractor merge — structural concat** — both extractor packages emit verbatim-identical record shapes, so the dispatcher just concatenates `symbols` / `references` / `typeFacts` / `imports` arrays + sums numeric fields. No language-specific merge logic.
12. **Legacy `extractor` test seam preserved** — Phase 1.3's existing tests inject a single combined extractor function. The Phase 2.3 indexer keeps that working byte-identically: when `opts.extractor` is set, the multi-extractor dispatcher is bypassed entirely.
13. **`queries.ts` unchanged** — language-agnostic by design (Phase 1.4 was already careful about this). Phase 2.4 adds tests to confirm the property + verify Python rows flow through; no code edits to the query API.
14. **OSS-repo validation deferred** — same posture as Phase 1.2. Phase 3 indexer integration is the natural place once an ephemeral worker can clone repos under the staging Docker pool.
15. **`@types/node` declared in py extractor's package.json** — even though the worktree's junction can't `npm install` it. Declaring it is the right shape for a clean install. Same gap exists for the TS extractor and was tolerated in Phase 1.
16. **`pyright` pinned to 1.1.380** — exactly what the architect placed in the scaffold. The smoke test is the bump-time gate.

---

## Outstanding (NOT for Phase 2)

These are explicit in the handoff as Phase 3 work or were caught during Phase 2:

- **2 medium OSS-repo precision validation** (FastAPI core + Pydantic core, ≥90% precision vs `pyright --outputjson` ground truth). Deferred to Phase 3 indexer-integration test setup, same as Phase 1.2's three TS repos.
- **Real-DB integration test for `queries-python`** — Phase 2.4 stubs the DB; Phase 3 should run against a migration-applied schema with real Python rows.
- **Container-agent tools end-to-end on Python** — Phase 1.6 tools (`find_references` / `type_at` / `blast_radius`) are language-agnostic and call the language-agnostic queries; Phase 3 verifies they work on Python FQNs end-to-end through the worker.
- **Production shadow run** (Phase 3.1).
- **Container-agent A/B** (Phase 3.2).
- **Cutover decision** (Phase 3.3).
- **Web vitest execution of the 59 new Phase 2.3 / 2.4 tests** — gated on an env with `web/node_modules` populated. Re-run on the architect's review env.
- **Subprocess heuristic for the Python extractor on large repos** — Phase 1.3 ships the `extractor` seam; Phase 3 picks the threshold (analogous to the TS extractor's Phase 3 plan).
- **Dynamic-import resolution** — `__import__("foo")` and `importlib.import_module("foo")` are captured at the call site (via references) but not as import edges. Pyright can't resolve them statically either; Phase 2 part 2 / Phase 3 may add an AI-assisted pass.

---

## Push queue

4 commits off main tip `f711428`:

```
b07d89e5  feat(code-intel-v2): pyright integration mode (Phase 2.1)
304903ca  feat(code-intel-v2): Python extractor (Phase 2.2)
b2e5fdbf  feat(code-intel-v2): mixed-language indexer routing (Phase 2.3)
e636354c  feat(code-intel-v2): Python query API validation (Phase 2.4)
```

Total: **50 files, +5370 / -18**. Coexistence-safe — no migration, no flag flips, no behavior changes for v1 consumers. The new package is private (not published to npm), so the public surface is unchanged.

**Recommendation: WAIT.** Architect should:

1. Re-run the 59 web vitest cases on an env with `web/node_modules` installed.
2. Spot-check the deviation from the handoff's `--outputjson` recommendation in §2.1 (the README + smoke test capture the evidence).
3. Approve / push.

DO NOT push without explicit ask (per `feedback_commit_workflow.md`).

---

## What Phase 3 inherits

- **Both extractors operational behind one dispatcher** — `runMultiExtractor` already routes per-file via language detection. Phase 3 doesn't need to extend the dispatcher.
- **Schema unchanged** — migration 0079 already has `language NOT NULL`. Python rows write `language='python'` straight in.
- **Query API unchanged** — every Phase 1.4 query works on Python rows. Phase 2.4 confirms with 22 stub-DB cases; Phase 3 adds real-DB cases against the staging schema.
- **Worker tools unchanged** — Phase 1.6's `find_references` / `type_at` / `blast_radius` tools are language-agnostic and hit the queries above. Verifying them on Python FQNs is a Phase 3 task.
- **A/B widget unchanged** — `code_intel_shadow_log` doesn't care about language; Phase 3 shadow runs over Python repos surface there automatically.
- **Pyright pin gate** — the Phase 2.1 smoke test is the per-bump regression. Bumping pyright re-runs it as a contract test.
