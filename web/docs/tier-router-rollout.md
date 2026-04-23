# Tier Router — Rollout Playbook

Fase 6 ships the tier router and pattern memory as shadow-only infrastructure.
This document defines **how** the system is promoted to live routing. It is
deliberately explicit — promotion to `live` changes the fix path for real
remediations and is **not** a "flip the flag" decision.

## Flag model

| Env var | Values | Default | Owner |
|---|---|---|---|
| `TIER_ROUTER_MODE` | `off` \| `shadow` \| `live` | `off` | Platform ops |
| `PATTERN_MEMORY_WRITE_ENABLED` | `true` \| `false` | `true` | Platform ops |
| `PATTERN_MEMORY_READ_ENABLED` | `true` \| `false` | `false` | Platform ops |
| `PATTERN_MEMORY_KILL_SWITCH` | `true` \| `false` | `false` | On-call |

Pattern memory writes can proceed independently of classifier reads — the
accumulated patterns are the moat even if the classifier is never flipped on.

## Promotion gates (hard requirements before `shadow` → `live`)

All five must be green for at least **14 consecutive days** on the prod
`app.inariwatch.com` dataset. Numbers below reference the `/admin/ai`
"Shadow Classification (Fase 6)" widget.

1. **Classifier vs. human agreement ≥ 90%** on a 50-sample random backfill.
   Backfill methodology: pick 50 `remediation_sessions` where `tier_used IS
   NOT NULL`, human labels each with the tier it *should* have taken, compare.
   Widget accuracy is an approximation until this backfill is done.

2. **p95 latency of `routeTier` end-to-end < 200ms.** Measured from
   `ai_usage_logs` rows with `phase='classify'` + `phase='pattern_lookup'`
   joined by `remediation_session_id`.

3. **Zero critical incidents attributed to the router.** Critical means:
   post-merge regression OR escalation caused by a routing choice. The
   attribution flag lands in the incident postmortem (added manually during
   Fase 6.1 rollout reviews).

4. **Pattern memory health ≥ 30 patterns cross-project**, **≥ 5 with
   `success_count ≥ 3`**. Below this, Tier 0 will thrash — promoting live
   without proven patterns invites regressions.

5. **Approval sign-off.** Platform ops posts a rollout doc in the internal
   audit channel with the five metrics above and a link to this playbook.
   Second reviewer (typically the owner of `remediate.ts`) acks before
   the env var is flipped.

## Rollout steps (`shadow` → `live`)

Once gates are green:

1. **Dry-run on staging first.** If staging has no recent remediations,
   replay 5 prod sessions through staging with `TIER_ROUTER_MODE=live`.
   Inspect the resulting PRs — every Tier 0 apply must be byte-identical
   to the corresponding prod merged commit (validates the pattern store).

2. **Canary — 10% by project hash.** Introduce a 10% traffic slice via
   a deterministic hash of `project_id` — even-hash projects go `live`,
   odd-hash stay `shadow`. 7-day soak, monitor:
   - Tier 0 success rate vs. the Tier 2 baseline (must be **within ±2%**).
   - `disablePattern` firings (expected: 0–3 in 7 days across canary set).
   - Remediation wall-time p95 (Tier 0 should trend lower, not higher).

3. **Ramp to 50% → 100%** over 7 more days if canary clean. Each step
   paged to on-call. Roll back = set `TIER_ROUTER_MODE=shadow`. No code
   change; effect within ~30s of env push on Hetzner (kamal env push
   rolls the app instances without a rebuild).

## Circuit breakers already in place

Don't replicate these outside the router:

- `pattern-memory.ts` — in-process read latency breaker: 5× `>500ms` in 60s
  → read returns `[]` for 60s.
- `tier-router.ts` — in-process classifier error breaker: 3 errors in 60s
  → skip the LLM call, use heuristic only for 60s.
- `PATTERN_MEMORY_KILL_SWITCH=true` — immediate read disable, intended
  for on-call use during outage.

There is no global "live → shadow" auto-rollback. That is **intentional**:
the ability to auto-demote hides the underlying failure. Classifier failures
already fall through to the heuristic rules silently; anything worse than
that deserves a human decision.

## What does NOT gate `shadow` operation

Pattern writes + shadow classification are low-risk by design:

- **Writes** — idempotent upsert keyed on `(project_id, error_fingerprint)`.
  Worst-case for a regression during writes: a useless row.
- **Shadow classification** — only writes `tier_used` + `pattern_match_score`.
  Pipeline path unchanged. Worst-case for a regression: bogus values on one
  column that the fix path never reads.
- **Cost** — classifier is `gpt-5-nano` at ~$0.0001/call. At current volume
  (~100 remediations/day), shadow mode costs ≤ $0.30/month.

## Backfill — 50-sample human labeling

Fase 6 acceptance requires 50 human-labeled sessions before promoting.
Suggested workflow:

```sql
SELECT id, tier_used, status, monitoring_status, confidence_score, fingerprint
FROM remediation_sessions
WHERE tier_used IS NOT NULL
  AND created_at > now() - interval '14 days'
ORDER BY random()
LIMIT 50;
```

For each row, a human reviewer decides what tier was *correct* given the
alert + diagnosis + final patch. Store in a lightweight `tier_router_labels`
table (added in Fase 6.1) or a spreadsheet — the widget accuracy view
switches from "approx" to real accuracy once that table has ≥ 50 rows.

## Fase 6 → 6.1 scope boundary

**Shipped in Fase 6 (this doc):**
- Pattern memory service (read/write/decay/disable).
- Tier router classifier (shadow mode).
- Tier 0 / Tier 1 handler stubs (throw if invoked).
- `/admin/ai` shadow classification widget (3 metrics).
- Wiring into `remediate.ts` / `post-merge-monitor.ts` /
  `escalation-engine.ts`, all behind defaults-off flags.

**Deferred to Fase 6.1:**
- Tier 0 handler body (direct pattern apply).
- Tier 1 handler body (category-template single-shot).
- `routeTier` dispatching to handlers when `TIER_ROUTER_MODE=live`.
- `tier_router_labels` table + UI.
- Auto-contribution of patterns to the cross-project network (moves to Fase 9).

## Emergency rollback

Set `TIER_ROUTER_MODE=off` **and** `PATTERN_MEMORY_WRITE_ENABLED=false`.
Applies on next process restart on Hetzner (≤ 30s with rolling deploy).
Historical `pattern_memory` rows persist — writes only pause, reads are
already gated. The database is never the blocker for rollback.
