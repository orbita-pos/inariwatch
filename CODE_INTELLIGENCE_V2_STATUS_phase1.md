# Code Intelligence v2 — Phase 1 Status Report

**Date:** 2026-05-02
**Worktree:** `../radar-codeintel-v2-phase1`
**Branch:** `feat/code-intel-v2/phase1-ts-extractor`
**Tip:** `17c2253` (8 commits off Phase 0 tip `51a7ce6`)
**Status:** Code complete + locally validated end-to-end. **NOT PUSHED.**

---

## TL;DR

Phase 1 of Code Intelligence v2 ships in 8 commits — one per sub-step plus a constraint-fix amendment. Migration 0079 introduces the four semantic-graph tables, the TS extractor binary populates them, the indexer pipeline orchestrates extractions, the query API exposes the read surface, the service layer dispatches v1 vs v2 behind a flag (default off), the container-agent worker gains 3 new tools, and `/admin/ops` gets the A/B comparison widget. v1 stays byte-identical for every consumer until the flag flips. **193 tests pass** across web + worker + extractor.

**Push readiness: GO with one caveat** — Phase 0 (`51a7ce6`) has not been pushed yet, so Phase 1 chains on a not-yet-shipped predecessor. Phase 0 ships first, then Phase 1 immediately after (or a single push for both — Phase 0 is migration 0078 + ESLint rule + widget; both phases are coexistence-safe).

---

## Per-step summary

| Step | Tip | Files | Lines | Tests | Status |
|---|---|---|---:|---:|---|
| **1.1** Schema (migration 0079) | `43e8b1b` | 3 | +575 | 26 | green |
| **1.1-fix** UNIQUE(repo_id, fqn, kind) | `a353f12` | 3 | +25/-11 | 26 | green |
| **1.2** TS extractor binary | `9841ea4` | 33 | +2186 | 25 | green |
| **1.3** Indexer-v2 pipeline | `450b260` | 8 | +1041/-2 | 10 (new) + 27 (regression) | green |
| **1.4** Semantic query API | `681e962` | 2 | +663 | 14 (new) + 41 (regression) | green |
| **1.5** Service wiring + flag | `17ac115` | 13 | +869 | 18 (new) + 130 (regression) | green |
| **1.6** Worker tools + web HTTP | `87d2f86` | 9 | +937 | 12 (web) + 16 (worker) + 142 (regression) | green |
| **1.7** A/B widget on /admin/ops | `17c2253` | 4 | +346 | 5 (new) + 152 (regression) | green |

Aggregate: **75 files, +6651 / -10**, **193 tests passing** end-of-phase.

### 1.1 — Schema design (migration 0079)

| File | Purpose |
|---|---|
| `web/lib/db/migrations/0079_code_intel_v2.sql` | 4 tables (code_symbols / code_references / code_type_facts / code_imports) + indexes per the handoff. UNIQUE(repo_id, fqn, kind) per architect decision. All `CREATE … IF NOT EXISTS`. |
| `web/lib/db/schema.ts` (+122 lines) | Drizzle mirror with `parent_id` self-reference declared at SQL level only (sidesteps Drizzle's circular type-inference dance). |
| `web/lib/db/__tests__/migration-0079.test.ts` | 26 structural assertions (columns, indexes, FK cascades, the UNIQUE constraint, idempotency). |

### 1.1-fix — UNIQUE(repo_id, fqn, kind)

Architect resolved the declaration-merging question: tuple-with-kind, NOT FQN-suffixing. The schema accommodates TS declaration merging (interface + namespace + value sharing the same FQN) by making `kind` part of the uniqueness key. Extractor MUST NOT suffix.

### 1.2 — TS extractor binary (`packages/code-intel-extractor-ts/`)

New workspace package, same shape as `packages/ai-router/`:

| File | Lines | Purpose |
|---|---:|---|
| `package.json` | 24 | name + scripts + devDeps (typescript ^5.9.3, vitest ^4.1.5) |
| `tsconfig.json` | 16 | strict ES2022 ESM |
| `vitest.config.ts` | 9 | test runner config |
| `README.md` | 92 | usage + FQN format + granularity contract |
| `.gitignore` | 3 | excludes the node_modules junction |
| `src/types.ts` | 96 | record shapes (CodeSymbol / CodeReference / CodeTypeFact / CodeImport / ExtractorOutput / ExtractorOptions) |
| `src/fqn.ts` | 49 | FQN build / parse / normalize (locked format) |
| `src/ast-hash.ts` | 26 | SHA-256 of normalized AST node — incremental indexing key |
| `src/program.ts` | 116 | `ts.createProgram` builder; honors a tsconfig at the repo ROOT only (not parent dirs); skips node_modules / dist |
| `src/symbols.ts` | 234 | walker over `sourceFile.statements` → emits CodeSymbol records. Top-level + class/interface/namespace members only. Captures async/exported/static/abstract/visibility, signature, return type, JSDoc. |
| `src/references.ts` | 173 | walks identifiers → calls / type refs / extends / implements / imports / re-exports / JSX usages. Resolves via `getSymbolAtLocation` + `getAliasedSymbol`. |
| `src/imports.ts` | 124 | file→file edges with resolved paths. Handles default / named / namespace / aliased / `export *`. |
| `src/type-facts.ts` | 197 | param types, return type, generic params, `@throws` JSDoc, side-effect heuristic (db / http / fs writes). |
| `src/extractor.ts` | 175 | 2-pass orchestrator. Pass 1: symbols + ts.Symbol→FQN map. Pass 2: references / type facts / imports against the catalogue. |
| `src/index.ts` | 25 | public surface |
| `src/cli.ts` | 84 | spawn-as-subprocess entry. Flags: `--repo-path`, `--tsconfig`, `--changed-files`, `--skip-references` / `-type-facts` / `-imports`, `--pretty`. JSON to stdout. |
| `src/__tests__/extractor.test.ts` | 285 | 25 cases — 20 fixture-driven + 5 cross-cutting invariants |
| `src/__tests__/fixtures/01–20/` | 24 files | hand-crafted TS/TSX covering: simple function, class, interface, type alias, generics, decorators, JSX, enum, namespace, declaration merging, conditional types, imports, async + JSDoc throws, abstract, side-effects, extends+implements, getter/setter, re-exports, cross-file, mapped types |

### 1.3 — Indexer-v2 pipeline (`web/lib/code-intelligence-v2/`)

| File | Lines | Purpose |
|---|---:|---|
| `indexer.ts` | 145 | orchestrator. status → extract → persist → ready/failed. Streams progress events. Caller may inject a stub extractor (test seam); defaults to in-process `runExtractor`. |
| `persist.ts` | 271 | maps `ExtractorOutput` → migration 0079 tables. Idempotent via `ON CONFLICT (repo_id, fqn, kind)`. Two cleanup modes: full vs per-file. parent_id resolved in a 2nd pass once symbol IDs exist. |
| `__tests__/indexer.test.ts` | 174 | 5 cases (happy, incremental, extractor failure, persist failure, diagnostics) |
| `__tests__/persist.test.ts` | 333 | 5 cases (full ON CONFLICT, incremental clearedFilePaths, target-not-in-catalogue drop, clearRepoState ordering, clearFiles short-circuit) |
| `web/lib/services/code-intelligence.service.ts` (+50) | — | Adds `updateRepoIndexingStatus` + `markRepoIndexed` so the indexer doesn't bypass the lockdown rule. Phase 1.5 uses these too. |
| `web/lib/code-intelligence/logger.ts` (+5) | — | `phase: "v1" | "v2"` field added (default "v1"). Phase 1 logs go through `logCodeIntelEvent({phase: "v2", …})`. |
| `web/tsconfig.json` + `web/vitest.config.mts` | — | `@inariwatch/code-intel-extractor-ts` workspace alias to source. |

### 1.4 — Semantic query API (`web/lib/code-intelligence-v2/queries.ts`)

| Function | Returns | Index used |
|---|---|---|
| `findReferences(fqn, repoId, kind?)` | `CodeReference[]` | `idx_code_references_target` |
| `findDefinition(fqn, repoId, kind?)` | `CodeSymbol \| null` | `code_symbols_fqn_unique` |
| `typeAt(filePath, line, col, repoId)` | `{type, symbol} \| null` | `idx_code_symbols_repo_file` |
| `blastRadius(fqn, repoId, depth=2)` | `{symbols, depth}` | `idx_code_references_target` (BFS, capped at 5 hops) |
| `searchSemantic(query, repoId, opts)` | `SemanticSearchResult[]` | `idx_code_symbols_name` (ILIKE prefix + contains, ranked by name length) |
| `whoImports(modulePath, repoId)` | `CodeImport[]` | `idx_code_imports_target` |
| `getSymbolByFqn(fqn, repoId, kind?)` | `CodeSymbol \| null` | `code_symbols_fqn_unique` |

Declaration merging: queries that take an FQN without `kind` return the merged set. `findDefinition` picks the value-bearing kind via priority class > function > method > variable > interface > namespace > type > enum (matches IDE go-to-definition semantics).

`searchSemantic` has a fast-path: query containing `::` → exact FQN lookup. Optional `shallow=true` skips enrichment (callers/callees/typeFacts) for cheap latency.

Tests: 14 cases stub Drizzle via Symbol-keyed table-name probe (avoids JSON.stringify circular-ref crash on real PgTable objects).

### 1.5 — Service wiring + flag

`CODE_INTEL_V2 ∈ { off | shadow | on }`, default `off`. Resolver fails closed to `off` for typo protection.

| File | Purpose |
|---|---|
| `web/lib/code-intelligence-v2/flag.ts` | `resolveCodeIntelEngine` + `isCodeIntelEngineActive`. ctx accepts `workspaceId` / `projectId` for Phase 3 per-workspace overrides; ignored in Phase 1.5. |
| `web/lib/code-intelligence-v2/adapter.ts` | v2 `SemanticSearchResult` → v1 `CodeSearchResult`. Documents caveats: `code=""` (v2 doesn't store source), score = 1/(1+rank), kind→chunkType mapping. |
| `web/lib/services/code-intelligence.service.ts` | `searchCode` becomes engine-aware. `off` → only v1. `on` → v2 with transparent v1 fallback when no v2-ready repo. `shadow` → both run, v1 returned, comparison row written to `code_intel_shadow_log`. New exports: `firstReadyRepoForProject`, `getCodeIntelEngine`. |
| `web/lib/db/migrations/0080_code_intel_shadow_log.sql` | new table + 2 indexes (repo+created DESC, project+created DESC). |
| `web/lib/db/schema.ts` | `codeIntelShadowLog` Drizzle entry. |
| `web/lib/code-intelligence/lockdown/eslint-rule.js` | FORBIDDEN extended to v2 tables (`codeSymbols / codeReferences / codeTypeFacts / codeImports / codeIntelShadowLog`). Allowlist gains `web/lib/code-intelligence-v2/`. |

Tests: 18 new (flag + adapter + service-dispatch + migration-0080 + 5 v2 lockdown rule cases).

### 1.6 — Container-agent worker tools

| Layer | Files |
|---|---|
| **Worker** | `worker/src/tools/code-intel.ts` (3 tool defs + flag + executeCodeIntelTool with Bearer CRON_SECRET fetch + appendCodeIntelV2Tools composer). `worker/src/container-agent.ts` integrates via `buildToolsForTurn` and 3 new switch cases that load session.projectId from remediationSessions. `worker/vitest.config.ts` (vitest as runner; `npm test` still uses tsx + node:test). |
| **Web HTTP** | `web/app/api/code-intel-v2/{find-references,type-at,blast-radius}/route.ts` — POST, Bearer CRON_SECRET, accepts `{projectId, repoId?, …}`. `_shared.ts` reads CRON_SECRET at request time (test-friendly) and resolves repoId via the service layer. |

Flag: `CODE_INTEL_V2_TOOLS=on`, default off. Defense-in-depth: switch cases reject when flag is off even if the model fabricates a tool name.

Tests: 12 web (auth, validation, dispatch, 404, limit) + 16 worker (schema, gating, args, HTTP wiring, non-2xx propagation).

### 1.7 — A/B widget on `/admin/ops`

| File | Purpose |
|---|---|
| `web/app/api/admin/code-intel/shadow-stats/route.ts` | GET (admin-only). 24h aggregations over `code_intel_shadow_log`: total samples, p50/p95 per engine via `percentile_cont`, divergent calls + pct, empty-v2 calls, top 5 diverging queries. Tolerates `{rows:T[]}` and bare `T[]` driver shapes. |
| `web/app/(dashboard)/admin/ops/widgets/code-intel-shadow.tsx` | Suspense-driven widget. Color-codes divergence rate (≥30% rose, ≥10% amber) and v2 p95 vs v1 (≤v1 emerald, ≤1.5×v1 neutral, else amber). Empty state nudges operator to flip `CODE_INTEL_V2=shadow`. |
| `web/app/(dashboard)/admin/ops/page.tsx` | mounts the new widget next to `CodeIntelBaselineWidget`. |

Tests: 5 cases (auth rejection, unauth rejection, full payload, empty rows, neon-http `{rows}` shape).

---

## Validation runs (end of Phase 1)

| Surface | Command | Result |
|---|---|---|
| Web (v2 + Phase 0 + db + lockdown + api) | `vitest run lib/code-intelligence-v2 lib/code-intelligence lib/db app/api/code-intel-v2 app/api/admin/code-intel` | **152 / 152** |
| Worker | `vitest run --config worker/vitest.config.ts src/__tests__/code-intel-tools.test.ts` | **16 / 16** |
| Extractor | `vitest run --config packages/code-intel-extractor-ts/vitest.config.ts` | **25 / 25** |
| Lint | `npm run lint` (web) | 0 errors, 17 pre-existing warnings (unchanged from Phase 0 baseline) |
| Type-check | `tsc --noEmit` (extractor) | 0 errors |
| Build | `next build` (web, stub envs) | `✓ Compiled successfully` (junction-casing webpack warnings only — same as Phase 0) |

**193 v2-area tests passing.** Plus Phase 0's 51 (still green). Total 244 tests touched by Code Intelligence v2 across both phases.

---

## Decisions / non-obvious choices

1. **UNIQUE(repo_id, fqn, kind) — architect-resolved.** TypeScript declaration merging produces N rows that share an FQN but differ in kind (interface + namespace + value). Tuple-with-kind preserves `findReferences` semantics — callers query by FQN and naturally get the merged set. The extractor MUST NOT suffix FQNs to disambiguate. (Original Phase 1.1 schema had UNIQUE(repo_id, fqn); commit `a353f12` corrects.)

2. **`parent_id` ON DELETE CASCADE.** Handoff was silent; tightened so per-file cleanup (`DELETE … WHERE file_path = $1`) doesn't trip self-FK ordering. Matches `code_dependencies` precedent.

3. **Boolean cols `NOT NULL DEFAULT false`.** Handoff had nullable; tightened for clean two-valued logic. No insert-side behavior change.

4. **Granularity = top-level + class members.** Locked Phase 1.1, enforced by extractor (Phase 1.2). Keeps the tables ~10× smaller than naïvely indexing every block.

5. **Two-pass extractor.** Pass 1 builds the `ts.Symbol → FQN` map; Pass 2 resolves references against the COMPLETE catalogue. Without this a forward reference (caller before callee in extraction order) would resolve to nothing.

6. **`tsconfig.json` lookup at repo root only — not parent dirs.** Fixture directories inside the package would otherwise inherit the package's tsconfig, which excludes fixtures, leaving the program empty. Caught + fixed during Phase 1.2 testing.

7. **In-process extractor by default; subprocess available.** Phase 1.3 calls `runExtractor()` directly for simplicity. The CLI binary at `src/cli.ts` is the spawn entry — Phase 1.5+ heuristic flips to subprocess on memory-risk repos.

8. **Side-effect inference is heuristic.** `type-facts.ts` matches DB client names + HTTP client names + fs write methods. Not a guarantee. Phase 3 may replace with proper effect inference; for Phase 1 this gives container-agent prompts a coarse "this writes to db" signal that's better than nothing.

9. **`code` field always empty in v2 → v1 adapter.** v2 doesn't store source text on `code_symbols`. Container-agent uses search to find FQN → reads file via existing `read_file` tool. Documented in `adapter.ts` for any future surface that needs a snippet (must read via GitHub at render time).

10. **Fail-closed flag resolver.** Unknown `CODE_INTEL_V2` values default to `off` so a typo can't accidentally enable v2 in production.

11. **Shadow logging awaits the DB insert.** Phase 1.7 widget reads `code_intel_shadow_log`; rows must be observable on the next request tick. Trade ~5 ms latency in shadow mode for predictable widget data.

12. **`CRON_SECRET` read at request time** (Phase 1.6 `_shared.authorize`). Avoids module-load capture so test env mutations land. Same posture as `/api/replay/[sessionId]/analyze`.

13. **Per-workspace flag deferred to Phase 3.** `flag.ts` already accepts `workspaceId / projectId` ctx but ignores it in Phase 1.5. Once shadow data lands, per-workspace gating becomes useful — until then global env flag is enough.

14. **No new ESLint rule changes for v1.** The Phase 0 rule was extended (Phase 1.5) to cover v2 names; allowlist gained `web/lib/code-intelligence-v2/`. v1 surface untouched.

15. **Worker tests use vitest as runner in this worktree.** `npm test` uses `tsx --test` (Node native runner) per the worker's package.json; tsx isn't installed locally so vitest config provides an alternate path. Both APIs (`describe`, `it`) line up — only assert/expect differ. The test file uses a thin shim so the same source compiles under both. Production CI keeps tsx.

16. **node_modules junctions for shared deps.** This worktree has 3 junctions: `web/node_modules` → main worktree (Phase 0), `packages/code-intel-extractor-ts/node_modules` → `web/node_modules` (Phase 1.2), `worker/node_modules` → `web/node_modules` (Phase 1.6). All `.gitignore`d. Saves ~3 GB on a 99%-full disk per `feedback_parallel_sessions_need_worktrees.md`.

---

## Outstanding (NOT for Phase 1)

These are explicit in the handoff as Phase 2 / Phase 3 work:

- **Phase 1.2 acceptance gap (architect-acknowledged):** the 3 medium open-source repo full-extraction validations (Excalidraw / Linear / Next.js examples) AND `tsc --findAllReferences` ≥99% precision parity check. Disk constraint (3.5 GB free per `project_machine_constraints.md`) blocks cloning in this worktree. Phase 1.3 indexer integration is the natural place to wire end-to-end — once an ephemeral worker can clone repos under the staging Docker pool, the same harness covers the validation gap.
- **Per-workspace overrides** (`organizations.code_intel_v2_enabled`) — flag.ts already accepts `workspaceId / projectId` ctx; flip on at Phase 3 cutover.
- **Python extractor (`packages/code-intel-extractor-py/`)** — Phase 2.
- **Pyright integration mode** — Phase 2.1.
- **Production shadow run + container-agent A/B** — Phase 3.1 / 3.2.
- **Cutover decision** — Phase 3.3.
- **Subprocess heuristic for large repos** — flips `runExtractor` → CLI spawn when a repo would risk >4 GB. Phase 1.3 leaves the seam open (`opts.extractor`), Phase 3 picks the threshold.
- **Code text in v2 results** — currently `code: ""`. Surfaces that need snippets (dashboard search) read via GitHub. Phase 3 may add `code_text` column to `code_symbols` if a real consumer demands it.
- **Worker `repoId` plumbing** — `loadSessionContext` returns `repoId: null` and lets web resolve via projectId. When a session can deterministically pick a repo (e.g. multi-repo projects), wire `repoId` into the worker's `remediation_sessions` schema.

---

## Push queue

8 commits off Phase 0 tip:

```
43e8b1b  feat(code-intel): v2 Phase 1.1 — semantic graph schema (migration 0079)
a353f12  fix(code-intel-v2): UNIQUE on (repo_id, fqn, kind) for TS declaration merging
9841ea4  feat(code-intel-v2): TS extractor (Phase 1.2)
450b260  feat(code-intel-v2): indexer-v2 pipeline (Phase 1.3)
681e962  feat(code-intel-v2): semantic query API (Phase 1.4)
17ac115  feat(code-intel-v2): service wiring + flag (Phase 1.5)
87d2f86  feat(code-intel-v2): worker tools (Phase 1.6)
17c2253  feat(code-intel-v2): A/B widget (Phase 1.7)
```

Off Phase 0 tip `51a7ce6` (`feat(code-intel): v2 Phase 0 — tech debt cleanup before v2`). Phase 0 is queued first; Phase 1 chains directly on it. Both phases are coexistence-safe (additive migrations 0078 / 0079 / 0080, flag-gated paths default to v1 behavior, ESLint rule purely additive).

**Recommendation: GO push when Jesus is ready.** Once pushed, the rollout sequence is:

1. **Deploy** (no behavior change — `CODE_INTEL_V2=off` is the default).
2. **Index** a v2 repo: trigger `runIndexerV2()` against an existing `code_repositories` row (e.g. dogfooded InariWatch repo). Status flips `indexing → ready`.
3. **Flip to shadow** for a single workspace: `kamal env push CODE_INTEL_V2=shadow`. Watch `/admin/ops` widget for 24h. Look for: divergence < 30%, v2 p95 ≤ 1.5× v1 p95, no v2-side errors.
4. **(Phase 3)** Flip `CODE_INTEL_V2_TOOLS=on` for the worker. Container-agent gains the 3 new tools. Compare turns-to-success against v1.
5. **(Phase 3)** Flip `CODE_INTEL_V2=on` per workspace once shadow data is healthy. v1 stays as fallback for 60 days.

DO NOT push without explicit ask (per `feedback_commit_workflow.md`).

---

## What Phase 2 inherits

- The v2 schema is language-agnostic — Python extractor (`packages/code-intel-extractor-py/`) writes the same record shapes.
- The indexer-v2 pipeline already supports per-language routing — Phase 2 adds a language detector + delegates per file to TS or Py extractor.
- The query API is language-agnostic — `findReferences` / `typeAt` / `blastRadius` work on Python rows the moment the extractor writes them.
- Service-layer dispatcher uses the same flag — Phase 2 doesn't need to extend the engine selector.
- A/B widget already shows divergence + latency — Phase 2 just adds Python repos to the shadow run.
- Container-agent tools are language-agnostic — `find_references('app/main.py::create_user')` works the same as TS.

Phase 2 should be a ~1.5-month port (per the handoff) with most of the surface already in place. The bulk of work is the `pyright`-driven extractor binary itself.
