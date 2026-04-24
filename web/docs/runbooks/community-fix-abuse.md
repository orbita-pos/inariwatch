# Runbook — Community Fix Network Abuse

**Owner:** Platform ops (Jesus)
**Severity by default:** SEV-3 (quality degradation, not an outage)
**Last tabletop:** —
**Affected components:** `/api/patterns/contribute`, `/api/community/fixes`, `community_fixes`, `error_patterns`, `fix_ratings`

---

## When to reach for this runbook

- `/api/community/fixes/:id/report` receiving report spikes on one or more fixes.
- `community_fixes.failureCount / totalApplications` crosses a concerning threshold (e.g. > 0.4 with > 10 applications) on a fix that is showing up for multiple workspaces.
- `/api/patterns/contribute` receiving flooded submissions from a single contributor or IP.
- External report: "the community fix suggested for my alert looks malicious / wrong".

Abuse here is fundamentally different from `pattern-poisoning.md`: those rows live in PRIVATE per-project `pattern_memory`. Community fixes are CROSS-PROJECT — a single bad row can influence unrelated customers. Take this seriously even if the SEV starts low.

---

## Signals

| Signal | Source | Meaning |
|---|---|---|
| Spike of `fix_ratings.worked = false` on a fix | `SELECT fix_id, COUNT(*) FROM fix_ratings WHERE worked = false AND created_at > now() - interval '24 hours' GROUP BY fix_id ORDER BY COUNT(*) DESC` | Users are actively downvoting. |
| High `failureCount / totalApplications` | `SELECT id, failure_count, total_applications FROM community_fixes WHERE total_applications > 5 ORDER BY failure_count::float / NULLIF(total_applications,0) DESC LIMIT 20` | Fix consistently fails in production. |
| Unusual contributor activity | `SELECT contributed_by, COUNT(*), MIN(created_at), MAX(created_at) FROM community_fixes WHERE created_at > now() - interval '7 days' GROUP BY contributed_by HAVING COUNT(*) > 10` | One user dumping many fixes fast. |
| Ingest 4xx spike on `/api/patterns/contribute` | web logs / InariLens | Sanitizer or validator catching something. |

---

## Immediate containment (≤ 15 min)

Containment here is per-fix, not system-wide. We do not take the entire community network offline unless the abuse is structural (e.g., sanitizer bypass).

### Option A — Quarantine a specific fix

```sql
-- Soft-quarantine: make it invisible to lookup without deleting
UPDATE community_fixes
SET failure_count = total_applications,  -- drives success_rate to 0
    updated_at = now()
WHERE id = '<suspect_fix_id>';
```

If your SSOT is filtering by success rate in `community-fix-lookup.ts`, the fix drops out of suggestions immediately. Verify by calling the tool path the customer sees.

### Option B — Quarantine by contributor

```sql
-- Hide all fixes from a contributor pending review
UPDATE community_fixes
SET failure_count = total_applications,
    updated_at = now()
WHERE contributed_by = '<user_id>';
```

### Option C — Disable the whole contribute endpoint (structural issue only)

If there is a sanitizer bypass (someone got secrets into a stored fix), do this instead of per-row work:

```bash
# Add a kill-switch flag, or revert the most recent sanitizer change
git revert <sha>
git push origin main
```

---

## Diagnosis

1. **Look at the reports.** The `community_fixes/:id/report` endpoint stores reason text in the report row. Read them for context — reports often identify the exact concern.
   ```sql
   -- Shape depends on current schema — check web/lib/db/schema.ts for the reports table
   SELECT reason, created_at
   FROM community_fix_reports  -- adjust table name to current schema
   WHERE fix_id = '<suspect_fix_id>'
   ORDER BY created_at DESC LIMIT 50;
   ```
2. **Correlate to the pattern.** Every `community_fixes.pattern_id` points at an `error_patterns` row. Read the `patternText` to see what alerts that fix was attached to.
3. **Check for secret-shaped strings.** The sanitizer in `lib/ai/contribute-fix.ts` catches common shapes (`ghp_...`, `AKIA...`, hex keys). Re-run it on the stored row to confirm it would catch the payload today.
   ```sql
   SELECT fix_approach, fix_description, files_changed_summary
   FROM community_fixes WHERE id = '<suspect_fix_id>';
   ```
4. **Check cross-workspace spread.** If this fix was applied by N different workspaces before being flagged, the blast radius is N — escalate to SEV-2.

---

## Recovery

1. Confirm the quarantined fix is no longer returned by `lib/ai/community-fix-lookup.ts`.
2. If the attack was contributor-targeted: revoke or rate-limit that contributor's auth path (MCP Bearer token, session).
   ```sql
   -- For MCP tokens, mark as revoked (token_hash list — adjust for current schema)
   UPDATE mcp_tokens SET revoked_at = now() WHERE user_id = '<user_id>';
   ```
3. If the attack was sanitizer-level: add a regression test case to `web/lib/ai/__tests__/` and re-run the entire `community_fixes` table through the patched sanitizer offline.

---

## Customer communication

- **Workspaces that applied the bad fix:** email them directly. Include: the alert/fingerprint where the fix was suggested, link to the quarantined fix, suggested remediation (revert if they merged, ignore if they did not). Do this manually — we do not have an automated "retract community fix" flow.
- **Status page:** only if the cross-workspace spread is > 20 workspaces or a secret was leaked via a stored fix.

---

## Post-incident review checklist

- [ ] Root cause: contributor-level, sanitizer-level, or rating-system abuse.
- [ ] Fix IDs quarantined logged in incident doc.
- [ ] If sanitizer bypass: new regression test in `web/lib/ai/__tests__/contribute-fix.test.ts` (or equivalent).
- [ ] If rating abuse: rate-limit or CAPTCHA on `/api/community/fixes/:id/report` considered.
- [ ] Update this runbook.

---

## Related

- Contribute pipeline: `web/lib/ai/contribute-fix.ts`, `web/app/api/patterns/contribute/route.ts`.
- Community lookup: `web/lib/ai/community-fix-lookup.ts`.
- Chaos scenario: `k6/scenarios/chaos-community-fix-abuse.js`.
