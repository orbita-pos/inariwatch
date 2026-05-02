# Inari Live v0.3 — AI Router Track HANDOFF

**Status:** Sessions PENDING — start after v0.2 S31 (unsigned pipeline) finishes. S32 (waitlist + R2 distribution) can run **in parallel** in a separate worktree.
**SSOT:** `INARI_AI_ARCHITECTURE.md` (LOCKED 2026-05-02). Read it before any session in this track.
**Goal:** Kill the AI Frankenstein. Replace 5+ ad-hoc per-surface AI implementations with ONE router (`packages/ai-router/`) consumed by web, desktop / Inari Live, CLI, capture SDKs, and MCP. Land local AI on user's box for the "how to say it" surfaces (notifications, voice, conversational chat).
**Total budget:** 7 sessions / ~40h efectivas.

---

## Strategic frame (locked — do NOT relitigate inside sessions)

The thesis (per `INARI_AI_ARCHITECTURE.md` §1):
- **Cloud (GPT/Claude/Groq) = "qué hacer"** — code fix, agent loop, gates, security scan, technical RCA. Where being correct matters more than privacy/cost.
- **Local (Llama/Qwen/Piper) = "cómo decirlo"** — email/Slack/Telegram/WhatsApp/push/voice/status-page/postmortem-prose/dock-chat-conversational. Where natural tone + privacy + latency + cost matter more than reasoning depth.

The product line (locked):
> InariWatch usa GPT para arreglar tu código. Tus alertas se componen en tu máquina. Cada acción es criptográficamente verificable.

The lockdown rule (active after S1):
- ❌ NO file outside `packages/ai-router/src/providers/` may import `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@google/generative-ai`, `grok-sdk`, etc.
- ❌ NO new AI feature without first defining its task in `packages/ai-router/src/tasks.ts` + a routing rule in `rules.ts`.
- ❌ Rust: NO direct `reqwest` calls to OpenAI/Anthropic endpoints outside `crates/ai-router-rs/`.
- ESLint custom rule + `cargo deny` enforce this in CI.

---

## Build performance constraints (LOCKED — every session follows)

Same as v0.2. Per `project_machine_constraints.md`:
- `CARGO_BUILD_JOBS=2` — never higher (Hetzner-builder safety + local 16 GB RAM ceiling)
- `RUST_TEST_THREADS=1` — serial (test isolation + memory)
- `CARGO_INCREMENTAL=1`
- **Shared `CARGO_TARGET_DIR=C:\Users\jesus\.cargo\target-shared`** — USER env var, persisted via setx. Saves ~33 GB across worktrees. Never per-project, serial-only across worktrees.
- Defender exclusion script applied to source dirs + shared target.
- Disk discipline: keep `C:` free space > 5 GB at all times. If < 5 GB, clear `target-shared/debug/incremental/` before continuing.
- Worktree discipline (per `feedback_parallel_sessions_need_worktrees.md`): every session creates `git worktree add ../radar-v0.3-sN feat/inari-live-v0.3-sessionN-<slug>` BEFORE coding. Never share the radar checkout across windows.

---

## Parallelization graph (max 2 worktrees concurrent)

```
                       v0.3 S1 (router scaffold + web wire)
                          │
                          │ MUST land first; everything depends on dispatch()
                          ▼
                       v0.3 S2 (WS relay infra)   ◄───────────  PARALLEL OK with S6
                          │
                          ▼
                       v0.3 S3 (first task: notify.compose.email + eval harness)
                          │
                          │ unlocks notify.* migrations
                          ▼
              ┌───────────┴───────────┐
              │                       │
         v0.3 S4               v0.3 S5
       (rest of            (WhatsApp Cloud API
        notify.*)           + Piper TTS voice)
              │                       │
              └───────────┬───────────┘
                          │
                          ▼
                       v0.3 S6 (Capture embedded redact)  ← can start after S1 actually
                          │
                          ▼
                       v0.3 S7 (CLI + MCP integration + cargo-deny CI)
                          │
                          ▼
                       v0.3 closed — Frankenstein dead
```

**Parallel-friendly pairs (always 2 worktrees max):**
- S2 + S6 (relay infra ⊥ Capture embedded — different surfaces)
- S4 + S5 (notify migrations ⊥ new voice/WhatsApp surfaces)

**Strictly serial:**
- S1 → everything (router must exist first)
- S3 → S4, S5 (eval harness needed before bulk migration)
- S7 → all (closes the loop)

---

## Sessions

### v0.3 S1 — Router scaffold + wire `web/lib/ai/*` (6h) — **NO BEHAVIOR CHANGE**

**Status:** **DONE-2026-05-02** (worktree `../radar-v0.3-s1`, branch `feat/inari-live-v0.3-session1-router-scaffold`, NOT pushed).

What shipped:
- `packages/ai-router/` — full taxonomy (30 tasks across 7 namespaces), Phase-1 cloud-only rules, dispatch core (`complete` / `tool-use` / `vision` / `embed` modes with temperature + jsonMode + dimensions support), 6 cloud provider adapters (anthropic, openai with Responses API for GPT-5.x, grok, groq, deepseek, google), user-sidecar S2-stub, EAP receipt sink registry.
- `web/lib/ai/client.ts` rewritten as a thin shim over `@inariwatch/ai-router` — preserves the legacy `callAI` / `callAIWithTools` / `callAIVision` / `callAIEmbed` API + InariLens telemetry. The ~14 callers in `web/lib/ai/*` route through `dispatch()` transparently. `callAIWithTools` and `callAIVision` use `dispatch()` directly so per-turn usage attribution survives.
- ESLint custom rule `inariwatch/no-direct-ai-sdk-import` enforces the lockdown — blocks SDK imports + raw provider URL fetches anywhere outside `packages/ai-router/src/providers/`. Wired via `web/eslint.config.mjs` + `npm run lint`. CI workflow `.github/workflows/ai-router-ci.yml` runs lint + router unit tests on every PR/main push touching `web/` or `packages/ai-router/`.
- 5 documented carve-outs (chat streaming, key validation, Graders, Managed Agents beta, chaos fault-injection test) carry per-file `eslint-disable` lines + tracked S2 follow-ups inline. Zero SDK imports anywhere; provider URLs live exclusively inside the allowlist + the documented exceptions.
- 4 vitest suites under `packages/ai-router/src/__tests__/`: `tasks.test.ts` (taxonomy invariants), `rules.test.ts` (Phase-1 cloud routing + workspace overrides), `dispatch.test.ts` (routing, fallback, receipt emission, parity, tool-use translation), `lockdown.test.ts` (RuleTester valid/invalid fixtures).
- Smoke harness `web/scripts/smoke-router.ts` — exercises 3 representative flows against staging when `PLATFORM_AI_KEY` is set.

Acceptance audit:
- `grep -r "from \"openai\"" web/ desktop/ cli/ packages/ --include="*.ts"` → only matches inside the router test fixtures. ZERO real SDK imports anywhere.
- Provider URL grep → 5 files outside `packages/ai-router/src/providers/`, each with documented `eslint-disable` + S2 follow-up tracker.

Outstanding (NOT-PUSHED handoff items):
- `npm install` in `web/` is not refreshed — verify path alias + vitest alias resolve in your local environment before running tests.
- Phase-2 follow-ups for the 5 carve-outs: streaming dispatch (`mode: "stream"`), provider key validation, Graders endpoint, Managed Agents beta migration, chaos fault-injection isolation helper.
- EAP receipt mirror table — Phase 1 emits in-memory only (sink registry); the persistent `ai_router_receipts` table lands in S3 along with `/admin/ops` widget.

**Predecessor:** v0.2 S31 (unsigned pipeline) merged into integration. v0.2 S32 may be in-flight in parallel worktree — does NOT block.
**Worktree:** `git worktree add ../radar-v0.3-s1 -b feat/inari-live-v0.3-session1-router-scaffold`

**Goal:**
Create `packages/ai-router/` workspace package. Define task taxonomy + routing rules + dispatch function + adapters for the 6 cloud providers currently in use. Refactor `web/lib/ai/*` to call `dispatch()` instead of provider SDKs directly. Initial routing rules send EVERYTHING to cloud — zero behavior change. Add ESLint rule that blocks future direct provider imports.

**Work:**
1. Create `packages/ai-router/` with `package.json` (workspace:*, NOT published — `"private": true`).
2. Implement `src/tasks.ts` — full enum from `INARI_AI_ARCHITECTURE.md` §5 (~30 task types, all 7 namespaces).
3. Implement `src/rules.ts` — routing config. Initial state: every task → `{ substrate: "cloud", provider: <existing-provider-for-that-task> }`. Document via TS types + JSDoc.
4. Implement `src/providers/{openai,anthropic,groq,google,grok,deepseek}.ts` — each is the ONLY file in the repo that imports its respective SDK. Each exports a `run(task, payload, opts) → response` function.
5. Implement `src/dispatch.ts` — the public `dispatch({ task, payload, workspace, hints })` function. Reads rule, picks provider adapter, runs, returns. Includes timing, error handling, fallback to secondary provider per rule.
6. Implement `src/receipts.ts` — emit EAP receipt for every dispatch (signs with cloud key for now; user-key path comes in S2). Reuses existing `eap_receipts` infra.
7. Implement `src/lockdown/eslint-rule.js` — custom ESLint rule `inariwatch/no-direct-ai-sdk-import` that errors when any file outside `packages/ai-router/src/providers/` imports `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@google/generative-ai`, `grok-sdk`, `@deepseek/sdk`, etc.
8. Wire web's existing AI calls — refactor each of the ~14 files in `web/lib/ai/*` (per `INARI_AI_ARCHITECTURE.md` §8) to call `dispatch()` instead of provider SDKs directly. Same prompts, same models, same outputs. Verify via existing tests.
9. Add ESLint config to `web/.eslintrc.json` (or `eslint.config.mjs`) loading the custom rule + adding it to the standard ruleset.
10. Add the rule to CI (`.github/workflows/ci.yml` or whatever exists) — fails build on violation.

**Tests required:**
- New: `packages/ai-router/src/__tests__/dispatch.test.ts` — verifies routing, fallback, timing, receipt emission. Mock provider adapters.
- New: `packages/ai-router/src/__tests__/lockdown.test.ts` — verifies the ESLint rule catches a synthetic violation.
- Existing: ALL `web/` tests must pass unchanged. The refactor is invisible — same prompts, same models, same outputs.
- Smoke: run a real AI call against staging (e.g., `pnpm tsx scripts/smoke-router.ts`) — verifies end-to-end before merge.

**Acceptance criteria:**
- `pnpm test` from repo root passes (web + new router package).
- `pnpm lint` passes including the new lockdown rule.
- Grep audit: `grep -r "from \"openai\"" web/ desktop/ cli/ --exclude-dir=node_modules` returns zero matches **outside** `packages/ai-router/src/providers/`.
- Behavior parity check: pick 5 representative AI flows (auto-analyze an alert, run a remediation single-shot, compose an email, generate a postmortem, run risk-assessment) and verify outputs are byte-identical or semantically identical to pre-refactor.
- One end-to-end smoke against staging passes.

**Notes for S2:**
- S1 ships with cloud-only routing. S2 adds the WS relay so cloud can dispatch to user's box.
- S1 ships ESLint enforcement. S2 will add the cargo-deny equivalent for Rust crates (only after `crates/ai-router-rs/` exists in S7).
- `packages/ai-router/src/providers/user-sidecar.ts` is a stub returning "not implemented" until S2.

**Risks:**
- The ~14 files in `web/lib/ai/*` have implicit prompt+model+stream coupling. If the dispatch interface is too narrow, some flows (streaming, tool-use, structured outputs) won't fit. Mitigation: design `dispatch()` to accept a `mode: "complete" | "stream" | "tool-use" | "structured"` discriminator and return matching response shapes from day one.
- BYOK path (workspace's own API key) must continue to work transparently. Read existing `apiKeys` table and pass through router. Document in §13.4 of architecture.

---

### v0.3 S2 — WS relay (`relay.inariwatch.com`) (6h)

**Status:** DONE-2026-05-02 (NOT PUSHED, NOT DEPLOYED). Code-complete on
`feat/inari-live-v0.3-session2-ws-relay` in worktree `../radar-v0.3-s2`.
Tests: 19 Go, 11 Rust, 33 TS — all passing locally. Real Hetzner deploy
deferred to Jesus (Caddyfile snippet + systemd unit + binary rsync — see
`services/relay/README.md` for the runbook).

**Built (per architecture §4):**
- `services/relay/` — Go service on :9402. Endpoints: `/health` (public),
  `/ws` (JWT-authed WS upgrade), `/dispatch` (Bearer-authed
  server→server), `/admin/connections` (snapshot for `/admin/ops`).
  Stateless beyond connection tracking, no payload logs.
- `services/relay/deploy/caddy.snippet` — `wss://relay.inariwatch.com →
  127.0.0.1:9402` with CF Origin Cert + 1h read/write timeouts for WS.
- `services/relay/deploy/inari-relay.service` — systemd unit (drop-in
  pattern matching inari-staging + inari-worker per
  `project_hetzner_deploy.md`).
- `desktop/src-tauri/src/relay_client.rs` — Inari Live registers on app
  start, exponential backoff reconnect (1s → 30s ±20% jitter), surfaces
  `RelayState` to the frontend. Stub dispatch handler responds
  `{ stub: true }` until S3 wires real `notify.compose.email`.
- `packages/ai-router/src/providers/user-sidecar.ts` — replaces S1 stub.
  POSTs to relay `/dispatch` with `RELAY_DISPATCH_SECRET` Bearer; 2s
  timeout; maps relay 503/504 to `sidecar-offline`/`sidecar-timeout`/
  `sidecar-disconnect` so dispatch core's `shouldFallback()` picks them
  up. Strips `apiKey` before send (architecture §4.5).
- `packages/ai-router/src/providers/relay.ts` — internal HTTP helper
  (single 100ms retry on transient network failures).
- `packages/ai-router/src/dispatch.ts` — wires `setActiveSidecarUser`
  around the sidecar runner; emits `relayPath="relay"` +
  `userSidecarReceipt` (Ed25519, signed by sidecar — web persists
  without re-signing per S27/S28 chain).
- `packages/ai-router/src/receipts.ts` — `RouterReceipt` gains
  `userSidecarReceipt?: unknown`.
- `web/lib/relay/jwt.ts` — HS256 JWT signer. Same key derivation as Go
  (`SHA-256("inariwatch-relay-jwt:" || INARI_LIVE_RELAY_JWT_KEY)`).
- `web/app/(dashboard)/admin/ops/widgets/relay.tsx` — new ops widget
  (count, by OS, by app version, stalest last-seen). Auth via
  `RELAY_DISPATCH_SECRET` server-side; secret never reaches the browser.
- `web/scripts/smoke-relay.ts` — end-to-end smoke (USER_ID=demo
  `npx tsx scripts/smoke-relay.ts`).
- `web/.env.example` — documents `RELAY_URL`, `RELAY_DISPATCH_SECRET`,
  `INARI_LIVE_RELAY_JWT_KEY` (all optional; unset = transparent
  fallback to cloud).

**Tests passing locally:**
- Go (`services/relay/`): 19 tests — JWT auth (valid/expired/bad-alg/
  bad-sig/missing-sub/malformed/header-vs-query), dispatch routing
  (online/offline/disconnect/timeout/bad-bearer), admin endpoint,
  ctx-cancel.
- Rust (`desktop/src-tauri/`): 11 tests — backoff progression + reset,
  capability surface, dispatch frame deserialization, register frame
  meta, RelayState serde, ws_url construction, stub response contract.
- TS (`packages/ai-router/`): 33 tests — full S1 suite (pulled in S1's
  uncommitted `pickProvider` fix to keep dispatch.test.ts green) +
  13 new user-sidecar provider tests covering happy path, error
  mapping for fallback contract, unsupported modes, receipt drainage.

**Real deploy (Jesus drives, NOT done in S2):**
1. `rsync` `services/relay/inari-relay` (build with
   `GOOS=linux GOARCH=amd64 go build -o inari-relay .`) to
   `/opt/inari-relay/inari-relay`.
2. Drop systemd unit at `/etc/systemd/system/inari-relay.service` and
   env at `/opt/inari-relay/.env` (sops-encrypted —
   `RELAY_DISPATCH_SECRET` and `INARI_LIVE_RELAY_JWT_KEY` from
   `openssl rand -hex 32`).
3. Append `services/relay/deploy/caddy.snippet` to the Hetzner Caddyfile
   and `caddy reload`. Confirm CF "Preserve Authorization Header" is on.
4. Set `RELAY_URL`, `RELAY_DISPATCH_SECRET`, `INARI_LIVE_RELAY_JWT_KEY`
   in web's Kamal env (sops). Web is inert until set — feature degrades
   gracefully (router falls back to cloud per existing rules).
5. Smoke: `curl -s https://relay.inariwatch.com/health`, then run
   `USER_ID=… npx tsx web/scripts/smoke-relay.ts` after first sidecar
   connects.

**Predecessor:** v0.3 S1 merged.
**Worktree:** `git worktree add ../radar-v0.3-s2 -b feat/inari-live-v0.3-session2-ws-relay`

**Goal:**
Build the WebSocket relay infrastructure that lets the InariWatch cloud dispatch tasks to the user's local Inari Live sidecar. Deploy on Hetzner alongside the existing Go staging server. Land Inari Live registration on boot. Add `user-sidecar` provider to the router (S1 stub becomes real).

**Work:**
1. Create `services/relay/` (Go service) — `main.go` + `auth.go` + `ws.go` + `dispatch.go`.
2. Implement WS handshake with JWT auth: on connection, validate `Authorization: Bearer <jwt>` header (signed by web's `NEXTAUTH_SECRET` derived key), extract `user_id`, scope connection.
3. Implement registration: client (Inari Live) sends `register({ user_id, capabilities: ["notify.compose.*", "voice.tts", "chat.conversational", "redact.*"] })` on connect. Relay tracks online users in-memory (Redis-backed for multi-instance later, but in-memory is fine for v0.1).
4. Implement dispatch endpoint (HTTP, server-to-server only): web `POST /dispatch` with `{ user_id, task, payload }` → relay forwards over WS to target user's connection → response streams back. Auth via `RELAY_DISPATCH_SECRET` shared with web.
5. Add Caddy config snippet to route `wss://relay.inariwatch.com` → `:9402` (or whatever port). Update Hetzner Caddyfile.
6. Add Inari Live boot-time registration: `desktop/src-tauri/src/relay_client.rs` — connects on app start, reconnects on drop, sends `register` with capabilities.
7. Add `packages/ai-router/src/providers/user-sidecar.ts` — replaces S1 stub. Sends task to relay HTTP endpoint, awaits response. 2-second timeout → fallback to cloud (per S1's fallback machinery).
8. Add `packages/ai-router/src/providers/relay.ts` — internal helper that web uses to reach relay (HTTP server-to-server, signed with `RELAY_DISPATCH_SECRET`).
9. Update Inari Live receipt emission: dispatches that ran on user-sidecar sign receipts with the user's local Ed25519 key (S27 chain), not the cloud key.
10. Add monitoring: `/admin/ops` widget showing relay connections (count, by region, by app version).

**Tests required:**
- New: Go relay tests — handshake auth, dispatch routing, fallback on disconnect.
- New: Rust `desktop/src-tauri/` test — relay client reconnects after drop.
- New: TS router test — `user-sidecar` provider falls back to cloud on timeout/disconnect.
- Smoke: end-to-end — start Inari Live local + invoke cloud dispatch with task `notify.compose.email` + verify response came from local sidecar (check receipt's `substrate` field).

**Acceptance criteria:**
- Relay deploys on Hetzner via existing kamal-proxy patterns. `wss://relay.inariwatch.com` reachable with valid TLS.
- Inari Live registers on boot with no user interaction. Visible in `/admin/ops` widget within 5s of app start.
- Dispatch round-trip latency < 200ms p95 on local network. < 500ms p95 over real internet.
- Fallback on disconnect within 2s, transparent to caller.
- Receipt for user-sidecar dispatches signed with user's local key, verifiable via existing `inari-verify` CLI (S28).

**Notes for S3:**
- The relay is now ready, but no rule routes anything to it yet. S3 enables the first rule.
- Relay is stateless beyond connection tracking. No payloads logged. Document in privacy page (defer marketing until Phase 4).
- E2E encryption on relay payload deferred to Phase 4 if perf budget allows (per architecture §13.1).

**Risks:**
- WS through corporate proxies sometimes blocks long-lived connections. Need fallback polling? Defer until a beta user reports it. Document the failure mode in §13.
- Hetzner WS connection limits: default 1024 concurrent. At 50 beta users, fine. At 1000+, need horizontal scaling (Redis-backed connection registry). Defer to growth phase.

---

### v0.3 S2.5 — Router follow-ups cleanup (4h)

**Status:** DONE-2026-05-02 (NOT PUSHED). Worktree `../radar-v0.3-s2.5`, branched from S2 (`2424d0c`). Pure cleanup — zero new product features, the S3 starting line is now 100% lockdown-clean.

**Predecessor:** v0.3 S2 merged.
**Worktree:** `git worktree add ../radar-v0.3-s2.5 -b feat/inari-live-v0.3-session2.5-router-followups feat/inari-live-v0.3-session2-ws-relay`

**What landed:**
1. **Streaming dispatch (`mode: "stream"`)** — `dispatchStream()` public API yields `{ delta, done, receipt? }` chunks. Native `streamComplete()` impls on all 6 cloud providers (Anthropic SSE, OpenAI Chat SSE, Grok/Groq/DeepSeek via OpenAI-compat shared, Gemini SSE). gpt-5.x throws `stream-not-supported` (Responses streaming TODO). Fallback to non-streaming `complete()` is automatic when the sentinel fires before the first delta — caller only sees one big chunk, never an error. Receipt is emitted on `done: true`.
2. **`validateKey()` per provider** — added to `ProviderAdapter`. Public `validateProviderKey(provider, key)` exported from `@inariwatch/ai-router`. Each provider hits its cheapest list-models endpoint. Empty key short-circuits without a network call. `web/app/(dashboard)/settings/ai-key-actions.ts` switched over.
3. **Persistent `ai_router_receipts` mirror** — migration **0076** (bumped from the originally-planned 0074 because `schema.ts` already informally claims that slot for an unwritten `inari_live_saves` migration). Drizzle schema entry `aiRouterReceipts`. Sink in `web/lib/ai-router/persist-receipt.ts`, idempotently registered from `web/lib/ai/client.ts` boot path. Stores substrate/provider/model/timing + raw `userSidecarReceipt` JSONB for the S27/S28 chain. `workspace_id` FKs `organizations(id)` (workspaces and organizations are the same row in this monorepo).
4. **`/admin/ops` router-receipts widget** — new server component at `web/app/(dashboard)/admin/ops/widgets/router-receipts.tsx`, fed by `GET /api/admin/router/receipts/summary` (admin-only, single round-trip with `percentile_cont`). Shows total dispatches, by-substrate p50/p95, top 5 tasks, fallback %.
5. **All 5 `eslint-disable inariwatch/no-direct-ai-sdk-import` carve-outs removed:**
   - `web/app/api/chat/route.ts` → resolved by #1 (`dispatchStream`).
   - `web/app/(dashboard)/settings/ai-key-actions.ts` → resolved by #2 (`validateProviderKey`).
   - `web/lib/ai/graders.ts` → migrated to `runGrader` (new export from `providers/openai.ts`).
   - `web/lib/ai/managed-agent.ts` → moved to `packages/ai-router/src/providers/anthropic-managed-agent.ts` (allowlisted by lockdown). The web file is now a thin shim that injects the GitHub branch verifier (the router can't import `web/lib/services/github-api`).
   - `web/lib/chaos/__tests__/integration-remediation.test.ts` → swapped raw `api.anthropic.com` fetch for synthetic `test-claude.invalid.localhost` URL — the test verifies URL-pattern fault isolation, not Claude itself.

**Tests:**
- `packages/ai-router/src/__tests__/dispatch-stream.test.ts` (new, 4 tests) — happy path SSE, complete fallback on `stream-not-supported`, mid-stream error propagation, Anthropic stream parsing.
- `packages/ai-router/src/__tests__/validate-key.test.ts` (new, 7 tests) — 200/401/network across all 6 providers + empty-key short-circuit.
- `web/lib/__tests__/persist-receipt.test.ts` (new, 4 tests) — column shape, sidecar receipt JSONB roundtrip, fallback flag, fire-and-forget swallow.
- `web/app/api/admin/router/__tests__/summary.test.ts` (new, 4 tests) — admin gating, aggregation shape, both `{rows: T[]}` and `T[]` driver variants.

**Acceptance:**
- `grep -rn "no-direct-ai-sdk-import" web/ packages/ai-router/src/ | grep -v eslint-rule.js | grep -v eslint.config.mjs | grep -v lockdown.test.ts` → zero hits (only the rule definition + its tests remain).
- `dispatchStream({ task: "chat.conversational" })` returns deltas + a final receipt against a live provider.
- `validateProviderKey("openai", "sk-bad")` returns `{ valid: false, error: "Invalid OpenAI API key…" }` immediately (no key save).
- Migration 0076 + Drizzle schema entry compile with `web/lib/db` re-exports.
- Widget renders against the summary endpoint when admin browses `/admin/ops` (data = `0` until first dispatch persists).

**Notes for S3:**
- Router is now 100% lockdown-clean. S3 can flip `notify.compose.email` to user-sidecar without worrying about any escape hatches.
- Token usage is NOT yet on `RouterReceipt` itself — `inferUsage()` in `persist-receipt` returns nulls. S3 should plumb `usage` from the dispatch result onto the receipt so /admin/ops can show real cost columns.
- Migration slot drift: 0074 was bumped to 0076 to keep the pending `0074_inari_live_saves` slot intact.

**Risks:**
- `dispatchStream` uses sync slot `setActiveSidecarUser` for sidecar dispatches. Concurrent streams to the same Node process could race — but each request is a single dispatch call and the slot is cleared in `finally`. Same pattern as S2's complete path.
- `runGrader` lives in `providers/openai.ts` (it's a fine-tune evaluation endpoint, not a chat completion). When Graders moves out of alpha and gets its own task type in `tasks.ts`, this becomes a normal provider method. Tracked, not blocking.

---

### v0.3 S3 — First local task: `notify.compose.email` + eval harness (6h)

**Status:** PENDING.
**Predecessor:** v0.3 S1 + v0.3 S2 merged.
**Worktree:** `git worktree add ../radar-v0.3-s3 -b feat/inari-live-v0.3-session3-first-local-task`

**Goal:**
Migrate the first user-visible task to local. Build the shared eval harness (used by all future task migrations) so we can quantitatively prove "local is acceptable" before each rule flip.

**Work:**
1. Build eval harness `packages/ai-router/src/eval/`:
   - `corpora/notify-compose-email/` — 200 alert objects (anonymized real production alerts) + 200 reference message bodies (human-rated by Jesus).
   - `rubrics/notify-compose-email.json` — scoring criteria: length range, required entities (alert title, severity, link), tone keywords ("we", short sentences, action verb).
   - `run.ts` — CLI runner: `pnpm tsx packages/ai-router/src/eval/run.ts task=notify.compose.email substrate=user-sidecar model=llama-3.2-3b-q4`. Outputs scoring + diff vs. cloud baseline.
2. Wire Inari Live sidecar to handle `notify.compose.email`: when relay forwards this task, sidecar runs Llama-3.2-3B Q4 (already in S21 catalogue — extend if needed) with appropriate prompt template. Streams response back.
3. Add prompt template `packages/ai-router/src/prompts/notify-compose-email.ts` — same prompt regardless of substrate. Cloud and local see same input.
4. Add workspace flag `localNotifyEnabled` to `workspaces` table (migration). Default `false`. Per-workspace opt-in.
5. Add routing rule: `notify.compose.email` → if `workspace.localNotifyEnabled === true && user has Inari Live online → user-sidecar (model: llama-3.2-3b-q4)`; else → cloud (existing behavior).
6. Add fallback observability: when fallback fires (sidecar offline/timeout), log to `ai_router_dispatches` table with reason. Surface in `/admin/ops`.
7. Add UI toggle in `web/app/(dashboard)/settings/ai-preferences/page.tsx` — "Use my local AI for notification composition (requires Inari Live)".
8. Run eval harness on cloud baseline first → record numbers. Then enable local → re-run → compare. Acceptable threshold: local ≥ 85% of cloud rubric score.

**Tests required:**
- New: `packages/ai-router/src/__tests__/eval-runner.test.ts` — verifies harness loads corpus + rubric + scores correctly.
- New: `packages/ai-router/src/__tests__/notify-compose-email.test.ts` — given a sample alert, verify routing decision matches workspace flag.
- New: integration test — flag on + simulated sidecar online → request goes to sidecar. Flag on + simulated sidecar offline → falls back to cloud.
- Eval gate: `notify.compose.email` local must score ≥ 85% of cloud baseline on the 200-alert corpus. If below, do NOT ship the rule flip — tune prompt or model first.

**Acceptance criteria:**
- Eval harness runs end-to-end against cloud + sidecar substrates.
- Local model scores ≥ 85% of cloud on the corpus rubric.
- Workspace toggle visible in Settings, defaults off.
- One real beta user flips toggle on → next alert email is composed by their local Inari Live → receipt verifiable.
- `/admin/ops` shows dispatch substrate breakdown (cloud vs sidecar) per workspace per task.

**Notes for S4:**
- The harness pattern from S3 is the template for every subsequent task migration. Each new `notify.*` task needs its own corpus + rubric + eval pass before the rule flips.
- If a model needs to be added to the registry (e.g., Llama-3.2-3B if not already there), do it in S3 — S4 should NOT touch the registry.

**Risks:**
- Llama-3.2-3B Q4 quality may not hit 85%. Mitigation: try Qwen2.5-3B-Instruct, then Llama-3.2-3B-Instruct, then larger 7B class. If 7B is the floor, accept the RAM cost (8GB) and document filter.
- Privacy claim depends on relay NOT logging payloads. Verify via Hetzner audit before public claim. Add a security review checklist item.

---

### v0.3 S4 — Rest of `notify.*` migrations (6h)

**Status:** PENDING.
**Predecessor:** v0.3 S3 merged. PARALLEL-OK with v0.3 S5.
**Worktree:** `git worktree add ../radar-v0.3-s4 -b feat/inari-live-v0.3-session4-notify-rest`

**Goal:**
Migrate `notify.compose.{slack, telegram, push, digest, status-page, postmortem-prose}` to local. Each migration follows the S3 pattern: prompt template + eval corpus + rubric + ≥ 85% gate + rule flip.

**Work:**
1. For each of {slack, telegram, push, digest, status-page, postmortem-prose}:
   - Build eval corpus (50-100 examples per task — smaller than S3's 200 for the email flagship).
   - Build rubric (channel-specific: Slack has block constraints, push has 200-char limit, postmortem-prose has section structure).
   - Add prompt template in `packages/ai-router/src/prompts/`.
   - Run eval baseline cloud → local. Gate at ≥ 85%.
   - Flip routing rule (re-uses S3 fallback machinery).
2. For Slack/Telegram: keep block layout / message structure deterministic (cloud-side code). ONLY the prose body comes from local.
3. For postmortem-prose: split the existing `web/lib/ai/postmortem.ts` flow into two phases — `code.review.security` for technical RCA (cloud) + `notify.compose.postmortem-prose` for human-facing prose (local). Wire UI to assemble both.
4. Add per-task admin panel showing eval scores + dispatch substrate ratios.

**Tests required:**
- One eval pass per task — gate at ≥ 85%.
- One integration test per task verifying routing.
- One UI smoke per task surface (Slack message renders, push notification arrives, postmortem page assembles correctly).

**Acceptance criteria:**
- All 6 sub-tasks pass eval gate.
- All 6 routing rules flipped behind same `localNotifyEnabled` workspace flag.
- Behavior unchanged for workspaces with flag off.
- One beta user with flag on confirms all 6 surfaces work.

**Notes for S5/S6:**
- `notify.compose.whatsapp` deferred to S5 (it's a NEW surface, needs WhatsApp Cloud API integration first).
- `voice.tts.*` deferred to S5 (needs Piper TTS bundling first).
- After S4, the local-AI claim is real for 7 of 8 notification surfaces (S3 + 6 here).

**Risks:**
- Channel-specific tone (Slack casual vs email formal vs status-page neutral) may need separate fine-tuning. Document per-rubric in commit messages.

---

### v0.3 S5 — WhatsApp Cloud API + voice (Piper TTS) (6h)

**Status:** PENDING.
**Predecessor:** v0.3 S3 merged. PARALLEL-OK with v0.3 S4.
**Worktree:** `git worktree add ../radar-v0.3-s5 -b feat/inari-live-v0.3-session5-whatsapp-voice`

**Goal:**
Stand up two NEW surfaces that ship local-first from day one: WhatsApp message delivery (composition local, transport cloud via WhatsApp Cloud API) and voice notifications (TTS local via Piper, playback via OS sound or Twilio call).

**Work:**
1. **WhatsApp Cloud API integration:**
   - Get Meta Business account + WhatsApp Cloud API token. Document setup in `docs/whatsapp-setup.md`.
   - Add `web/lib/notifications/whatsapp.ts` — sends messages via WhatsApp Cloud API.
   - Add task `notify.compose.whatsapp` (already in taxonomy from S1).
   - Build eval corpus (50 examples) + rubric (160-char tone, emoji usage, urgency).
   - Add settings UI — workspace can connect WhatsApp + add recipient phone numbers.
   - Add notification channel option in alert routing config.
2. **Voice (Piper TTS):**
   - Bundle Piper binary + voice models (en + es, ~50-100MB each) into Inari Live installer.
   - Add Tauri command `voice_tts(text, voice, lang) → audio_path`.
   - Add task `voice.tts.alert` + `voice.tts.digest` to router (already in taxonomy).
   - Add Inari Live setting: "Speak critical alerts out loud" (default off).
   - Trigger: critical alert arrives → local LLM composes 1-sentence summary (`notify.compose.push`) → Piper TTS → OS sound playback.
   - Optional Twilio integration for outbound calls: text composed local, audio generated local, streamed via Twilio TwiML to call user's phone (defer to v0.4 if Twilio setup is heavy).
3. Receipt emission — voice receipts include audio file hash, TTS model version, voice model used.

**Tests required:**
- WhatsApp: integration test against Meta sandbox API + receipt verification.
- Voice: Piper smoke test (text → audio file written → file plays). Manual smoke on Mac + Windows.
- Eval: WhatsApp composition ≥ 85% on rubric.

**Acceptance criteria:**
- WhatsApp message arrives on Jesus's test number with composed prose from local Inari Live.
- Voice playback works on Mac + Windows for a critical alert (en + es).
- Both surfaces ship with `localNotifyEnabled` flag — but since they're NEW, the flag isn't strictly needed (no cloud baseline to fall back to for WhatsApp/voice). Decision: ship them with the same flag for consistency, fallback to cloud Llama-on-Groq if user has no Inari Live.

**Notes for S6/S7:**
- WhatsApp/voice are the marketing centerpieces. Land them, then write the public landing page section claiming "first incident tool with WhatsApp where the message body never touches a third-party LLM" and "voice notifications composed and synthesized on your machine".
- Twilio outbound calls deferred to v0.4. v0.3 ships with OS sound playback only.

**Risks:**
- WhatsApp Cloud API approval can take 1-3 weeks. Start the application BEFORE S5 begins. Add to "things Jesus must do today" list in the prompt for S2 or earlier.
- Piper voice models add ~150MB to installer. Document the size delta. Make voice models optional download (first-run setup) if size is a concern.

---

### v0.3 S6 — Capture embedded `redact.pii.breadcrumbs` (6h)

**Status:** PENDING.
**Predecessor:** v0.3 S1 merged. PARALLEL-OK with v0.3 S2/S4/S5.
**Worktree:** `git worktree add ../radar-v0.3-s6 -b feat/inari-live-v0.3-session6-capture-embedded`

**Goal:**
Add optional in-process AI to `@inariwatch/capture` (Node SDK first) for PII redaction of breadcrumbs BEFORE they're sent to InariWatch cloud. Demonstrates the "capture-embedded" substrate from `INARI_AI_ARCHITECTURE.md` §3.

**Work:**
1. Add optional dep to `@inariwatch/capture` (Node): `onnxruntime-node` + a tiny PII-detection ONNX model (~10-50MB, e.g., a fine-tuned DistilBERT for entity recognition). Optional = devs opt in via `npm i onnxruntime-node` separately. If not installed, capture gracefully falls back to sending raw breadcrumbs.
2. Add task `redact.pii.breadcrumbs` (already in taxonomy from S1).
3. Add capture-side router shim: capture imports a minimal version of `@inariwatch/ai-router` (just `dispatch` + capture-embedded provider). Same dispatch interface, same rules format, same task names.
4. Routing rule: `redact.pii.breadcrumbs` → if capture-embedded available → embedded; else → cloud (web's redaction endpoint, also via router).
5. Cloud-side `redact.pii.breadcrumbs` endpoint: simple POST that the router can target if capture has no embedded model. Same model logic but server-side.
6. Document the optional install in `capture/README.md` — "Want PII redaction to happen on YOUR server, not ours? `npm i onnxruntime-node` and we'll do it locally."
7. Eval harness — corpus of 100 breadcrumbs with known PII (emails, names, credit-card-shaped strings, phone numbers, IPs) + rubric (recall on PII, precision against false positives).

**Tests required:**
- Unit: capture-embedded substrate detects optional dep, runs model, returns redacted breadcrumbs.
- Unit: fallback path when optional dep missing.
- Integration: end-to-end — capture in-process redacts, sends to web, web confirms redaction. Receipts on both sides verifiable.
- Eval: ≥ 90% PII recall, ≤ 5% false positive rate.

**Acceptance criteria:**
- Capture works without `onnxruntime-node` (current behavior unchanged).
- Capture with `onnxruntime-node` redacts PII before send. Verifiable via wire log.
- Public `capture/README.md` documents the privacy upgrade.
- One real Node app (e.g., InariWatch's own dogfood) opts in and verifies redacted breadcrumbs in production.

**Notes for S7:**
- S6 ports the router pattern to capture (Node first). Polyglot (Python/Go/Rust/Java/C#) capture adoption deferred to post-v0.3.
- The "tiny PII model" choice matters — it's the first model that ships INSIDE the user's Node process. Pick conservatively (10-50MB, CPU-only inference, sub-100ms per breadcrumb).

**Risks:**
- ONNX runtime binary size. `onnxruntime-node` is ~30MB. Acceptable for opt-in; would be unacceptable for required dep.
- Some environments (serverless, edge) can't run ONNX. Document the substrate matrix.

---

### v0.3 S7 — CLI Rust + MCP integration + cargo-deny lockdown (4h)

**Status:** PENDING.
**Predecessor:** v0.3 S1 merged. (Recommended: also after S2, S3 so the Rust crate has real substrates to wire.)
**Worktree:** `git worktree add ../radar-v0.3-s7 -b feat/inari-live-v0.3-session7-cli-mcp-cargo-deny`

**Goal:**
Close the loop. Build the Rust mirror crate `crates/ai-router-rs/`. Refactor CLI Rust code to use it. Refactor Inari Live sidecar to use it (replaces ad-hoc `desktop/src-tauri/.../openai_client.rs` from S18). Wire MCP. Add `cargo deny` rule banning direct provider HTTP calls outside the crate.

**Work:**
1. Create `crates/ai-router-rs/` (Rust crate, workspace member).
2. Mirror taxonomy: `src/tasks.rs` matches the TS enum 1:1 (use a shared JSON or codegen so TS + Rust stay in sync).
3. Mirror dispatch: `dispatch(task, payload, opts) → Result<Response>`.
4. Adapters: `src/adapters/llamacpp.rs` (links the existing llama.cpp from S21 sidecar), `src/adapters/http_proxy.rs` (hits web's `/api/ai/dispatch` for cloud routing — web's router handles the actual provider call).
5. Refactor Inari Live `desktop/src-tauri/src/openai_client.rs` (S18) to use `ai-router-rs` instead of direct HTTP to OpenAI. Behavior unchanged — chat streaming continues, just proxied through web's router.
6. Refactor CLI's AI calls (per `cli/src/`) to use the same crate. CLI gets local AI for free now.
7. Wire MCP: `web/app/api/mcp/` already uses `web/lib/ai/*` for `trigger_fix` (the non-sampling-first path). After S1, that's already going through the router. S7 just confirms and documents.
8. Add `deny.toml` at the workspace root with a rule denying direct HTTP calls to OpenAI/Anthropic/Groq endpoints from any crate other than `ai-router-rs`.
9. Add cargo-deny check to CI (`.github/workflows/ci.yml`).
10. Update `CLAUDE.md` AI layer section to reflect the new architecture (point to `INARI_AI_ARCHITECTURE.md` as SSOT and stop documenting per-file AI calls).

**Tests required:**
- Rust crate unit tests — adapter selection, dispatch, fallback.
- Integration: Inari Live chat (S18) still streams correctly through new path.
- Integration: CLI `inariwatch dev` AI flows still work.
- Integration: MCP `trigger_fix` still triggers remediation.
- CI: cargo-deny passes on clean tree, fails on a synthetic violation (test fixture).

**Acceptance criteria:**
- `cargo deny check` passes from repo root.
- ESLint lockdown (S1) + cargo-deny (S7) together enforce: zero direct provider imports anywhere except inside the router crate/package.
- All AI flows in the repo (web + desktop + CLI + MCP + capture-embedded) go through `dispatch()`.
- `CLAUDE.md` updated to reflect SSOT.
- Final audit grep: `rg "openai|anthropic|groq" --type ts --type rust` returns matches ONLY inside `packages/ai-router/` and `crates/ai-router-rs/`.

**Notes (closes v0.3 track):**
- Frankenstein officially dead.
- Marketing claim from `INARI_AI_ARCHITECTURE.md` §15 can now be made publicly without overclaim.
- Future AI features always start with: "1. Add task to `tasks.ts`. 2. Add rule to `rules.ts`. 3. Done." — no per-surface implementation needed.
- v0.4 horizon: BYOC (bring your own compute) — let users register their own OpenAI/Claude keys for `code.*` tasks even if they're on Pro plan. Trivial after S7 (just routing rule precedence change).

**Risks:**
- Inari Live's S18 chat streaming is sensitive to latency. Adding the router proxy hop adds ~10-30ms. Acceptable. If users complain, add direct-mode for chat (router rule routes `chat.code` directly to provider without proxy).
- `cargo deny` has known false positives with workspace deps. Test on clean tree before enabling in CI.

---

## Coordination protocol

1. **Read first, code second.** Every session starts with reading `INARI_AI_ARCHITECTURE.md` (SSOT) + this handoff's session-specific entry.
2. **Worktree-per-session.** Always `git worktree add ../radar-v0.3-sN ...` before coding. Never share the radar checkout across windows.
3. **Status block updates.** When a session ships, update its Status block in this handoff (PENDING → DONE-<date>) + add to `INARI_LIVE_DECISIONS.md` if a non-obvious choice was made.
4. **NOT pushed by default.** Per `feedback_commit_workflow.md`, sessions commit but do NOT push unless Jesus explicitly asks.
5. **Eval gate is binding.** ≥ 85% threshold on rubric. If not met, do NOT flip the routing rule. Tune prompt or model. Document the failed attempt.
6. **Receipts everywhere.** Every dispatch emits an EAP receipt regardless of substrate. If a session ships an AI call without receipt emission, it's incomplete.
7. **Lockdown is enforcement, not aspiration.** After S1 lands, ESLint rule MUST be on. After S7 lands, cargo-deny MUST be on. If a session disables them temporarily for "iteration speed", that's a regression — re-enable before merge.

---

## Total budget

| Session | Work | Hours |
|---|---|---|
| S1 | Router scaffold + wire web | 6 |
| S2 | WS relay infra | 6 |
| S3 | First local task + eval harness | 6 |
| S4 | Rest of notify.* migrations | 6 |
| S5 | WhatsApp + voice (NEW surfaces) | 6 |
| S6 | Capture embedded redact | 6 |
| S7 | CLI + MCP + cargo-deny | 4 |
| **Total** | | **40h** |

Calendarized at ~2-3 sessions/week → **~3 weeks** elapsed. Plus parallelization — S2 || S6 and S4 || S5 can overlap → **~2.5 weeks** practical.

---

## Open questions (deferred — NOT blockers)

Same as `INARI_AI_ARCHITECTURE.md` §13:
- E2E encryption on relay payload (decide in S2 design).
- Capture model bundling vs download (decide in S6).
- Mobile (Expo) AI calls via relay (defer post-v0.3).
- BYOK + local routing precedence (already documented: substrate wins for `notify.*`, BYOK wins for `code.*`).
- MCP sampling-first interaction with router (no change — sampling-first preserved).
- Cost telemetry for local substrate (S4 adds to `/admin/ops`).
- Model registry sharing — decided: same registry as Inari Live's S21 catalogue.

---

## Already shipped before v0.3 (recap)

- **v0.2 Inari Live** (S21–S30 + S33): llama.cpp runtime, LSP scaffold, Tab autocomplete (Qwen FIM), Fast Apply (Kortix), EAP receipt UI, verify CLI + web, landing page `/inari-live`, UX overhaul.
- **v0.2 ship sequence** (S31 + S32): unsigned pipeline + waitlist + R2 distribution. May be in-flight in parallel worktrees during v0.3 S1.
- **EAP chain** (S27/S28/S29): cryptographic receipts — used by router for every dispatch.
- **Inari Live sidecar** (S21): hosts the local models the router will dispatch to.
- **Hetzner infra**: Go staging server + Caddy + Redis. Relay deploys alongside.

---

**END OF HANDOFF — v0.3 starts after v0.2 S31 finishes. Read `INARI_AI_ARCHITECTURE.md` first.**
