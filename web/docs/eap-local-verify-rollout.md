# EAP Local Signature Verification — Shadow Rollout

**Scope:** Move Gate 6 (`eap_chain_verified`) off the EAP server's self-reported `verification.all_signatures_valid` and onto an in-process Ed25519 check against a pinned attestor public key.

**Status:** Code shipped, feature flag OFF in prod. This doc is the runbook to flip it on safely.

---

## What changed

1. **Rust (`orbita-pos/eap`)**
   - New `GET /attestor` endpoint returns `{ key_available, public_key, key_id, attestor_name, algorithm }`.
   - `POST /receipts/from-events` response now surfaces `signature`, `public_key`, `key_id` alongside the existing fields (additive).
   - `eap-receipt` exports `derive_key_id(pubkey_hex)` and an `AttestorKeyPair::key_id()` method (16 hex chars = SHA-256(pubkey_bytes)[0..8]).

2. **TS (`web/`)**
   - `web/lib/services/eap-verify-local.ts` — native Node Ed25519 verify, Redis-cached attestor pin (24h TTL), canonical-JSON Merkle recompute (CVE-2012-2459 safe), structured logs.
   - `web/lib/services/eap-attestation.service.ts` now persists the raw signature hex to `eap_receipts.signature` (previously always wrote null).
   - `web/app/api/eap/verify/[receiptId]/route.ts` — on-first-hit fire-and-forget `verifyAndPersist` when flag on + signature present + `verified IS NULL`. Also surfaces `verified` in the JSON response.
   - `web/app/api/cron/eap-verify-sweep/route.ts` — hourly backfill, batch 200, 1h grace window.

3. **Schema** — no migration required. `eap_receipts.verified` / `.verified_at` columns already existed from migration 0070 (Fase 11).

---

## Env vars

| Name | Required? | Notes |
|---|---|---|
| `EAP_LOCAL_VERIFY_ENABLED` | new | `"true"` to activate. Default off. |
| `EAP_SERVER_URL` | existing | Already set in prod (`https://eap.staging.inariwatch.com`). |
| `EAP_API_KEY` | existing | Write-path auth only. `/attestor` is public. |
| `REDIS_HOST` + `REDIS_PASSWORD` | existing | Attestor info cached here — falls back to per-call network if Redis down. |
| `CRON_SECRET` | existing | Required for `/api/cron/eap-verify-sweep`. |
| `CRON_HEALTH_URL_EAP-VERIFY-SWEEP` | optional | Paste a Sentry Cron / Healthchecks.io URL to monitor the cron. |

---

## Rollout plan

**Day 0 — Ship code**
- [x] Merge. Deploy. Flag stays `false`.
- [x] Verify `GET /attestor` on staging EAP server returns `key_available=true` with a 64-hex `public_key`.
- [x] Verify a fresh `POST /receipts/from-events` response now carries `signature`, `public_key`, `key_id`.
- [x] Confirm no regression on existing tests: `npx vitest run app/api/eap/verify`, `lib/services/__tests__/eap-attestation.test.ts`.

**Day 1 — Register cron**
- [ ] Add to Hetzner Go scheduler: `*/15 * * * * → GET /api/cron/eap-verify-sweep` with `Authorization: Bearer $CRON_SECRET`.
  - Recommended slot: `15 * * * *` (hourly at :15, outside the top-of-hour digest window).
- [ ] Flag still off → cron returns `{ ok: true, stats: { scanned: 0, ... } }`. Confirm.

**Day 2 — Shadow on staging**
- [ ] Set `EAP_LOCAL_VERIFY_ENABLED=true` in the staging Kamal secrets.
- [ ] Watch structured logs for 24h: `eventname=eap_verify_local`.
  - Acceptance: ≥99.9% agreement rate between local verdict and upstream `verification.all_signatures_valid` across all hit receipts.
  - SLO target: p95 verify duration < 10ms (cold: first /attestor fetch, ~50–200ms; warm: <2ms).
- [ ] Run the sweep manually once: `curl -H "Authorization: Bearer $CRON_SECRET" $STAGING_URL/api/cron/eap-verify-sweep`. Expect `stats.scanned > 0` if mirror has pre-flag receipts.

**Day 3 — Activate in prod**
- [ ] Set `EAP_LOCAL_VERIFY_ENABLED=true` in prod Kamal secrets.
- [ ] Do NOT change `auto-merge-gates.ts` — Gate 6 still reads `remediationContext.eapReceipt?.verified` from the context-gatherer, which keeps pulling `verification.all_signatures_valid` from upstream. That's the current source of truth.
- [ ] Local-verify runs in the background as a shadow signal. Add a dashboard widget in `/admin/ops` that cross-checks upstream vs local and alerts on disagreement > 0.1%.

**Day 10 — Promote local verdict to Gate 6 source of truth**
- [ ] In `context-gatherer.ts`, update the eap branch to prefer `eap_receipts.verified` (local, persisted) over `verification.all_signatures_valid` (upstream) when the local verdict exists.
- [ ] Keep upstream as fallback when mirror row is missing OR `verified IS NULL` (e.g. unsigned receipts).
- [ ] Ship. Watch Gate 6 skip-rate on `/admin/ops` for a week. Expected: skip-rate unchanged (flag was already shadow-running the same verdict).

---

## Rollback

**Fastest rollback — flag flip (no deploy):**
```
kamal env push EAP_LOCAL_VERIFY_ENABLED=false
```
The helper short-circuits at the top of `verifyReceiptLocally()` and emits `reason=disabled`. The cron becomes a no-op. On-first-hit stops firing. The endpoint keeps returning mirror data unchanged (Gate 6 falls back to upstream).

**Full rollback — revert merge:**
The change is additive. Reverting removes:
- Two new tests files.
- `web/lib/services/eap-verify-local.ts`.
- The on-first-hit block in `/api/eap/verify/[receiptId]/route.ts`.
- `/api/cron/eap-verify-sweep/route.ts`.
- The three extra fields on `POST /receipts/from-events` response (Rust — safe to drop since no client requires them yet).

`eap_receipts.signature` writes stay (schema unchanged). No data cleanup needed.

---

## Monitoring

**Structured events** (one per local verify, one per cron tick):

```json
{"eventname":"eap_verify_local","receipt_id":"ab…","verified":true,"key_id":"0123456789abcdef","duration_ms":1}
{"event":"cron_eap-verify-sweep","ok":true,"flag":true,"scanned":42,"verified":41,"failed":1,"skipped":0,"durationMs":73}
```

**Alerts to configure:**
- Cron failure: any `event=cron_eap-verify-sweep AND ok=false` in 2h.
- Verdict disagreement: >0.1% of `eap_verify_local` events with `verified=false AND reason=signature-invalid` over a 1h window (suggests key rotation happened without a mirror refresh, or the sig/pubkey columns are stale).
- Cache miss loop: >5% of verify calls that round-trip `/attestor` (indicates Redis is down or TTL too short). Derived from counting `/attestor` fetch logs vs `eap_verify_local` events.

---

## Gotchas

- **Key rotation**: if the EAP attestor key is rotated, the Redis cache entry under `eap:attestor:current:<url-hash>` must be invalidated (`del` that key) or waited out (24h TTL). Old receipts signed with the previous key will fail local verify with `reason=pubkey-mismatch` until we ship per-key_id storage (deferred until rotation becomes a real operational event).
- **Clock skew between web and EAP**: irrelevant — verification is content-addressed, not time-based.
- **Canonical JSON parity with Rust**: the TS Merkle recompute relies on `canonicalJsonStringify` producing byte-identical output to `serde_json::to_vec(&serde_json::to_value(&event))`. If a future substrate event type introduces a non-`BTreeMap`-serialized field (e.g. floats in locale-specific form), the Merkle check will fail even for valid receipts. Backstop: the helper gracefully treats `merkle-mismatch` as a persistable `verified=false`, not a crash, so a bad event shape only affects that one receipt's gate — not the whole pipeline.
- **Unsigned receipts**: when the EAP server runs without an attestor key (`key_available=false`), all receipts come back with `signature=null`. Local verify returns `reason=unsigned` and `persistVerificationOutcome` treats that as non-persistable — the receipt's `verified` column stays NULL forever (correct: there's nothing to verify).
