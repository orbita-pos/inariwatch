# InariWatch Runbooks

Operational runbooks for on-call response to incidents affecting the VAR remediation pipeline. These are tabletop-exercise material — written to be followed when a human is paged and needs to act quickly.

Each runbook has the same shape:

1. When to reach for it (trigger conditions).
2. Signals (queries + dashboards to confirm).
3. Immediate containment (≤ 10-15 min actions).
4. Diagnosis (when rollback is not the right answer).
5. Recovery steps.
6. Customer communication guidance.
7. Post-incident review checklist.

## Index

| Runbook | SEV default | When to reach for it |
|---|---|---|
| [sandbox-cve.md](./sandbox-cve.md) | SEV-1 | Upstream Deno/Pyodide CVE, or anomalous sandbox failures in `sandbox_audit_log`. |
| [model-regression.md](./model-regression.md) | SEV-2 | `/admin/ai` SLO widget shows open breach on `metric=success_rate` with `consecutive_breach_count ≥ 3`. |
| [pattern-poisoning.md](./pattern-poisoning.md) | SEV-2 (SEV-1 if Tier 0 is live) | `pattern_memory.disabled_at` spikes, post-merge regressions on pattern-derived fixes. |
| [community-fix-abuse.md](./community-fix-abuse.md) | SEV-3 | Reports spike on a community fix, or abnormal contributor activity. |

## Updating

- Any runbook action you had to improvise during an incident → edit the runbook.
- Tabletop exercises: run one runbook per quarter against a throwaway staging incident. Update the "Last tabletop" field each time.
- Related chaos scenarios live under `k6/scenarios/chaos-*.js` — they are the automated probes that the runbooks are the human complement to.

## Related

- Fase 12 Part A monitoring: `web/lib/ai/slo-monitor.ts`, `web/lib/db/migrations/0071_slo_events.sql`.
- Security roadmap: `SECURITY_AND_COMPLIANCE_ROADMAP.md`.
- Rollout playbooks (not runbooks): `web/docs/tier-router-rollout.md` and `web/docs/migration-vercel-to-hetzner.md`.
