# Auto-merge Gates — Dependency Graph (SSOT)

This is the authoritative dependency DAG for the 17 auto-merge gates. The DAG executor in `web/lib/ai/gates-executor.ts` reads from this document's model. Any gate added to `web/lib/ai/auto-merge-gates.ts` must also be placed in this graph.

## Terminology

- **Producer**: the async computation that yields a gate's input value (e.g. an AI call, DB query, GitHub API call, external wait).
- **Evaluator**: `evaluateAutoMergeGates()` — pure sync function that consumes all producer outputs and emits a `GateResult`. Microsecond-scale; never a bottleneck.
- **Level**: a cohort of producers that share no intra-cohort dependencies and can therefore run under `Promise.all`.
- **Hard-fail**: a gate whose failure short-circuits subsequent levels (e.g. `security_scan` HIGH → no push). Hard-fail never aborts siblings within the same level — audit trail integrity takes precedence over microseconds of wall-time savings.

## Design principles

1. **Level = parallel cohort.** Levels are bulkheads; producers within a level never await one another.
2. **Audit trail always complete.** A hard-fail gate does not cancel its siblings. We still compute them so the PR body / `/admin/ai` dashboard shows the full picture.
3. **Cross-level early-abort.** If any hard-fail gate in level N fails, levels > N are skipped (or downgraded to the cheapest read, e.g. `container_verified` is a simple read of `containerVerified` from the worker result).
4. **Placeholders for unwired Q2 gates.** Gates declared in `auto-merge-gates.ts` but not yet populated by any caller are represented as null-returning producers. Adding real wiring later is a one-line change inside the producer — no topology edits.
5. **Flag `GATES_PARALLEL` controls rollout.** When false, the executor runs producers in the original serial order (matching pre-Fase-8 behavior exactly). When true, the DAG runs.

## The DAG

```
LEVEL 0 ── instant sync (<1ms total)
  auto_merge_enabled      [config lookup]
  confidence              [diagnosis.confidence]
  lines_changed           [sum of fix.files[].content line counts]

LEVEL 1 ── pre-push producers (Promise.all, p50 target ~8s)
  security_scan           [scanFiles + aiSecurityReview]
  self_review             [callAI cheap, escalate strong if score∈[40,70]]
  substrate_simulate      [heuristic over substrateRecordings.events]
  substrate_replay        [analyzeReplay AI mode]
  eap_chain_verified      [read remediationContext.eapReceipt.verified]
  compliance_scan         [regex scan over fix.files diff]              (Q2 — null until wired)
  prediction_safe         [AI prediction on PR diff]                    (placeholder)

LEVEL 2 ── push + CI (serial, external)
  push                    [GitHub API commit + branch]
  ci_passed               [waitForCiWebhook | polling fallback]
    depends on: Level 1 hard-fail gates must pass
                (security_scan.highCount===0, self_review≠reject@max)

LEVEL 3 ── post-CI producers (Promise.all, p50 ~60–180s dominated by staging)
  e2e_staging             [staging deploy + Playwright bot + AI vision]
  container_verified      [read-only: set by worker during fix generation]
  fleet_verification      [fleet replay run on branch]                  (Q2 — null until wired)
  performance_regression  [benchmark replayed vs recorded]              (Q2 — null until wired)
  behavioral_drift        [fleet drift analysis]                        (Q2 — null until wired)
  multi_env_coverage      [env distribution comparison]                 (Q2 — null until wired)
    depends on: ci_passed === true
                multi_env_coverage additionally depends on fleet_verification

LEVEL 4 ── aggregation (<100ms)
  cost_impact             [SUM(ai_usage_logs.cost_usd) WHERE session]
    depends on: every Level 1 + Level 3 AI producer has logged

                 │
                 ▼
  evaluateAutoMergeGates(...)   ← pure sync, <1ms
```

## Edges (dependsOn)

| Node | dependsOn |
|---|---|
| `auto_merge_enabled` | — |
| `confidence` | — |
| `lines_changed` | — |
| `security_scan` | L0 |
| `self_review` | L0 |
| `substrate_simulate` | L0 |
| `substrate_replay` | L0 |
| `eap_chain_verified` | L0 |
| `compliance_scan` | L0 |
| `prediction_safe` | L0 |
| `push` (meta-step) | `security_scan.highCount===0`, `self_review.recommendation≠reject @ attempt≥max` |
| `ci_passed` | `push` |
| `e2e_staging` | `ci_passed===true` |
| `container_verified` | `ci_passed===true` (read-only) |
| `fleet_verification` | `ci_passed===true` |
| `performance_regression` | `ci_passed===true` |
| `behavioral_drift` | `ci_passed===true` |
| `multi_env_coverage` | `fleet_verification` |
| `cost_impact` | all L1 AI producers + all L3 AI producers |
| `evaluateAutoMergeGates` | every producer above |

## Hard-fail policy

| Gate | On fail within level | Effect on next level |
|---|---|---|
| `auto_merge_enabled` = false | siblings finish for audit | all subsequent gates downgrade to `draft_pr` strategy — work continues for visibility, but no auto-merge |
| `security_scan.highCount > 0` | siblings finish for audit | Level 2 push still happens (for draft_pr), but final strategy locks to `draft_pr` |
| `self_review.recommendation === "reject"` AND `attempt >= maxAttempts` | siblings finish for audit | session aborts entirely — no push, no Level 2/3 |
| `ci_passed === false` AND `!flakeRetryEligible` | — | Level 3 skipped; final strategy `draft_pr` |
| any other gate fail | nothing (informational) | — |

## Expected wall-time impact

Baseline (serial, today):
- Level 1 producers: `security_scan` (3–10s) + `self_review` (3–15s) + `substrate_replay` (5–20s) = **sum ~11–45s, p50 ~15s**
- Other Level 1 nodes add ~100ms total.

Parallel (Fase 8):
- Level 1 producers under `Promise.all`: **max(A,B,F) ≈ 8–12s, p50 ~6s**
- Reduction: **≥60%** on Level 1 wall-time, matching Fase 8 acceptance.

Levels 0, 2, 3, 4 are unchanged: Level 2 is externally bounded (CI), Level 3 is dominated by staging deploy (I/O-bound, not parallelizable against itself further).

## Rollback

`GATES_PARALLEL=false` restores the original serial order. No schema change, no redeploy. Feature flag is read fresh at the top of each gate orchestration call.

## Adding a new gate

1. Add the evaluator branch in `web/lib/ai/auto-merge-gates.ts` (existing pattern).
2. Declare the producer in `web/lib/ai/gates-producers.ts` with `dependsOn`.
3. Place it in the appropriate Level here in this doc.
4. Add unit tests: isolated producer behavior + DAG placement (executor test).
5. If the gate is hard-fail, update the Hard-fail policy table above.

## References

- Spec: `REMEDIATION_SYSTEM_ARCHITECTURE.md` §Fase 8
- Evaluator: `web/lib/ai/auto-merge-gates.ts`
- Executor: `web/lib/ai/gates-executor.ts` (introduced in Fase 8)
- Caller: `web/lib/ai/remediate.ts` (the pipeline that invokes producers)
- Memory: `project_gates_count.md` — 17 gates total (CLAUDE.md still says 11)
