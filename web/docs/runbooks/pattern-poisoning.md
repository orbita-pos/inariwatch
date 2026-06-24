# Runbook — Pattern Memory Poisoning

**Owner:** Platform ops (Jesus)
**Severity by default:** SEV-2 unless Tier 0 is live (then SEV-1)
**Last tabletop:** —
**Affected components:** `lib/ai/pattern-memory.ts`, `lib/ai/tier-router.ts`, `pattern_memory` table

---

## When to reach for this runbook

- Post-merge monitor reports regressions on fixes that came from Tier 0 or Tier 1 (pattern-derived) — `pattern_memory.success_count` drops or `disabled_at` stamps start appearing in bursts.
- Adversarial traffic detected in `chaos-pattern-poisoning` scenario against prod.
- External report of a fix that "looks auto-generated from a similar alert but is wrong".

If `TIER_ROUTER_MODE` is still `off` or `shadow` (the current default — see `deploy.yml`), the attack surface is **limited to future Tier 0/1 usage** — no active customer impact. Confirm mode first.

---

## Signals

| Signal | Source | Meaning |
|---|---|---|
| `pattern_memory.disabled_at` spikes | `SELECT COUNT(*) FROM pattern_memory WHERE disabled_at > now() - interval '1 hour'` | Disable policy firing on many rows = something generated bad patterns. |
| `post_merge_health_score` decreases on pattern-derived fixes | `SELECT AVG(post_merge_health_score) FROM pattern_memory WHERE last_used_at > now() - interval '24 hours'` | Pattern store is drifting. |
| `pattern-memory.ts` circuit breaker firing | log line `"pattern memory read latency breaker tripped"` | Either latency issue OR flood. |
| `tier_router` in live mode misroutes | `SELECT tier_used, COUNT(*) FROM remediation_sessions WHERE created_at > now() - interval '1 hour' GROUP BY tier_used` | Imbalance vs. shadow baseline. |

---

## Current mode — verify before any action

```bash
# Read the live value on Hetzner
ssh <hetzner-user>@<hetzner-host> 'docker exec $(docker ps --filter name=inari-web -q) printenv TIER_ROUTER_MODE'
# Expected in the current deploy: "shadow"
```

If mode is **`off` or `shadow`**, skip to "Diagnosis" — no immediate containment needed, since patterns are stored but not applied. Take the time to analyze before touching anything.

If mode is **`live`**, proceed to **Immediate containment** first.

---

## Immediate containment (`TIER_ROUTER_MODE=live` only)

### Option A — Kill pattern reads (recommended, fast)

```bash
# Edit web/config/deploy.yml env.clear
PATTERN_MEMORY_KILL_SWITCH: "true"

git add web/config/deploy.yml
git commit -m "incident: PATTERN_MEMORY_KILL_SWITCH on — suspected poisoning"
git push origin main
```

Effect: `pattern-memory.ts` short-circuits all reads to `[]` — Tier 0 / Tier 1 cannot match any pattern. Writes continue (new data accumulates cleanly).

Or skip the push and flip live via `kamal env push`:
```bash
cd web && kamal env push
```

### Option B — Demote to shadow

Less aggressive — keep classifier + writes running but stop applying.

```bash
# Edit deploy.yml
TIER_ROUTER_MODE: "shadow"
```

Use Option B if the symptom is a mild drift, not an active regression storm.

---

## Diagnosis

1. **Identify suspect rows.**
   ```sql
   SELECT id, project_id, error_fingerprint, success_count, confidence,
          post_merge_health_score, last_used_at, disabled_at
   FROM pattern_memory
   WHERE (disabled_at IS NOT NULL AND disabled_at > now() - interval '24 hours')
      OR (post_merge_health_score IS NOT NULL AND post_merge_health_score < 0.5)
   ORDER BY disabled_at DESC NULLS LAST LIMIT 100;
   ```
2. **Correlate to sessions.** For each suspect pattern, pull the sessions that wrote it:
   ```sql
   SELECT rs.id, rs.alert_id, rs.status, rs.created_at, a.title
   FROM remediation_sessions rs
   JOIN alerts a ON a.id = rs.alert_id
   WHERE rs.pattern_match_score IS NOT NULL
     AND rs.project_id = '<project_id>'
     AND rs.created_at > now() - interval '7 days'
   ORDER BY rs.created_at DESC LIMIT 50;
   ```
3. **Attacker vs. drift?** If suspect rows concentrate on one project or one fingerprint shape, it's likely targeted. If spread across projects, it's organic drift.

---

## Recovery

### Clean up poisoned rows

```sql
-- Review first
SELECT id, project_id, error_fingerprint, fix_strategy
FROM pattern_memory
WHERE disabled_at IS NOT NULL
  AND created_at > now() - interval '48 hours';

-- Disable (soft delete) — preferred over DELETE so history is preserved
UPDATE pattern_memory
SET disabled_at = now()
WHERE id IN (<list>);
```

Hard-delete only if the pattern data itself is a security concern (e.g., contains secret-shaped strings that violate privacy expectations).

### Re-enable path

1. Verify no new `disabled_at` entries accumulate over 1-hour window.
2. Re-enable reads:
   ```bash
   # Remove PATTERN_MEMORY_KILL_SWITCH from deploy.yml
   git add web/config/deploy.yml
   git commit -m "recovery: re-enable pattern memory reads"
   git push origin main
   ```
3. Watch `pattern_memory.success_count` trend for 24 hours before considering the incident closed.

---

## Customer communication

- **Status page:** only if the incident affected `TIER_ROUTER_MODE=live` AND a customer's fix was shipped with a bad pattern. In the current shadow mode, no customer-visible impact — no status page update.
- **Affected workspaces:** if a specific customer's `pattern_memory` rows were poisoned, rotate any PII-adjacent data and notify. Default is not to contact — patterns are per-project and do not cross tenants.

---

## Post-incident review checklist

- [ ] Root cause documented: adversarial input, organic drift, or a bug in the pattern-writing path.
- [ ] Poisoned row IDs listed in the incident doc (preserved in `disabled_at` state).
- [ ] If an adversarial attack: add the shape to `chaos-pattern-poisoning.js` regression cases.
- [ ] If a write-path bug: add a regression test to `web/lib/ai/__tests__/pattern-memory.test.ts`.
- [ ] Update this runbook.

---

## Related

- Fase 6 rollout: `web/docs/tier-router-rollout.md` (hard gates before `shadow → live`).
- Pattern memory tests: `web/lib/ai/__tests__/pattern-memory.test.ts`.
- Chaos scenario: `k6/scenarios/chaos-pattern-poisoning.js`.
