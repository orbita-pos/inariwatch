# Runbook — Remediation Model Regression

**Owner:** Platform ops (Jesus)
**Severity by default:** SEV-2 (affects success rate but not availability)
**Last tabletop:** —
**Affected components:** `lib/ai/client.ts`, `lib/ai/prompts.ts`, `lib/ai/tier-router.ts`, `lib/ai/slo-monitor.ts`, worker `container-agent.ts`

---

## When to reach for this runbook

- `/admin/ai` SLO Status widget (Fase 12) shows **open breach** on `tier=1|2|3, metric=success_rate`, `consecutive_breach_count >= 3` (paging threshold).
- Or `slo_events` has an open row on `metric=success_rate` for more than 15 minutes.
- Or customer report: "my remediations keep failing".
- Or cost-per-fix in InariLens widget jumps > 2× baseline ($0.25 → $0.50+).

If the breach is on `metric=p95_latency_ms` (not success_rate), use a latency-specific triage instead — model changes rarely cause latency regressions alone.

---

## Signals

| Signal | Source | Meaning |
|---|---|---|
| `slo_events` open row, success_rate | `SELECT * FROM slo_events WHERE resolved_at IS NULL AND metric='success_rate';` | Active regression. |
| Confidence score distribution skew | `SELECT AVG(confidence_score) FROM remediation_sessions WHERE created_at > now() - interval '1 hour'` | Low = model is uncertain. |
| Self-review reject rate ↑ | query `self_review_result->>'recommendation' = 'reject'` | Generated fixes are worse. |
| `ai_usage_logs.cost_usd` p95 ↑ | InariLens widget | Model output is longer/looping. |

---

## Immediate containment (≤ 15 min)

Rollback is always "revert the last prompt or model-routing change to main".

### Step 1 — Identify the suspect change

```bash
# What shipped in the last 48 hours to AI paths
git log --since="48 hours ago" -- web/lib/ai/prompts.ts web/lib/ai/client.ts \
                                web/lib/ai/tier-router.ts web/lib/ai/remediate.ts \
                                worker/src/container-agent.ts worker/src/ai-client.ts
```

Also check env flips:

```bash
git log --since="48 hours ago" -- web/config/deploy.yml
```

### Step 2 — Fast rollback paths

**If the change was an env flag flip** (e.g., `REMEDIATION_MODEL_ROUTING=true`, `TIER_ROUTER_MODE=shadow|live`):

```bash
# Edit web/config/deploy.yml to restore the previous value
git add web/config/deploy.yml
git commit -m "incident: revert <flag> — success_rate SLO breach"
git push origin main
# deploy-web.yml fires automatically; env propagates on rolling restart (~3 min).
```

**If the change was code** (prompt/model/routing):

```bash
# Revert the specific commit, don't try to hand-fix.
git revert <sha-of-regressing-commit>
git push origin main
```

### Step 3 — Verify the SLO recovers

- `/admin/ai` widget — open breach should resolve within 5 min (one cron cycle) after `updated_at - created_at` for the next batch of completed remediations clears the threshold.
- SQL:
  ```sql
  SELECT tier, metric, resolved_at
  FROM slo_events
  WHERE created_at > now() - interval '1 hour'
  ORDER BY created_at DESC LIMIT 20;
  ```

---

## Diagnosis (when rollback is not the right answer)

Sometimes the regression is **not** from a recent change — model provider degraded, upstream prompt cache issue, data drift in customer alerts. Before reverting anything:

1. **Cross-check model health.** If the regression is provider-specific, cost will correlate with a single `ai_usage_logs.provider`.
   ```sql
   SELECT provider, model, COUNT(*), AVG(cost_usd), AVG(duration_ms)
   FROM ai_usage_logs
   WHERE created_at > now() - interval '1 hour'
   GROUP BY provider, model ORDER BY AVG(cost_usd) DESC;
   ```
2. **Check the InariLens dashboard session view.** Recent sessions with `status='failed'` — read the transcripts via `/admin/ai/session/:id`. If failures all share a theme (tool-call format break, context-length cliff, rate limit), that's the actual cause.
3. **Check fingerprint concentration.** A single customer flooding with a new error pattern can look like a regression.
   ```sql
   SELECT fingerprint, COUNT(*) FROM remediation_sessions
   WHERE status = 'failed' AND created_at > now() - interval '1 hour'
   GROUP BY fingerprint ORDER BY COUNT(*) DESC LIMIT 10;
   ```

Only after these checks should you conclude "it's our code" vs "it's external".

---

## Recovery

1. Once the regression is resolved (rollback applied OR external cause cleared), confirm the breach closes in `slo_events` (resolved_at stamped).
2. Keep watching for **1 hour** — flapping is a sign the rollback was incomplete.
3. If rolled back a change: open a follow-up issue with the golden dataset delta. The change needs an eval pass before the next attempt.

---

## Customer communication

- **Status page:** post if the breach lasted > 30 min AND affected `tier=2` (the main path). Title "Remediation success rate degraded", resolve when `slo_events.resolved_at` is stamped.
- **Direct contact:** only if a specific high-value customer is visible in the failed sessions.
- **Auto-remediation trust:** does NOT auto-pause on a model regression. The 17 gates are still the floor. If failures are "bad fixes merged anyway", that's a different incident — see **pattern-poisoning.md**.

---

## Post-incident review checklist

- [ ] Root cause documented: regressing change, or external event, with evidence.
- [ ] Rolled-back change has a regression test added to `web/lib/ai/__tests__/` where feasible.
- [ ] If regression was caught by SLO cron — note it in the review (SLO value validated).
- [ ] If regression was NOT caught — update `slo-monitor.ts` thresholds or add a new metric.
- [ ] Update this runbook.

---

## Related

- Fase 12 Part A: `web/lib/ai/slo-monitor.ts`, `web/lib/db/migrations/0071_slo_events.sql`.
- AI pipeline: `REMEDIATION_SYSTEM_ARCHITECTURE.md` §Fase 3 (model routing).
- Eval harness: `web/scripts/build-golden-dataset.ts`, `.github/workflows/eval-ai.yml`.
