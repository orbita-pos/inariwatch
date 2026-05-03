# Code Intelligence v2 — Implementation Handoff

**Audience:** fresh Claude Code session(s) with no prior context. Read this top-to-bottom before touching code.
**Reviewer:** the architect session (the one that produced this doc) reviews work as it lands.
**Generated:** 2026-05-02.

---

## TL;DR (read this first)

You are building **Code Intelligence v2 (Glean-style)** for InariWatch web cloud. It replaces the statistical retrieval (pgvector + BM25 + AI rerank) with a **semantic, exact symbol resolution engine** powered by language compilers/LSPs.

- **Scope:** web cloud only. NOT desktop. NOT SDK Intent Compiler. NOT CLI.
- **Languages, in order:** TypeScript first, Python second. Go/Rust/Java are out of scope (stay on v1 statistical).
- **Coexistence:** v2 ships behind a flag `CODE_INTEL_V2=shadow|on|off`, A/B against v1 for 2-3 months, then deprecate v1 for TS+Python.
- **Why now:** the container agent burns 22 turns avg (P99 = 40, timeout) exploring code because v1 returns probabilistic chunks. v2 returns exact references / types / blast radius — agent drops to ~6 turns avg, success rate up, $/fix down.
- **Estimated work:** 4.5 months of creative engineering with 3 senior engineers, assuming MAX reuse of existing infra (Postgres, BullMQ, tree-sitter, MCP tool surface, service layer, /admin/ops).

---

## Hard rules (read all before coding)

1. **Lockdown rule applies.** Any new AI call from v2 MUST go through `packages/ai-router/dispatch()`. Add new tasks to `packages/ai-router/src/tasks.ts` BEFORE calling — do NOT add raw OpenAI/Anthropic SDK imports outside `packages/ai-router/src/providers/`. See `INARI_AI_ARCHITECTURE.md` §6.
2. **Backward compatibility is mandatory.** Real users exist. v1 must keep working through every step. No big-bang cutover. Flag-gated A/B from day 1.
3. **Never push without explicit ask.** Per `feedback_commit_workflow.md`. Local commits OK in worktrees, push waits for Jesus.
4. **Always `next build` + `vitest` + `npm run lint` before declaring "done".** S1–S2.5 of v0.3 each shipped without running those locally and accumulated regressions that S2.6 had to clean up. Don't repeat that.
5. **Use git worktrees for parallel sessions.** Per `feedback_parallel_sessions_need_worktrees.md`. Never share the radar checkout across windows.
6. **Reuse existing infra. Do not build new infrastructure.**
   - Postgres + Neon + Drizzle (already deployed).
   - pgvector (already deployed, HNSW tuned).
   - BullMQ (already deployed, 3 queues).
   - Tree-sitter WASM (already deployed for 6 languages).
   - MCP tool surface (already in `web/app/api/mcp/tools/`).
   - Service layer (`web/lib/services/code-intelligence.service.ts`).
   - /admin/ops widgets (already live).

---

## Pre-work: parallelization rules

**v2 can run in parallel with remaining v0.3 sessions (S4/S5/S6+ of the AI Router).**
Reason: v2 lives in entirely new files/modules (see "Files to expect creating" below).
The only shared file is `packages/ai-router/src/tasks.ts` — and that file is
treated append-only, so concurrent additions merge cleanly.

**As of 2026-05-02 (Phase 0 commit `51a7ce6`):**
- S1, S2, S2.5, S2.6, S3, S6, Phase A → **all on `main`** (verified via `git log main`).
- Phase 0 tech-debt → on branch `feat/code-intel-v2/phase0-tech-debt` (NOT pushed yet).

**Branch v2 phases off either:**
- **Recommended:** Phase 0 branch (`feat/code-intel-v2/phase0-tech-debt`) — gives you the
  service layer enforcement + baseline widget + structured logger from day 1.
- Alternative: `main` directly — independent of Phase 0, but you'll need to rebase
  to consume the Phase 0 helpers later.

**Hard "do not touch" list while v2 phases run in parallel:**
- `packages/ai-router/src/dispatch.ts` — owned by router sessions
- `packages/ai-router/src/rules.ts` — owned by router sessions
- `packages/ai-router/src/providers/**` — owned by router sessions
- `web/lib/ai/client.ts` shim — owned by router sessions
- Anything under `desktop/src-tauri/src/notify_compose/` or `relay_client.rs` — owned by router sessions
- `capture/src/redact/**` — owned by router Phase 5
- `cli/` Rust crate — owned by router Phase 6

v2 only ADDS to `packages/ai-router/src/tasks.ts` (new `code.*` task entries).
Append at the end of the file in a new section, never reorder or modify
existing task entries.

---

## Architectural context: how v2 fits into the AI stack

```
Alert arrives → runRemediation() → context-gatherer.ts gathers:
   ├─ Sentry / Vercel / GitHub Issues  (existing)
   ├─ codeIntelV2.findReferences()      ← NEW: exact callers
   ├─ codeIntelV2.typeAt()              ← NEW: type at file:line:col
   ├─ codeIntelV2.blastRadius()         ← NEW: transitive deps
   ├─ codeIntelV2.searchSemantic()      ← NEW: same shape as v1.searchCode
   └─ pattern-memory.ts                 (existing — uses embeddings, NOT code search)
                ↓
   Container agent (worker/src/) gets PRECISE context (not probabilistic)
                ↓
   agent.tool("read_file") / .write_file / .grep / .exec   (existing tools)
   agent.tool("find_references") / .type_at / .blast_radius  ← NEW tools
                ↓
   When agent reasons → dispatch({ task: "code.fix", … })  ← router (existing)
                ↓
   Router picks cloud (Claude/GPT) — lockdown respected
```

**Key insight:** v2 is a NEW source of context. It does NOT replace the AI router. It does NOT replace the container agent. It REPLACES the statistical retrieval layer (search.ts + indexer.ts + parser.ts) with a semantic one.

---

## Coexistence model

```typescript
// web/lib/services/code-intelligence.service.ts (the single SSOT)
export async function searchCode(params: SearchParams): Promise<CodeSearchResult[]> {
  const engine = await getCodeIntelEngine(params.projectId);  // reads CODE_INTEL_V2 flag
  switch (engine) {
    case "v1":     return v1.searchCodeByProject(...);
    case "v2":     return v2.searchSemantic(...);
    case "shadow": {
      // Run BOTH, return v1 to caller, log v2 result for A/B comparison
      const [v1Result, v2Result] = await Promise.allSettled([v1.searchCodeByProject(...), v2.searchSemantic(...)]);
      logShadowComparison(params, v1Result, v2Result);
      return v1Result.status === "fulfilled" ? v1Result.value : [];
    }
  }
}
```

Every consumer (MCP tools, remediate.ts, etc.) keeps calling `searchCode()` from the service layer. Engine selection happens INSIDE the service.

---

## Phase 0 — Tech debt cleanup (2 weeks, 1 engineer)

**Goal:** make v1 ready to coexist with v2. Backward-compatible, ships independently of v2.

### 0.1 — Embedding model versioning column (1 day)
- Migration **0078** (verify slot, may be 0079+ depending on what landed): add `embedding_model_version text NOT NULL DEFAULT 'voyage-code-3'` to `code_chunks`.
- Update `embeddings.ts` to write the version on insert.
- Future migrations to a different model can backfill or coexist.

### 0.2 — Service layer enforcement (3-4 days)
- Audit `web/lib/code-intelligence/search.ts` and `indexer.ts` — they currently hit Drizzle directly. Move all DB access behind the service layer.
- Update `code-intelligence.service.ts` to be the ONLY path to `code_chunks` / `code_repositories` / `code_dependencies`.
- Add ESLint custom rule (similar style to `inariwatch/no-direct-ai-sdk-import`): `inariwatch/no-direct-code-intel-db` — blocks Drizzle imports of `codeChunks` / `codeRepositories` / `codeDependencies` outside the service.
- Test: existing 5 consumers (MCP tools, fix-replay, etc.) all still work.

### 0.3 — Coverage metrics + baseline widget on /admin/ops (2 days)
- Add `/api/admin/code-intel/baseline-stats` endpoint returning:
  - Total chunks indexed
  - % chunks with embeddings vs without
  - % `code_dependencies` edges where the source name is unique vs ambiguous (homonym-poisoned)
  - Avg P50/P95 query latency
  - Total searches/hour
- New widget in `/admin/ops` named "Code Intelligence Baseline (v1)". This is the BASELINE we measure v2 against.

### 0.4 — Structured logging for AI silent failures (1-2 days)
- Add structured logging to:
  - `indexer.ts:313` (AI docstring batch failures)
  - `search.ts:281` (AI rerank failures)
  - `embeddings.ts` (Voyage→OpenAI fallback events)
- All logs go to existing structured-log infrastructure. Tag with `module: "code-intelligence", phase: "v1"`.

### 0.5 — Snapshot tests on search.ts (2-3 days)
- Pick 50 representative queries from production logs (recent 90 days, anonymized).
- Run them via `searchCode()` and store results as JSON snapshots in `web/lib/code-intelligence/__tests__/v1-snapshots/`.
- These become the v1 regression test suite. v2 must NOT degrade these results in shadow mode.

**Phase 0 acceptance:**
- 0078 migration deployed.
- 0 direct DB queries to code_chunks outside service layer.
- /admin/ops shows v1 baseline widget.
- 50 v1 snapshot tests passing.
- Lint+build+tests green.
- Pushed to main (Jesus approval).

---

## Phase 1 — TypeScript semantic engine (2 months, 2 engineers)

**Goal:** v2 module that fully replaces v1 retrieval for TypeScript repos, behind flag.

### 1.1 — Schema design (1 week)

Migration **0079** (slot TBD):

```sql
-- Symbols: every named entity (function, class, method, type, variable, namespace, ...)
CREATE TABLE code_symbols (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       uuid NOT NULL REFERENCES code_repositories(id) ON DELETE CASCADE,
  fqn           text NOT NULL,           -- "src/auth/login.ts::validateUser"
  kind          text NOT NULL,           -- function | class | method | type | variable | interface | enum | namespace
  name          text NOT NULL,           -- "validateUser"
  file_path     text NOT NULL,
  start_line    int NOT NULL,
  end_line      int NOT NULL,
  start_col     int,
  end_col       int,
  signature     text,                    -- "(user: User) => Promise<Result>"
  return_type   text,                    -- "Promise<Result>"
  is_async      boolean DEFAULT false,
  is_exported   boolean DEFAULT false,
  is_static     boolean DEFAULT false,
  is_abstract   boolean DEFAULT false,
  visibility    text,                    -- public | private | protected | internal
  doc_comment   text,
  parent_id     uuid REFERENCES code_symbols(id),  -- containing class/namespace
  language      text NOT NULL,
  ast_hash      text NOT NULL,           -- for incremental: skip if hash same
  indexed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_symbols_fqn_unique UNIQUE (repo_id, fqn)
);
CREATE INDEX code_symbols_repo_kind ON code_symbols (repo_id, kind);
CREATE INDEX code_symbols_repo_file ON code_symbols (repo_id, file_path);
CREATE INDEX code_symbols_name      ON code_symbols (repo_id, name);

-- References: every USE site (call, import, type-reference, extends, implements)
CREATE TABLE code_references (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id             uuid NOT NULL REFERENCES code_repositories(id) ON DELETE CASCADE,
  source_symbol_id    uuid REFERENCES code_symbols(id) ON DELETE CASCADE,
  target_symbol_id    uuid NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
  file_path           text NOT NULL,
  line                int NOT NULL,
  col                 int,
  kind                text NOT NULL  -- call | import | type_ref | extends | implements | re_export | jsx_use
);
CREATE INDEX code_references_target  ON code_references (target_symbol_id);
CREATE INDEX code_references_source  ON code_references (source_symbol_id);
CREATE INDEX code_references_repo    ON code_references (repo_id);

-- Type facts: structured type info for symbols
CREATE TABLE code_type_facts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol_id       uuid NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
  param_types     jsonb,                  -- [{name, type, optional, default}]
  return_type     text,
  generic_params  jsonb,                  -- ["T", "U extends Base"]
  throws          jsonb,                  -- ["NotFoundError", "DBError"]
  side_effects    jsonb                   -- {reads_db: true, writes_db: false, calls_external: ["stripe"]}
);

-- Import edges: file-to-file import graph (used for incremental invalidation)
CREATE TABLE code_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         uuid NOT NULL REFERENCES code_repositories(id) ON DELETE CASCADE,
  source_file     text NOT NULL,
  target_module   text NOT NULL,           -- raw module specifier
  resolved_file   text,                    -- resolved absolute path within the repo (NULL if external)
  imported_names  jsonb                    -- ["validateUser", { local: "VU", original: "validateUser" }]
);
CREATE INDEX code_imports_source ON code_imports (repo_id, source_file);
CREATE INDEX code_imports_target ON code_imports (repo_id, resolved_file);
```

**Decisions to make explicit (document them in PR):**
- FQN format: `<file_path>::<class.method>` for methods, `<file_path>::<symbol>` for top-level. Document this scheme so consumers can reason about FQNs.
- Granularity: do you store EVERY local variable as a symbol, or only top-level + class members? Recommendation: **top-level + class members only**. Local vars are NOT symbols of interest for remediation context. Reduces table size by ~10×.
- Incremental key: `ast_hash` on each symbol. If the hash didn't change, skip re-extraction.

### 1.2 — TS Extractor binary (5-6 weeks)

**Location:** `packages/code-intel-extractor-ts/`. New workspace package, similar shape to `packages/ai-router/`.

**What it does:**
- Receives a path to a cloned repo + a list of changed files (or "all" for full re-index).
- Spawns `ts.LanguageService` against the repo's `tsconfig.json`.
- For each file, extracts all symbols via `ts.forEachChild` walk.
- For each symbol, captures: name, kind, FQN, signature (via `program.getTypeChecker().getSignatureFromDeclaration()`), JSDoc, type info.
- For each reference (`ts.findReferences`), captures the use-site.
- Writes everything to a JSON file (or directly to Postgres via env-injected DATABASE_URL).
- Reports progress to stdout (parsed by the orchestrating Node code).

**Critical implementation notes:**
- DO NOT reinvent type resolution. `ts.LanguageService` already does it. Use `program.getTypeChecker()` everywhere.
- Handle `ts.SymbolFlags.Alias` — `import { foo } from './bar'` is an alias; resolve to the original symbol.
- Handle declaration merging (interface + namespace with same name). Each declaration becomes a row, but they share FQN.
- Handle project references (TS monorepos with `references: [{ path: "../shared" }]` in tsconfig).
- Handle path aliases (`compilerOptions.paths`).
- Skip `node_modules` for symbol extraction (still resolve types from there for signatures).
- Memory limit: 4 GB max. If a repo would exceed it, fall back to per-file extraction (slower but bounded).

**Tests:**
- 20 hand-crafted small TS files covering: simple function, class with methods, interface, type alias, generic, decorator, JSX component, enum, namespace, declaration merging, conditional types, path alias.
- For each file, manually verify expected output (snapshot tests).
- Plus: 3 medium open-source repos (Excalidraw, Linear's open-source bits, Next.js's smallest example) — full extraction must complete in under 10 minutes each.
- Compare output against `tsc --findAllReferences` for 10 sample symbols per repo. Must match ≥99%.

### 1.3 — Indexer-v2 pipeline (1 week)

**Location:** `web/lib/code-intelligence-v2/indexer.ts`.

**Flow:**
1. Receive `IndexOptions` (same shape as v1).
2. Clone repo to a tmpdir (or read from existing checkout if container agent already has it).
3. Determine changed files since `last_indexed_commit` (reuse v1's git diff logic).
4. Spawn the TS extractor binary as a child process. Pipe DATABASE_URL via env.
5. Stream progress events to the orchestrator (BullMQ job).
6. On extractor success, mark `code_repositories.status = 'ready'` and update `last_indexed_commit`.
7. On extractor failure, write `error_message` and mark `failed`.

**Reuse:**
- Existing `code_repositories` table (rename optional `total_chunks` → `total_symbols` via migration, or add new column and keep both for v1/v2 coexistence).
- Existing BullMQ infrastructure.
- Existing rate limit (1 reindex per repo per 5 min).

### 1.4 — Query API (2 weeks)

**Location:** `web/lib/code-intelligence-v2/queries.ts`.

```typescript
export interface SemanticSearchOptions {
  limit?: number;
  fileFilter?: string[];
}

export interface SemanticSearchResult {
  symbol: CodeSymbol;          // full symbol record
  callers: CodeReference[];    // up to 10 references where target = this symbol
  callees: CodeReference[];    // up to 10 references where source = this symbol
  typeFacts: CodeTypeFacts | null;
}

// Top-level queries v2 must support:
export function findReferences(symbolFqn: string, repoId: string): Promise<CodeReference[]>
export function findDefinition(symbolFqn: string, repoId: string): Promise<CodeSymbol | null>
export function typeAt(filePath: string, line: number, col: number, repoId: string): Promise<{ type: string; symbol: CodeSymbol | null } | null>
export function blastRadius(symbolFqn: string, repoId: string, depth?: number): Promise<{ symbols: CodeSymbol[]; depth: number }>
export function searchSemantic(query: string, repoId: string, opts?: SemanticSearchOptions): Promise<SemanticSearchResult[]>
export function whoImports(modulePath: string, repoId: string): Promise<CodeImport[]>
export function getSymbolByFqn(fqn: string, repoId: string): Promise<CodeSymbol | null>
```

**Notes:**
- `searchSemantic` first does a fuzzy name match on `code_symbols.name` (BM25 over symbol names, NOT chunk content). Then enriches with references and type facts. NO embeddings in the primary path. Keep `embeddings.ts` as a SECONDARY path for "semantic similarity" queries that have no exact symbol match.
- All queries should hit Postgres directly via Drizzle. Target P95 < 50ms on a 100k-symbol repo.

### 1.5 — Service layer wiring + flag (3-4 days)

- Update `web/lib/services/code-intelligence.service.ts` to dispatch v1 vs v2 based on `CODE_INTEL_V2` env flag.
- Add `code_intel_v2_enabled` column to `organizations` (or reuse a workspace preferences mechanism). Default false.
- Add `taskOverrides`-style mechanism per workspace.

### 1.6 — Container agent tools (1 week)

**Location:** `worker/src/tools/`.

Add 3 new tools (in addition to existing read/write/grep/exec/submit_fix):
- `find_references(symbol_fqn)` — wraps `findReferences()`, returns JSON list of file:line.
- `type_at(file, line, col)` — wraps `typeAt()`.
- `blast_radius(symbol_fqn)` — wraps `blastRadius()` with depth=2 default.

Tool definitions in the worker's tool schema. Existing 6 tools unchanged.

### 1.7 — A/B harness on /admin/ops (3-4 days)

- New widget "Code Intelligence v1 vs v2 Shadow Run".
- Reads from `code_intel_shadow_log` table (created in this phase) populated by `searchCode()` when flag = "shadow".
- Shows: precision/recall delta, query latency p50/p95, top diverging queries.

**Phase 1 acceptance:**
- TS extractor binary passes 20 unit tests + 3 medium-repo full-extraction tests + ≥99% precision vs `tsc --findAllReferences`.
- Schema 0079 migration deployed.
- v2 module callable via `searchSemantic()` etc. on TS repos.
- Flag-gated. Default off. Shadow run for InariWatch's own dogfooded repo for 1 week.
- A/B widget shows v2 latency, divergence rate.
- Lint+build+tests green.
- Pushed (Jesus approval).

---

## Phase 2 — Python semantic engine (1.5 months, 1-2 engineers)

**Goal:** same as Phase 1 but for Python repos. Uses pyright as the type-resolver.

### 2.1 — Choose pyright integration mode (1 week)
**Recommended:** invoke pyright as a subprocess in `--outputjson` mode, parse the structured output. Avoid embedding pyright as a library (it's TS-based and adds bundling complexity).

### 2.2 — Python extractor binary (4-5 weeks)
**Location:** `packages/code-intel-extractor-py/`. Note: this binary is itself written in TypeScript — it just SPAWNS pyright. (Memory: even though TS extracts Python, this is fine because pyright IS TS, that's why pyright outputs the type info.)

Same output shape as TS extractor (writes to `code_symbols`, `code_references`, `code_type_facts`, `code_imports`).

**Caveats:**
- Python's type system is gradual. Many functions are untyped. Symbol extraction works regardless; type facts may be `null` for those.
- Handle dynamic imports (`__import__`, `importlib`) by best-effort string matching, mark `resolved_file = NULL`.
- Decorators (`@lru_cache`, `@property`, etc.) — capture as a flag on the symbol.

### 2.3 — Indexer pipeline integration (1 week)
- Detect language per file, route to TS or Py extractor.
- Handle mixed-language repos (e.g., Python backend + TS frontend) — both extractors run, both write to same tables tagged by language.

### 2.4 — Same query API works (queries are language-agnostic) (3-4 days)
- Validate `findReferences`, `typeAt`, `blastRadius` work on Python.
- Adjust precision threshold: 90% (Python is dynamically typed; cannot match 99%).

**Phase 2 acceptance:**
- Python extractor passes 15 unit tests + 2 medium open-source Python repos (e.g., FastAPI, Pydantic core) at ≥90% precision.
- Mixed-language repo (TS + Python) indexes correctly.
- Lint+build+tests green.
- Pushed.

---

## Phase 3 — A/B run + cutover decision (1 month)

**Goal:** prove v2 reduces remediation turns and is safe to make default.

### 3.1 — Production shadow run (2 weeks)
- Flag `CODE_INTEL_V2=shadow` for ALL workspaces.
- Every `searchCode()` call runs both v1 and v2. v1 result returned to caller. Both results logged.
- Daily report on /admin/ops: divergence %, top diverging queries, latency comparison.

### 3.2 — Container agent A/B (2 weeks)
- 50% of remediation sessions use v2 tools (find_references etc.); 50% use v1 chunks.
- Metric: turns until success/failure, success rate, $/fix.
- Required threshold to flip: v2 ≥30% turn reduction AND success rate ≥ v1.

### 3.3 — Cutover decision
- If thresholds met → flip default to v2 for TS+Python. v1 kept available as fallback for 60 days.
- If NOT met → freeze v2 in shadow, document gaps, plan Phase 4 fixes.
- If clearly broken → revert flag, post-mortem.

**Phase 3 acceptance:**
- 4 weeks of shadow + A/B data on /admin/ops.
- Cutover decision documented in `project_code_intel_v2_cutover.md`.
- If cutover happened: pushed default flip.

---

## Files to expect creating

```
packages/code-intel-extractor-ts/            (new workspace package)
  package.json
  tsconfig.json
  src/
    index.ts           # CLI entry
    extractor.ts       # uses ts.LanguageService
    symbols.ts         # AST → symbol records
    references.ts      # findReferences integration
    types.ts           # type facts extraction
    imports.ts         # import graph
  __tests__/
    fixtures/          # 20 hand-crafted TS files
    extractor.test.ts

packages/code-intel-extractor-py/            (new workspace package, similar shape)
  src/index.ts         # invokes pyright subprocess

web/lib/code-intelligence-v2/
  indexer.ts
  queries.ts
  service-shim.ts      # bridges to existing service layer
  __tests__/
    queries.test.ts

web/lib/db/migrations/
  0079_code_intel_v2.sql  # symbols, references, type_facts, imports tables
                          (verify slot — migrations may have advanced past 0078)

web/app/(dashboard)/admin/ops/widgets/
  code-intel-baseline.tsx       # Phase 0 widget
  code-intel-shadow.tsx         # Phase 3 A/B widget

worker/src/tools/
  find-references.ts
  type-at.ts
  blast-radius.ts

CODE_INTELLIGENCE_V2_HANDOFF.md           # this file
```

## Files to expect modifying

```
packages/ai-router/src/tasks.ts                    # add new tasks if v2 needs AI calls
web/lib/services/code-intelligence.service.ts      # flag-based v1/v2 dispatch
web/lib/code-intelligence/search.ts                # gain ESLint enforcement
web/lib/code-intelligence/indexer.ts               # gain ESLint enforcement
web/eslint.config.mjs                              # add new lint rule
web/lib/db/schema.ts                               # add new tables
worker/src/index.ts                                # register 3 new tools
web/app/api/mcp/tools/search-codebase.ts           # accept ?engine=v1|v2 param
```

---

## DO-NOT-TOUCH list

- `desktop/src-tauri/src/indexer/`           — Inari Live local indexer (Sistema B). Independent. Different model. Not part of v2.
- `capture/src/intent/`                       — SDK Intent Compiler. Hot path. Uses TS API directly. Not part of v2.
- `web/lib/services/intent-server-enrich.ts`  — Server-side regex fallback for intent. Stays until v2 stable.
- `web/lib/ai/security-scan.ts`               — ESLint + regex. Not part of v2.
- `web/lib/ai/risk-assessment.ts`             — Text analysis. Not part of v2.
- `web/lib/ai/prediction.ts`                  — Behavioral. Not part of v2.
- `cli/`                                      — Rust CLI. Not part of v2.
- `vscode/`                                   — VS Code extension. Not part of v2.
- `action/`                                   — GitHub Action. Not part of v2.
- All v0.3 S1–S7 branches                     — until merged to main, do not modify packages/ai-router.

---

## Per-session check-in protocol

The architect (the session that produced this doc) reviews each session's work after submission. To make review easy:

1. **Before starting a session:** create a worktree (`git worktree add ../radar-codeintel-v2-phaseN-stepM`) and a branch named `feat/code-intel-v2/phaseN-stepM-<short-description>`.
2. **At session end, write a status report file** at `radar/CODE_INTELLIGENCE_V2_STATUS_<phase>_<step>.md` with:
   - Branch name + tip SHA
   - What landed (file list, line counts)
   - Test results (counts: X/Y passing)
   - Build/lint status (green / errors)
   - Decisions / non-obvious choices
   - Outstanding items
   - "Push readiness: GO / WAIT / NO" recommendation
3. **NEVER push without explicit ask.** All commits stay local in the worktree.

The architect reviews the status report + diff, comments on issues, signs off (or not).

---

## Open questions to resolve in Phase 0 (do not block)

1. **Migration slot:** is the next free slot 0078, 0079, or higher? Check `web/lib/db/migrations/` at start of Phase 0. Multiple v0.3 sessions may have advanced the count.
2. **Workspace preferences vs env flag:** does Jesus prefer `CODE_INTEL_V2` as a global env (one-shot rollout) or per-workspace (gradual via `organizations.code_intel_v2_enabled`)? Recommended: per-workspace, same pattern as `localNotifyEnabled` (S3).
3. **Container agent tools rollout:** add new tools immediately on Phase 1, or wait until Phase 3 cutover? Recommended: add immediately, gate via flag (worker reads `CODE_INTEL_V2_TOOLS=on|off` env).
4. **Pyright version pinning:** lock to a specific pyright version. Add to `packages/code-intel-extractor-py/package.json`.

---

## Why this is NOT RCA-Net redux

`project_rca_net.md` killed RCA-Net because it needed 500+ outcome-labeled tuples to be useful, and only 2 existed. Code Intel v2 is the OPPOSITE:

- v2 needs only **access to the user's code via GitHub OAuth** (which you already have).
- v2 works the same with 1 user as with 100k users — it asks the language compiler, not the corpus of users.
- v2 can be validated via your own dogfooded repo + open-source repos (golden eval). No user data required.
- If v2 doesn't work, it'll be due to compiler edge cases, not "not enough users".

---

## Why we picked TS+Python and stopped there

Per audit:
- TS+Python likely cover ~60–70% of the repos InariWatch users connect (Next.js, Express, FastAPI, Flask are the biggest ICPs).
- Go/Rust/Java extractors are 2–2.5 months EACH because of compiler API complexity (traits, macros, generics, JVM bytecode). Diminishing returns until v1 statistical proves insufficient for those languages.
- v1 statistical fallback for Go/Rust/Java is acceptable. Container agent's read/grep tools + GitHub API explore those repos OK today. The pain point is TS+Python where we have HIGH volume + HIGH precision available via compiler.

If/when Go/Rust/Java volume grows enough to justify, Phase 4 adds them via SCIP (Sourcegraph protocol) — ~1 month each, less precision but graph-navigable.

---

## Final reminder

Read `CLAUDE.md` (root) and `INARI_AI_ARCHITECTURE.md` BEFORE writing code.

Read `feedback_commit_workflow.md`, `feedback_no_breaking_changes.md`, `feedback_parallel_sessions_need_worktrees.md`, `feedback_test_bundler_resolution.md` from memory.

Ask Jesus before pushing. Always.
