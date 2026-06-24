# Runbook — CodeAct Sandbox CVE

**Owner:** Platform ops (Jesus)
**Severity by default:** SEV-1 (potential RCE surface)
**Last tabletop:** —
**Affected components:** `lib/ai/codeact-sandbox.ts`, `sandbox_audit_log`, Deno runtime, Pyodide runtime, `worker/src/sandbox/`

---

## When to reach for this runbook

- Upstream CVE published against Deno `>=` or `<=` the version we run in production (check the Hetzner worker `docker exec inari-worker deno --version`).
- Upstream CVE published against Pyodide `>=` / `<=` the version we ship in the sandbox image.
- The `chaos-sandbox-cve` k6 scenario starts failing against production (ingest 5xx or MCP health red).
- External security report alleging sandbox escape on InariWatch.

If the trigger is **observed anomalous sandbox behavior without a CVE** (e.g., high rate of `sandbox_audit_log.success=false`) use the diagnosis section first, then decide.

---

## Signals

| Signal | Source | Meaning |
|---|---|---|
| New Deno/Pyodide CVE advisory | upstream, `npm audit`, `osv.dev` | Upstream vulnerability published. |
| `sandbox_audit_log` → `success=false` rate > 5%/hr | `SELECT COUNT(*) FROM sandbox_audit_log WHERE created_at > now() - interval '1 hour' AND success = false;` | Runtime failing on inputs it should handle. |
| Worker logs `[sandbox] verifier rejected` bursts | `kamal app logs worker -f` | Deno deny-list catching attempts — could be adversarial or legit. |
| `/admin/ai` SLO widget shows Tier 2 p95 breach | Fase 12 widget | Sandbox inside tier 2 calls dragging p95 up. |

---

## Immediate containment (≤ 10 min)

### Option A — Disable CodeAct entirely (fastest, safest)

Set `SANDBOX_MODE=none` in production, which routes every remediation back to the pre-Fase-5 path (no sandbox execution).

```bash
# Edit web/config/deploy.yml env.clear
SANDBOX_MODE: "none"

# Commit + push — deploy-web.yml fires automatically
git add web/config/deploy.yml
git commit -m "incident: disable CodeAct sandbox pending CVE review"
git push origin main
```

Web container picks up the env during the rolling restart (~3 min). Worker picks up on next `deploy-worker` run — faster via:

```bash
ssh <hetzner-user>@<hetzner-host>
sudo systemctl restart inari-worker
```

Verify:
```sql
-- No new sandbox runs after the restart
SELECT MAX(created_at) FROM sandbox_audit_log;
```

### Option B — Block only the affected runtime

If the CVE is Deno-only and we want to keep Pyodide (or vice versa), edit the sandbox config instead of the top-level flag — but DO NOT attempt this under time pressure. Option A is always correct.

---

## Diagnosis

1. **Confirm runtime version on the worker.**
   ```bash
   ssh <hetzner-user>@<hetzner-host>
   docker exec $(docker ps --filter name=inari-worker -q) deno --version
   docker exec $(docker ps --filter name=inari-worker -q) python -c "import pyodide; print(pyodide.__version__)"
   ```
2. **Pull audit log around the incident window.**
   ```sql
   SELECT session_id, code_hash, purpose, success, error, duration_ms
   FROM sandbox_audit_log
   WHERE created_at > now() - interval '24 hours'
     AND (success = false OR duration_ms > 5000)
   ORDER BY created_at DESC
   LIMIT 200;
   ```
3. **Sample failing inputs.** `codeHash` is SHA-256 of the source — find the corresponding AI session via `aiUsageLogId` → `ai_usage_logs.remediation_session_id`. If multiple hashes correlate to the same tool call shape, it is likely one attacker/source — not a distributed exploit.
4. **Compare against the CVE PoC.** If upstream has a public PoC, run it in a throwaway Hetzner shell (NEVER in prod) against the same Deno/Pyodide version to confirm reproduction.

---

## Recovery

1. **Patch the runtime.** Bump Deno/Pyodide version in the worker image.
   ```bash
   # In worker/Dockerfile — update the base image tag
   # Edit, commit, push, deploy-worker
   ```
2. **Re-enable sandbox in a contained cohort.** Set `SANDBOX_MODE=shadow` first (runs the sandbox but does not block remediation on its result). Watch `sandbox_audit_log.success` for 1 hour.
3. **Promote to `SANDBOX_MODE=enforce` only after:**
   - 0 new `success=false` rows under realistic traffic.
   - Verify the CVE PoC no longer reproduces on the patched runtime.
   - Post-incident review approves.

---

## Customer communication

- **Status page:** add incident to `status.inariwatch.com` as SEV-1 **only if** we observed actual customer impact (remediation failures during the window). If it was purely a precautionary disable, mark as "Maintenance — hardening".
- **Affected workspaces:** none directly — sandbox off simply means remediation takes the legacy path. Do NOT email customers unless evidence of exploitation.

---

## Post-incident review checklist

- [ ] Root cause documented (CVE ID, upstream advisory link, affected versions, our version).
- [ ] `sandbox_audit_log` rows during the window preserved (do not prune).
- [ ] Patched runtime version recorded in `project_managed_agents.md` or equivalent memory.
- [ ] Add a regression test to `web/lib/chaos/__tests__/` if the CVE shape can be modeled.
- [ ] Consider a new k6 scenario under `k6/scenarios/` if the attack is reproducible via HTTP.
- [ ] Update this runbook with anything that was unclear during the response.

---

## Related

- Rollback playbook: `web/docs/migration-vercel-to-hetzner.md` (app-level rollback mechanics).
- Sandbox architecture: `lib/ai/codeact-sandbox.ts` + `worker/src/sandbox/`.
- Security ref: `SECURITY_AND_COMPLIANCE_ROADMAP.md` (Section 4 — sandbox hardening).
