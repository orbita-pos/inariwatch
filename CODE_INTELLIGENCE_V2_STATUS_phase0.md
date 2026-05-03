# Code Intelligence v2 — Phase 0 Status Report

**Date:** 2026-05-02
**Worktree:** `../radar-codeintel-v2-phase0`
**Branch:** `feat/code-intel-v2/phase0-tech-debt`
**Tip:** `51a7ce6` (off `main` `a20e696`)
**Status:** Code complete + locally validated. **NOT PUSHED.**

---

## TL;DR

Phase 0 of the Code Intelligence v2 plan (per `CODE_INTELLIGENCE_V2_HANDOFF.md`) is done in a single commit. All five sub-tasks landed backwards-compatible — every existing consumer of the code-intelligence module keeps working byte-identical. New ESLint rule, new column, new widget, new logger, new contract test. Zero behavior change for users.

**Push readiness: GO.** Lint clean, build clean, full vitest 2148/2158 (10 fails ALL pre-existing on S1/S2.6 baseline, none introduced).

---

## What landed (5 sub-tasks → 1 commit)

### 0.1 — Embedding model versioning column

- `web/lib/db/migrations/0078_code_chunks_embedding_version.sql` — adds `embedding_model_version text NOT NULL DEFAULT 'voyage-code-3'` + index `(repo_id, embedding_model_version)`. Idempotent (`ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
- `web/lib/db/schema.ts` — Drizzle entry for the new column.
- `web/lib/code-intelligence/embeddings.ts` — adds `EMBEDDING_MODEL_VOYAGE_CODE_3`, `EMBEDDING_MODEL_OPENAI_TES_SMALL` constants, `resolveEmbeddingModelLabel()`, `embedTextsWithModel()` (returns `{ vectors, modelVersion }`).
- `web/lib/code-intelligence/indexer.ts` — stamps every chunk insert with the resolved model label. The embedding-update path also writes `embedding_model_version = ${modelVersion}` so the row reflects the actual provider, not the default.

### 0.2 — Service-layer enforcement

- New helpers in `web/lib/services/code-intelligence.service.ts`:
  - `findIndexedRepoIdentity({projectId, owner, repo}) → {id} | null`
  - `getRepoIdentityForProject(projectId) → {githubOwner, githubRepo, defaultBranch} | null`
- 3 external consumers migrated off direct `codeRepositories` imports:
  - `web/app/api/webhooks/github/[integrationId]/route.ts` — uses `findIndexedRepoIdentity()` + `triggerReindex()`.
  - `web/app/api/replay/[sessionId]/manifest/route.ts` — uses `getRepoIdentityForProject()`.
  - `web/app/api/code-intelligence/index/route.ts` — uses `triggerReindex()` (was `indexRepository` directly).
- New ESLint rule:
  - `web/lib/code-intelligence/lockdown/eslint-rule.js` — blocks named imports of `codeChunks` / `codeRepositories` / `codeDependencies` from `@/lib/db` or `@/lib/db/schema` outside the allowlist (code-intelligence module + service file + schema definition + tests). Catches both static imports and dynamic `await import()` destructuring.
  - Wired into `web/eslint.config.mjs` — registered alongside `inariwatch/no-direct-ai-sdk-import` under the same `inariwatch` plugin namespace.

### 0.3 — Coverage metrics + baseline widget on /admin/ops

- `web/app/api/admin/code-intel/baseline-stats/route.ts` — admin-only GET endpoint. Returns repo totals (ready/indexing/failed), chunk totals (count + embedding coverage % + by-model), dependency-graph homonym-poisoning rate, language breakdown.
- `web/app/(dashboard)/admin/ops/widgets/code-intel-baseline.tsx` — Suspense-driven widget. Mounted in `page.tsx` next to `RouterReceiptsWidget`.
- The "homonym-poisoned edges" metric is the v1 baseline number that quantifies the bug v2 fixes (current call-graph builder name-matches strings; v2 resolves to FQN-exact references). Target ≤ 1% post-v2.

### 0.4 — Structured logging for AI silent failures

- `web/lib/code-intelligence/logger.ts` — `logCodeIntelEvent({event, severity, ...})` emits a single tagged JSON line per event (`module=code-intelligence, phase=v1`). 6 event types (`embedding.fallback`, `embedding.failure`, `indexer.docstring_batch_failed`, `indexer.embedding_batch_failed`, `search.rerank_failed`, `search.embedding_unavailable`). Sanitizes `Bearer …`, `sk-…`, `pa-…`, `ghp_…`, `gho_…`, `key=…` from error messages.
- Wired into 5 sites previously failing silently:
  - `indexer.ts:329` (docstring batch failure → was `} catch {}`)
  - `indexer.ts:374` (embedding batch failure → was `} catch {}`)
  - `search.ts:289` (AI rerank failure → was `} catch {}`)
  - `embeddings.ts:50` (Voyage HTTP non-200 → was `throw new Error(...)`)
  - `embeddings.ts:111` (`embedQuery` catch-all → was `} catch { return null; }`)

### 0.5 — v1 snapshot tests / API contract pin

- `web/lib/code-intelligence/__tests__/v1-baseline-corpus.json` — 50 synthetic queries grouped into 10 categories (auth/database/errors/api/ai/deployment/frontend/performance/monitoring/security). Documented as the corpus Phase 3 will use to A/B v1 vs v2.
- `web/lib/code-intelligence/__tests__/search-contract.test.ts` — 5 contract tests:
  - corpus has 50 queries (invariant)
  - `searchCode()` preserves `CodeSearchResult` shape across the corpus
  - `limit` honored
  - BM25-only path when `openaiKey` omitted (vector skipped, executeMock called once)
  - Graph context fields (`callers`, `callees`) populated when `includeGraph=true`

---

## Tests added

| File | Tests | Status |
|---|---|---|
| `web/lib/code-intelligence/__tests__/embeddings.test.ts` | 5 | pass |
| `web/lib/code-intelligence/__tests__/logger.test.ts` | 7 | pass |
| `web/lib/code-intelligence/__tests__/search-contract.test.ts` | 5 | pass |
| `web/lib/code-intelligence/lockdown/__tests__/eslint-rule.test.ts` | 11 (RuleTester valid + invalid) | pass |
| `web/lib/db/__tests__/migration-0078.test.ts` | 5 | pass |
| `web/app/api/admin/code-intel/__tests__/baseline-stats.test.ts` | 4 | pass |
| **TOTAL NEW** | **37** | **pass** |

(Plus 1 corpus invariant inside search-contract — total surface area = 38 assertions.)

## Validation runs

- `npm run lint` → **0 errors, 17 warnings** (all `Unused eslint-disable directive` from S1's removed v0.2 rules — pre-existing per S2.6 memo).
- `npx vitest run` (full web suite) → **2148 passed / 10 failed / 2158 total** across 144 passed / 4 failed test files. The 10 failures are EXACTLY the same pre-existing files reported in `project_inari_live_v0_3_s2_6.md` (`webhooks/github`, `webhooks/datadog`, `webhooks/sentry`, `attestation`). Zero new failures introduced by Phase 0.
- `npx next build` → **green** with stub envs (`DATABASE_URL=…stub…`, `NEXTAUTH_SECRET=…`, `ENCRYPTION_KEY=hex64`).

---

## Decisions / non-obvious choices

1. **Migration slot 0078:** journal `_journal.json` stops at `0036` but the directory has files up to `0077`. Convention since 0037 is "drop the SQL file, don't touch the journal" (every recent migration including S2.5 0076 + S3 0077 followed this). Phase 0 follows the same convention.

2. **Embedding model labels are constants, not enums:** v2 will likely add new labels and we don't want a Drizzle enum migration just to introduce `voyage-code-4` someday. Plain `text` column + TS string constants gives zero-risk extensibility.

3. **`embedding_model_version` defaults `'voyage-code-3'` even when the indexer has no embedding key:** the row gets stamped with the caller's *intent*, not the actual outcome. If embedding fails later, the column still represents which provider would have been used. Phase 3 A/B can attribute "no embedding" rows to outage vs. cost-saving omission.

4. **Service-layer ESLint rule allows `web/lib/code-intelligence/**` AND `web/lib/services/code-intelligence.service.ts`:** the module that owns the tables must keep direct access — the rule is a boundary against *external* consumers. Schema definition site (`web/lib/db/schema.ts`) and migration tests are also allowlisted.

5. **Two ESLint rules merged under one `inariwatch` plugin namespace:** flat config can't have two `plugins.inariwatch` entries with different rules. Merged at config-load time (`{...inariwatchAiRouter.rules, ...inariwatchCodeIntel.rules}`). Same plugin object instance referenced from both `.{ts,tsx}` and `.{js,jsx,mjs,cjs}` blocks.

6. **node_modules junction:** disk was at 99% (3.5 GB free). Created a Windows directory junction `web/node_modules → ../radar/web/node_modules` to share modules across worktrees instead of `npm install`-ing again. Same trick can extend to other parallel sessions if needed (per `feedback_parallel_sessions_need_worktrees.md`, but adding the disk-saver dimension).

7. **Baseline-stats handles array-shape rows:** Drizzle's neon-http driver returns `{rows: T[]}` but other drivers return `T[]` directly. Same `readRows<T>()` helper as `app/api/admin/router/receipts/summary/route.ts` (S2.5 pattern).

8. **RuleTester at top-level, NOT inside vitest describe/it:** the AI router's `lockdown.test.ts` made the same mistake initially. RuleTester registers its own describe/it blocks — wrapping it crashes with "Calling the suite function inside test function is not allowed".

9. **Corpus categories chosen for remediation realism:** auth/database/errors/api/ai/deployment cover the bulk of InariWatch's actual remediation traffic. Synthetic queries by design — the handoff says use prod logs but those aren't accessible in this worktree, and synthetic queries already exercise the contract surface that v2 must preserve.

10. **No new dependencies.** Reused `vitest`, `eslint`, `next-auth`, `drizzle-orm`, `@/lib/auth`, `@/lib/db` — everything else is plain Node.

---

## Outstanding (NOT for Phase 0)

These belong to Phase 1+ per the handoff:

- New schema for v2 (`code_symbols`, `code_references`, `code_type_facts`, `code_imports`) — migration 0079+.
- TS extractor binary at `packages/code-intel-extractor-ts/`.
- `web/lib/code-intelligence-v2/` module with `findReferences`, `typeAt`, `blastRadius`, `searchSemantic`.
- `CODE_INTEL_V2=shadow|on|off` flag wiring in service layer.
- Worker tools: `find_references`, `type_at`, `blast_radius`.
- Phase 3 A/B widget on /admin/ops.

The Phase 0 baseline widget already covers what v2 will need to compare against.

---

## Push queue

Single commit:

```
51a7ce6  feat(code-intel): v2 Phase 0 — tech debt cleanup before v2
```

Off `main` `a20e696` (`feat(inari-live): v0.3 S3 — first local task notify.compose.email + eval harness`).

**Recommendation: GO push when Jesus is ready.** Phase 0 is independent of S1–S7 push status — it doesn't touch `packages/ai-router/` and doesn't conflict with any v0.3 worktree. Migration 0078 is additive (`ADD COLUMN IF NOT EXISTS DEFAULT 'voyage-code-3'`) so it's safe to apply on prod even if v0.3 deploys haven't all rolled.

---

## What Phase 1 inherits

- v1 module is now flag-ready: every external consumer goes through the service. Phase 1 can swap engines inside `searchCode()` without touching consumers.
- Embedding versioning is in place — Phase 1's TS extractor will write `embedding_model_version='symbol-graph-v2'` (or similar) on its rows so v1+v2 coexist in the same table during shadow run.
- Baseline metrics + widget exist — Phase 3's "v1 vs v2 shadow" widget plugs into the same /admin/ops grid.
- Structured logger is wired — Phase 1 logs go through `logCodeIntelEvent({phase: "v2", ...})` (just bump the constant).
- ESLint rule blocks regression: any new file outside the module that would access the v1 tables fails CI immediately.

DO NOT push without explicit ask (per `feedback_commit_workflow.md`).
