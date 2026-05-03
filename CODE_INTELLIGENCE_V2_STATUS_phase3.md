# Code Intelligence v2 — Phase 3 Status Report

**Date:** 2026-05-02
**Worktree:** `../radar-codeintel-v2-phase3`
**Branch:** `feat/code-intel-v2/phase3-shadow-ab-cutover`
**Tip:** `96555dc3` (3 commits off `6b505899` = origin/main)
**Status:** Code complete + locally validated end-to-end. **NOT PUSHED.**

---

## TL;DR

Phase 3 of Code Intelligence v2 ships in **3 commits** — one per sub-step.
Phase 1.5 already ran both engines on every shadow call; Phase 3 layers on
the operator knobs (sampling rate, kill switch, per-workspace override),
the timeout guard, the container-agent A/B telemetry, and the cutover
decision tooling (script + endpoint + /admin/ops widget). Everything is
flag-gated and additive — `CODE_INTEL_V2=off` (default) and
`CONTAINER_AGENT_AB_PCT=0` (default) keep production byte-identical.

**Push readiness: GO with one note.** All three commits sit cleanly on top
of origin/main (the upstream tip moved while Phase 3 was in flight, and
the work was cherry-picked onto the new base). Migration slots had to
shuffle by 1 because v0.3 S5 took 0081 (`workspace_local_voice`) ahead of
us — see "Migration renumbering" below. **286/286 web tests + 51/51
worker tests passing.** Lint clean, `next build` green with stub envs.

---

## Per-step summary

| Step | Tip | Files | Lines | Tests | Status |
|---|---|---|---:|---:|---|
| **3.1** Shadow harness + sampling | `b3142ae0` | 8 | +1093 / -28 | 38 (new) + 4 (regression carry) | green |
| **3.2** Container-agent A/B | `1b1a71a4` | 13 | +1299 / -26 | 27 (new) + 16 (regression carry) | green |
| **3.3** Cutover decision tooling | `96555dc3` | 9 | +1047 / -0 | 23 (new) | green |

Aggregate across Phase 3: **30 files touched, +3439 / -54**, **88 net-new
tests**, **286/286 web + 51/51 worker passing** end-of-phase.

---

## 3.1 — Shadow harness + sampling controls

Phase 1.5 already ran both engines on every shadow call. Phase 3.1 adds the
ramp-up + kill controls + the timeout guard so an operator can dial shadow
up/down without redeploying and abandons a slow v2 attempt without making
the caller wait.

### Migration

`web/lib/db/migrations/0082_code_intel_v2_shadow_controls.sql` —
**renumbered from 0081 during integration** (see §Migration renumbering).
Two additive ALTERs, both idempotent, both default to "no opinion":

| Table | Column | Type | Default |
|---|---|---|---|
| `organizations` | `code_intel_v2_shadow_pct` | `integer NULL CHECK 0..100` | `NULL` (= inherit env) |
| `code_intel_shadow_log` | `v2_timed_out` | `boolean NOT NULL` | `false` |

### Sampling module

`web/lib/code-intelligence-v2/sampling.ts` (147 lines):

- `isShadowKilled()` — env-only `CODE_INTEL_V2_KILL_SHADOW=1`. Cheap,
  zero I/O, checked first in the dispatcher.
- `resolveGlobalShadowRate()` — `SHADOW_SAMPLE_RATE` env, clamped to
  `[0, 1]`, defaults to `1.0` (= always shadow when flag is `shadow`).
- `getWorkspaceShadowPct(projectId)` — DB lookup over
  `projects -> organizations` (two simple queries instead of a JOIN so
  test stubs don't need to model `innerJoin`).
- `shouldShadowSample(projectId, deps?)` — composes kill switch + per-
  workspace override + global rate, rolls a uniform `[0,1)` random against
  the resolved rate. Test seam via `deps`.
- `v2AdditionalBudgetMs(v1Ms)` — `Math.max(v1Ms, MIN_V2_BUDGET_MS)`. After
  v1 finishes, this is the additional time v2 gets before the slow guard
  trips. Default floor `100ms` so a fast v1 doesn't immediately starve v2.

### Service refactor

`web/lib/services/code-intelligence.service.ts` shadow branch becomes:

1. Kill switch check → if killed, fall through to v1.
2. `shouldShadowSample(projectId)` → if false, fall through to v1.
3. Run both engines in parallel. v2 wrapped so its rejection can never
   leak after timeout (caught and stored on `v2Outcome.error`).
4. Await v1.
5. Race v2 against `v2AdditionalBudgetMs(v1Ms)` via the local
   `raceWithTimeout(p, ms): Promise<boolean>` helper.
6. v2 finished within budget → log full sample with `v2TimedOut: false`.
7. v2 missed budget → log slow sample with `v2TimedOut: true`,
   `v2Error: "v2_slow: budget=Xms exceeded"`, fire-and-forget the
   straggler v2 promise with `.catch(() => undefined)` so a late
   rejection never surfaces as an unhandled rejection.
8. v1 is still the source of truth — if it threw, re-throw.

### Seed script

`web/scripts/seed-shadow-run.ts` — dispatches the Phase 0.5 baseline
corpus (50 queries) through `searchCode()` so the /admin/ops widget +
cutover dashboard light up on day 1 without waiting for organic traffic.
Asserts `CODE_INTEL_V2=shadow` before writing — fail-fast for operators.
Flags: `--project <uuid> [--limit N] [--dry-run]`.

### Tests (38 new)

| File | Cases | Coverage |
|---|---:|---|
| `sampling.test.ts` | 17 | kill switch (3) / global rate (4) / min v2 budget (3) / dice + workspace pct (5) / 1000-trial distribution (1) / v2AdditionalBudgetMs (1) |
| `service-shadow-controls.test.ts` | 9 | kill switch (2) / sampling on/off interleave (2) / timeout-passes (1) / timeout-trips with `v2TimedOut=true` (1) / v2-throws-in-budget (1) / budget callback uses v1Ms (1) / kill switch off (1) |
| `migration-0082.test.ts` | 8 | each ALTER + CHECK + IF NOT EXISTS + comments + rollback + non-mutation invariants |
| `service-dispatch.test.ts` (Phase 1.5) | 4 | regression — still green after the refactor |

**Distribution test:** rate=0.5 over 1000 trials lands in [0.4, 0.6] —
deterministic via a seeded LCG, never flakes.

---

## 3.2 — Container-agent A/B telemetry

Routes each remediation into one of two tool sets:

- **v1**: existing `read_file` / `search_code` / `list_directory`
- **v2**: same as v1 PLUS Phase 1.6's `find_references` / `type_at` /
  `blast_radius`

Decision is **sticky per session** (FNV-1a hash of `sessionId`) so the
same alert never sees both engines mid-flight, which would corrupt the
experiment.

### Migration

`web/lib/db/migrations/0083_code_intel_remediation_ab.sql` —
**renumbered from 0082 during integration** (see §Migration renumbering).

`code_intel_remediation_ab` table: 13 columns. `alert_id` NOT NULL FK
cascades on alert delete; `remediation_session_id` FK SET NULL on session
delete; `engine` TEXT with CHECK IN ('v1','v2') (no pg ENUM so adding
"v3" later is a no-op); `cost_usd` numeric(12,6) NULLABLE (worker writes
NULL today — Phase 3.4 may backfill from `ai_usage_logs`); `workspace_pct`
captured at decision time for audit. 3 indexes (alert / engine+created /
session). Plus an additive `organizations.code_intel_v2_agent_ab_pct`
column with the same NULLABLE 0..100 CHECK pattern as 3.1's column.

### Worker A/B router

`worker/src/tools/code-intel-ab.ts` (159 lines):

- `isAgentAbKilled()` — env `CONTAINER_AGENT_AB_KILL_V2=1` forces all
  sessions to v1 instantly. No DB lookup; defense first.
- `resolveGlobalAgentAbPct()` — `CONTAINER_AGENT_AB_PCT` env, clamped to
  `[0, 100]`, defaults to `0` (= all v1).
- `getWorkspaceAgentAbPct(projectId)` — DB lookup over
  `projects -> organizations`. Errors swallowed → fall back to env.
- `stickyDice(sessionId)` — FNV-1a 32-bit hash modulo 100. Deterministic,
  no `Math.random`. Same `sessionId` always yields the same number.
- `resolveAgentEngine({sessionId, projectId, workspaceLookup?})` — top-
  level resolver. Returns `{engine, workspacePct, source}` where source ∈
  `kill | workspace | global | default`.

### Telemetry writer

`worker/src/tools/code-intel-ab-telemetry.ts` (76 lines):

- `writeAbTelemetry(row)` — inserts one row to `code_intel_remediation_ab`.
- Falls back to looking up `alert_id` from `remediation_sessions` when
  caller passes null.
- Skips the row if no `alert_id` can be resolved (instead of failing the
  remediation on the NOT NULL FK).
- Swallows DB errors silently — Neon hiccup must NEVER abort a remediation.
- Clamps `failure_reason` to 500 chars at insert time.

### Container-agent integration

`worker/src/container-agent.ts`:

- `loadSessionContext` extended to read `alertId` (used by telemetry).
- `buildToolsForTurn(turn, agentEngine?)` — `engine` forces v2 tools on
  or off regardless of the `CODE_INTEL_V2_TOOLS` env. Undefined keeps
  the Phase 1.6 behavior (env decides).
- `executeContainerTool` ctx carries `agentEngine` for defense-in-depth
  in the `find_references` / `type_at` / `blast_radius` cases.
- `runAgentJob` resolves the engine ONCE at the top of the function
  (sticky for the whole loop), wraps the body in try/catch to capture
  the failure reason, writes the telemetry row in the finally block.
  Existing pool-return / container-destroy logic preserved.

### Worker schema additions

`worker/src/db.ts`:

- `remediationSessions` gains `alertId` + `projectId` (the latter was
  already referenced by Phase 1.6 code at line 395 but not declared in
  the worker schema — incidental fix, blame-confirmed pre-existing).
- New `organizations` + `codeIntelRemediationAb` subsets matching the
  web-side schema.

### ESLint rule

`web/lib/code-intelligence/lockdown/eslint-rule.js`:

- `codeIntelRemediationAb` added to FORBIDDEN list.
- `web/app/api/admin/code-intel/**` + `web/scripts/code-intel-v2-*` +
  `web/scripts/seed-shadow-run.ts` pre-allowlisted for the Phase 3.3
  cutover surface.

### Tests (27 new)

| File | Cases | Coverage |
|---|---:|---|
| `worker/code-intel-ab.test.ts` | 18 | kill switch (3) / global pct (4) / sticky dice (3) / engine boundaries (4) / workspace beats env (2) / 1000-trial 50/50 distribution (1) / robust to nulls + safe-lookup (2) |
| `worker/code-intel-ab-telemetry.test.ts` | 8 | happy path / failure-row recorded / failure_reason clamp / alertId fallback (3) / DB-throw-swallow / cost serialization |
| `worker/code-intel-tools.test.ts` (extension) | 5 | `forceEnabled` override on `appendCodeIntelV2Tools` + `executeCodeIntelTool` |
| `web/migration-0083.test.ts` | 9 | structural — table / CHECK / cascades / 3 indexes / IF NOT EXISTS / orgs ALTER / rollback / non-mutation |
| `web/lockdown eslint-rule.test.ts` (extension) | 6 | 4 valid (admin endpoint / cutover script / seed script) + 2 invalid (admin route / non-cutover script) |

---

## 3.3 — Cutover decision tooling

Decides whether to flip `CODE_INTEL_V2` default from `off` to `on` based
on the data Phase 3.1 + 3.2 collect.

### Constants

`web/lib/code-intelligence-v2/cutover-criteria.ts`:

```typescript
CUTOVER_MIN_SAMPLES        = 100   // need >= 100 A/B rows or WAIT
CUTOVER_TURN_REDUCTION_PCT = 30    // v2 must reduce avg turns by >= 30%
CUTOVER_SUCCESS_PARITY_PCT = -2    // v2 success may be at most 2pp below v1
CUTOVER_DIVERGENCE_MAX_PCT = 25    // shadow divergence must be <= 25%
CUTOVER_WINDOW_HOURS       = 336   // 14 days
```

### Compute (pure)

`web/lib/code-intelligence-v2/cutover-eval.ts`:

- `computeCutoverMetrics({ab, shadow})` — pure function over fabricated
  rows, no DB. Returns `{ab: {total, v1Count, v2Count, v1AvgTurns,
  v2AvgTurns, v1SuccessPct, v2SuccessPct, turnReductionPct,
  successDeltaPct}, shadow: {total, divergentCount, divergencePct,
  timeoutCount, timeoutPct}}`.
- `decideCutover(metrics)` — applies the gate matrix:
  - `ABORT` — any ABORT-trigger gate fails (success_parity)
  - `WAIT` — any WAIT-trigger gate fails (samples / turn_reduction /
    divergence)
  - `GO` — all gates pass
  - Returns `{recommendation, gates: CutoverGate[], reasons: string[]}`
    where each gate carries `{id, passed, detail, triggers}` so the UI
    can render per-gate ok/fail + the specific number that flipped it.

### Fetcher

`web/lib/code-intelligence-v2/cutover-fetch.ts`:

- `fetchCutoverInputs({windowHours})` — reads
  `code_intel_remediation_ab` + `code_intel_shadow_log` over the window
  and shapes the rows into `ComputeMetricsInput`. Tolerates both
  neon-http `{rows: T[]}` and bare `T[]` driver shapes. Touches the
  schema imports so the lockdown rule keeps them as live references.

### Endpoint

`GET /api/admin/code-intel/cutover-status` (admin-only):

- Returns `{windowHours, thresholds, metrics, decision}`.
- 500 with `{error: "fetch_failed", detail}` when the DB read throws.
- Uses the same `fetchCutoverInputs` → `computeCutoverMetrics` →
  `decideCutover` chain the CLI uses.

### Widget

`web/app/(dashboard)/admin/ops/widgets/code-intel-cutover.tsx`:

- Suspense-driven, `revalidate = 60`.
- Mounted next to `CodeIntelShadowWidget` on the /admin/ops page.
- Renders the GO/WAIT/ABORT badge at the top, then 4 metric cards
  (window / A/B telemetry / shadow log / gates), then a
  "what would flip this" hint list (or "next steps" when the verdict
  is GO).
- Empty state nudges the operator to set `CODE_INTEL_V2=shadow` +
  `CONTAINER_AGENT_AB_PCT > 0` to start collecting data.

### Script

`web/scripts/code-intel-v2-cutover-eval.ts`:

- Operator's day-of-cutover smoke check. Prints the same answer the
  dashboard would show, in colored terminal-friendly form.
- `--window-hours N` (default 336) and `--json` flags.
- Smoke test posture: on an empty DB it always prints `WAIT` with
  "only 0 A/B samples" — safe to wire into CI as a sanity check.

### Tests (23 new)

| File | Cases | Coverage |
|---|---:|---|
| `cutover-eval.test.ts` | 15 | empty inputs / turn-reduction sign / success delta / shadow pct / GO path / 4 WAIT paths (insufficient samples / turn / divergence / multi-fail) / 2 ABORT paths (parity drop / ABORT-beats-WAIT priority) / 4 boundary checks (each constant exactly at threshold) |
| `cutover-status.test.ts` | 8 | unauth (2) / empty population → WAIT (1) / populated GO (1) / ABORT on parity (1) / WAIT on divergence (1) / driver shape tolerance (1) / 500 on fetch failure (1) |

---

## Validation runs (end of Phase 3)

| Surface | Command | Result |
|---|---|---|
| Web v2 + Phase 0 + db + lockdown + admin code-intel | `vitest run lib/code-intelligence-v2 lib/code-intelligence lib/db app/api/code-intel-v2 app/api/admin/code-intel` | **286 / 286** |
| Worker A/B + telemetry + tools | `vitest run src/__tests__/code-intel-ab.test.ts src/__tests__/code-intel-ab-telemetry.test.ts src/__tests__/code-intel-tools.test.ts` | **51 / 51** |
| Lint (web) | `npx eslint lib/code-intelligence-v2/ lib/code-intelligence/ lib/services/code-intelligence.service.ts lib/db/__tests__/migration-008*.test.ts app/api/admin/code-intel/ scripts/code-intel-v2-cutover-eval.ts scripts/seed-shadow-run.ts` | 0 errors (1 pre-existing unused-disable warning in parser.ts unchanged from Phase 0) |
| Build (web) | `next build` with stub envs | `✓ Compiled successfully` |

**88 net-new Phase 3 tests passing.** Plus the 257 carried from Phases
0+1+2 still green (= 286 web). Worker baseline (Phase 1.6's 16) carried
green on top of the 35 net-new for 3.2 → 51 worker.

---

## Migration renumbering

The branch was rebased onto an updated `origin/main` (= `6b505899`)
during integration. Upstream had taken slot 0081 with v0.3 S5's
`workspace_local_voice` migration and slot 0082 was already used. Phase
3's two migrations were renumbered:

| Phase | Original slot (in WIP commits) | Final slot (on branch) |
|---|---|---|
| 3.1 (shadow controls)   | 0081 | **0082** |
| 3.2 (remediation A/B)   | 0082 | **0083** |

Both the SQL files AND the structural-test files (`migration-0081.test.ts`
→ `migration-0082.test.ts`, `migration-0082.test.ts` →
`migration-0083.test.ts`) were renamed. The Drizzle schema and lockdown
rule did NOT change — they reference the table names, not the migration
files.

Per `feedback_no_breaking_changes.md`: existing customers see no behavior
change. The Phase 3.1 column on `organizations` is NULLABLE and defaults
to "inherit env"; the Phase 3.2 table is empty until the worker writes
to it; the Phase 3.2 column on `organizations` is NULLABLE and defaults
to "inherit env (= 0 = all v1)".

---

## Decisions / non-obvious choices

1. **Two queries instead of a JOIN in the workspace lookup.** Both
   `getWorkspaceShadowPct` and `getWorkspaceAgentAbPct` query
   `projects` first, then `organizations`. A single `innerJoin` would
   work but the existing service-dispatch test (Phase 1.5) mocks
   `db.select().from().where().limit()` without modeling `innerJoin`,
   so two simple queries keep the existing tests untouched per
   "Phase 3 EXTENDS, doesn't refactor".

2. **Sticky dice via FNV-1a, not random.** The A/B router needs the
   same session to always pick the same engine — even across worker
   crashes. FNV-1a 32-bit on `sessionId` is deterministic, has no
   deps, and distributes uniformly enough across 100 buckets (verified
   with the 1000-trial distribution test).

3. **v2 attempt fire-and-forget after timeout.** Once the timeout
   trips, `v2Tracker.catch(() => undefined)` drains the late rejection
   so it doesn't surface as an unhandled promise. The shadow log row
   is still written synchronously before `searchCode` returns so the
   widget sees the timed-out call on its next read tick.

4. **MIN_V2_BUDGET_MS = 100ms (configurable).** Without a floor, a
   1ms v1 would give v2 only 1ms of additional headroom and the slow
   guard would constantly trip, skewing the cutover metrics. The
   `CODE_INTEL_V2_MIN_V2_BUDGET_MS` env override exists mostly for
   tests (which set it to ~10-25ms to deterministically exercise the
   timeout path without sleeping for 100ms+).

5. **Telemetry writer skips rows it can't anchor to an alert.** The
   FK on `code_intel_remediation_ab.alert_id` is NOT NULL. If the
   session lookup returns no alertId (deleted, race, test) the writer
   silently skips rather than throwing — telemetry must never break
   a remediation. Audit trail is preserved via `remediation_session_id`.

6. **`engine` text + CHECK constraint, not pg ENUM.** Same convention
   as `code_symbols.kind` (Phase 1.1). Adding "v3" later is a no-op
   instead of a pg enum migration.

7. **Cost = NULL today; Phase 3.4 may backfill.** Worker doesn't
   aggregate AI cost per remediation today (each `ai_usage_logs` row
   is per call). The cutover gate doesn't depend on cost — turns +
   success rate are the primary signal. A follow-up can sum
   `ai_usage_logs.cost_usd` by `remediation_session_id` to backfill.

8. **Cutover gate priority: ABORT > WAIT > GO.** A failed parity gate
   (success_delta < -2pp) returns ABORT immediately, even if other
   gates would have returned WAIT. This makes "v2 is materially
   worse" the loudest possible signal.

9. **Empty-DB cutover decision is WAIT, not GO.** The samples gate
   triggers WAIT when `ab.total < CUTOVER_MIN_SAMPLES`. On an empty
   DB that's `0 < 100 = WAIT`. This makes the script + endpoint safe
   to wire into CI as a sanity check — they can never accidentally
   return GO before any data exists.

10. **`code_intel_v2_agent_ab_pct` separate from
    `code_intel_v2_shadow_pct`.** They control orthogonal experiments
    (shadow logging vs container-agent tools). An operator may want to
    ramp shadow up (gather divergence data) without exposing the new
    tools to the agent yet, or vice versa. Two columns keep them
    independent.

11. **Lockdown rule pre-allowlists Phase 3.3 paths in the Phase 3.2
    commit.** Because the cherry-pick order is 3.1 → 3.2 → 3.3, and
    the lockdown changes live in 3.2, the allowlist entries for the
    3.3 paths are added speculatively in 3.2. Avoids a circular
    dependency and keeps each commit independently reviewable.

12. **Worker `node_modules` junction recreated at session start.** The
    pre-flight didn't list `worker/node_modules` as a junction (only 3
    were pre-linked); the Phase 1.6 status report's note 16 confirms
    the worker junction was a per-session artifact. Created via
    `New-Item -ItemType Junction -Path worker/node_modules -Target
    web/node_modules` so vitest could resolve.

---

## Outstanding (NOT for Phase 3)

- **Cost backfill** — `code_intel_remediation_ab.cost_usd` is NULL
  today. Phase 3.4 follow-up may join `ai_usage_logs` by
  `remediation_session_id` and sum.
- **Per-session repoId in worker** — `loadSessionContext` returns
  `repoId: null` and lets the web side resolve via projectId. Phase
  3.4 can wire this once `remediation_sessions` carries `repoId`.
- **OSS-repo precision validation** — Phases 1 + 2 deferred this to
  Phase 3 indexer integration. Not in scope for Phase 3 (the
  CUTOVER_DIVERGENCE_MAX_PCT gate is the production proxy for
  precision).
- **Pyright bump regression test** — same posture as Phase 2. Bump =
  re-run the smoke test.
- **Calendar-time data accumulation** — the cutover script + widget
  ship now; the actual flip is a calendar event when prod data
  satisfies all 4 gates.
- **Pre-existing tsc errors in `worker/src/tools/code-intel.ts`
  lines 143/148/155** — `as ToolInputXxx` casts. Blame-confirmed
  Phase 1.6 (`87d2f86d`). Vitest's esbuild + production tsx don't
  enforce; left as-is per "Phase 3 EXTENDS".

---

## Push queue

3 commits off `origin/main` (`6b505899`):

```
b3142ae0  feat(code-intel-v2): shadow harness + sampling controls (Phase 3.1)
1b1a71a4  feat(code-intel-v2): container-agent A/B telemetry (Phase 3.2)
96555dc3  feat(code-intel-v2): cutover decision tooling (Phase 3.3)
```

These are CHERRY-PICKED from the original session SHAs (72d9c9cc /
b35015e9 / b75af935) onto the updated origin/main during integration —
the migration renumbering is the only material difference.

**Recommendation: GO push when Jesus is ready.** All three phases are
coexistence-safe. Once pushed:

1. **Deploy** (no behavior change — `CODE_INTEL_V2=off`,
   `CONTAINER_AGENT_AB_PCT=0` defaults).
2. **Apply migrations 0082 + 0083** via Drizzle Kit.
3. **Optionally seed the v1 baseline first** with the dogfood seeder
   (`web/scripts/seed-codeintel-dogfood.ts` from upstream `6b505899`)
   to populate `ai_usage_logs` + `remediation_sessions` for the cutover
   eval to compare against.
4. Proceed with the runbook below to ramp shadow + A/B.

DO NOT push without explicit ask (per `feedback_commit_workflow.md`).

---

## Runbook — How to flip `CODE_INTEL_V2` to `on`

This is the calendar-time procedure the operator (Jesus) runs once the
cutover dashboard says GO.

### Phase A — Ramp shadow (week 1)

1. **Set the engine flag globally:**
   ```bash
   kamal env set CODE_INTEL_V2=shadow  -d web
   kamal redeploy web
   ```
   Effect: every `searchCode()` call runs both v1 and v2 in parallel,
   v1 returned to the caller, comparison logged. Existing behavior
   for callers is unchanged.

2. **(Optional) Seed initial samples** so the dashboard isn't empty:
   ```bash
   cd web
   CODE_INTEL_V2=shadow npx tsx scripts/seed-shadow-run.ts \
     --project <dogfood-project-uuid> --limit 25
   ```

3. **Watch `/admin/ops` Code Intelligence v1 vs v2 Shadow widget for
   24h.** Look for: divergence < 25%, v2 p95 ≤ 1.5× v1 p95, no v2-side
   errors. The Cutover Decision widget below it shows the same data
   re-aggregated against the gate matrix.

4. **(Optional) Per-workspace ramp** — set
   `organizations.code_intel_v2_shadow_pct = 100` for a specific
   workspace to ensure it always gets the shadow treatment, regardless
   of `SHADOW_SAMPLE_RATE`.

### Phase B — Container-agent A/B (week 2-3)

1. **Enable v2 tools globally:**
   ```bash
   kamal env set CODE_INTEL_V2_TOOLS=on  -d worker
   kamal env set CONTAINER_AGENT_AB_PCT=50  -d worker
   kamal redeploy worker
   ```
   Effect: 50% of remediations get the v2 tool set
   (`find_references` / `type_at` / `blast_radius`), 50% stay on v1.
   Sticky per session.

2. **Watch `/admin/ops` Cutover Decision widget every few days.**
   The recommendation badge flips to GO once all 4 gates pass:
   - `samples` — at least 100 A/B rows
   - `turn_reduction` — v2 reduces avg turns by ≥ 30%
   - `success_parity` — v2 success rate within 2pp of v1
   - `divergence` — shadow divergence ≤ 25%

3. **(Optional) Per-workspace ramp** — set
   `organizations.code_intel_v2_agent_ab_pct = 100` for the dogfood
   workspace so it always sees v2 (faster signal).

### Phase C — Smoke check via the CLI

```bash
cd web
npx tsx scripts/code-intel-v2-cutover-eval.ts
```

Output ends with `Recommendation: GO|WAIT|ABORT` plus the specific
number that flipped each gate. Same answer as the widget — useful for
copy/paste into a PR description or weekly status update.

### Phase D — The flip

Once both the widget AND the CLI say `GO`:

1. **Flip the default:**
   ```bash
   kamal env set CODE_INTEL_V2=on  -d web
   kamal redeploy web
   ```
   Effect: `searchCode()` returns v2 results (adapted to the v1 shape
   via the Phase 1.5 `adaptV2ToV1` adapter) for every call. v1 stays
   reachable as a transparent fallback — when a project has no
   v2-indexed repo yet, the dispatcher falls back to v1 silently.

2. **Watch `/admin/ops` for the next 30 minutes:**
   - Code Intelligence v1 vs v2 Shadow widget → divergence ramps to 0%
     (because both engines now produce the same result — the caller
     gets v2).
   - Errors stay flat across the board.
   - Container Agent dashboards show the v2 cohort succeeding at
     ≥ v1 rate.

3. **Decommission shadow** (optional, after ~1 week of clean
   `CODE_INTEL_V2=on`):
   ```bash
   kamal env set CODE_INTEL_V2_KILL_SHADOW=1  -d web
   kamal redeploy web
   ```
   Or unset the per-workspace pct overrides:
   `UPDATE organizations SET code_intel_v2_shadow_pct = NULL;`.

### Rollback (< 5 minutes)

If anything goes wrong after the flip:

```bash
kamal env set CODE_INTEL_V2=off  -d web
kamal redeploy web
```

Effect: `searchCode()` returns v1 results immediately for every call.
v2 module untouched — re-enable later by setting back to `on` or
`shadow`. Same rollback applies to the container-agent A/B:

```bash
kamal env set CONTAINER_AGENT_AB_KILL_V2=1  -d worker
kamal redeploy worker
```

---

## What Phase 4 (if any) inherits

- **Production data** — the cutover dashboard + script populate as
  soon as Phase 3 deploys. Phase 4 inherits weeks of A/B + shadow
  rows.
- **Cost backfill seam** — `code_intel_remediation_ab.cost_usd` is
  NULL today; Phase 4 can join `ai_usage_logs` by
  `remediation_session_id` and sum.
- **Per-workspace cutover dashboard** — current widget shows global
  numbers; Phase 4 can add a workspace selector for the same gates.
- **OSS-repo precision validation** — same gap Phases 1 + 2 carried.
  Once a staging Docker pool can clone repos, the same harness
  covers both languages end-to-end.
- **Decommission v1 statistical** — the handoff specifies "v1 kept
  available as fallback for 60 days" after the flip. Phase 4 (or
  later) drops the v1 indexer + `code_chunks` table once the soak
  window closes.
