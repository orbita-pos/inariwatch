# Year-1 Briefing — Per-Session Handoff Plan

**Status as of 2026-04-24** (commits this session — see "Already shipped this session" at the bottom).

This doc is the operating plan for the year-1 wedges from the team briefing: **Substrate v2** + **EAP v2 chain** + **Intent contracts compiler core**, plus the dependent **Replay engine** and **Replay-as-a-Service**. Each future session has a numbered, tightly-scoped objective with concrete deliverables, file paths, deps to add, and a definition of done.

The session plan is conservative on purpose: each session is sized at **~4-8 hours of focused work**, single-author, single-context-window. Splitting it that way keeps the work shippable and reviewable rather than 80-hour mega-PRs that nobody can rationally evaluate.

---

## Track 1 — Substrate v2 (5 sessions)

**Goal:** record-and-replay every non-deterministic input to a Node.js process so a recording can be replayed bit-identically against a candidate fix.

**Already shipped (Session 0 — 2026-04-24):**
- `substrate-core::EventKind` extended with v2 sources: `CryptoRandomValues`, `ProcessEnvSnapshot`, `SetTimeoutSchedule`/`Fire`, `MicrotaskScheduled`/`Drain`
- `RecordingMeta::schema_version` field added with backwards-compat default of 1
- `RECORDING_SCHEMA_VERSION = 2` constant + `Recording::schema_version_supported()` guard
- 10 tests added (`v2_event_tests` + `v2_recording_tests`), workspace-wide build verified zero regression

**Session 1 — Wire the recorder side for the 4 v2 sources (8h)**
- File: `crates/recorder/src/session.rs` and any napi-rs binding glue.
- Add hooks for: `getRandomValues`, `process.env` snapshot at session start, `setTimeout`/`setInterval` scheduling, `queueMicrotask` + Promise resolution.
- For each: emit the corresponding v2 EventKind into the ring buffer.
- Tests: record a synthetic Node script that exercises each source, assert event stream contains the expected variant + payload.
- Definition of done: `cargo test -p substrate-recorder` green, recording a trivial script produces a stream with all 4 v2 event types observed.

**Session 2 — Replay engine v2 standalone Rust crate (8h)**
- New crate: `crates/replay-engine/` (NOT in workspace yet — fresh skeleton).
- Reads a `.substrate` file, deserializes, walks events in order, intercepts the same V8 surfaces as Session 1 to RETURN recorded values instead of fresh ones.
- Out of scope this session: actual V8 patching — emit a stubbed "would have replayed X" log per event for now. Real interception is Session 3.
- Tests: `cargo test -p substrate-replay-engine` exercises the dispatcher logic only.
- Definition of done: skeleton crate compiles, deserializes a recording, walks events, emits a replay log.

**Session 3 — V8 replay interception (Date.now, Math.random, crypto only) (8h)**
- Extend Session 2 crate with napi-rs bindings that actually patch the 4 deterministic sources.
- Validate bit-identical: record a Node script, replay, capture the replayed `Date.now()` value, assert it equals the recorded value.
- Bench: replay overhead < 5% vs naive run.
- Definition of done: at least 4 sources replay bit-identical end-to-end with a passing test that records → replays → asserts SHA-256(values) equal.

**Session 4 — V8 replay for the harder sources (8h)**
- Add libuv timer ordering (replay enforces `scheduled_fire_ns` not `actual_fire_ns`), microtask queue order, `setTimeout` jitter elimination.
- Honest expectation: `libuv ordering` requires either runtime patches (use a custom Node binary) OR npm-prefix-loaded async_hooks shims. Pick one in the session and document the choice.
- Tests: a script that fires 100 timers + 100 promise resolutions in interleaved order replays in identical order.
- Definition of done: scheduling + microtask events replay deterministically across 10 consecutive runs.

**Session 5 — Replay-as-a-Service HTTP API on inari-staging (8h)**
- New file: `internal/replay/server.go` in `inari-staging`.
- Endpoints: `POST /replay/run` (body: `{recording_id, fix_branch}`) → spawns gVisor container, downloads recording, runs replay engine against the fix branch's code, returns hash equality verdict + diff if mismatch.
- `POST /replay/verify-fix` (body: `{recording_id, candidate_diff}`) → applies diff, runs replay, returns pass/fail.
- Auth: same `STAGING_API_SECRET` Bearer pattern as the rest of inari-staging.
- Wire to InariWatch web: `web/lib/ai/substrate-replay.ts` gets a new `runDeterministicReplay()` that calls these endpoints; auto-merge gate 9 reads its verdict.
- Definition of done: end-to-end verify-fix call from web → inari-staging → gVisor → replay engine → verdict, with telemetry in `/admin/ops`.

---

## Track 2 — EAP v2 chain (3 sessions)

**Goal:** every phase of an autonomous remediation session (evidence → hypothesis → fix → build → deploy → post-merge) is cryptographically attested + aggregated under one signable session root.

**Already shipped (Session 0 — 2026-04-24):**
- New module `eap/crates/receipt/src/phase.rs` (~330 LOC) with:
  - `PhaseKind` enum (6 variants: Evidence, Hypothesis, FixPatch, BuildArtifact, Deploy, PostMerge)
  - `PhaseReceipt` (content-addressed, individually signable)
  - `SessionChain` (Merkle aggregation over phase receipt IDs)
  - 11 tests covering content-addressing, tampering detection, signing, root determinism
- New endpoint `POST /receipts/phase` in `eap/crates/server/src/routes.rs` (stateless: validates → signs → returns).
- 7 integration tests in `eap/crates/server/tests/phase.rs`.
- 58/58 EAP workspace tests green.

**Session 1 — Web integration: persist phase receipts + wire hypothesis phase (6h)**
- Migration: `web/lib/db/migrations/0073_eap_phase_receipts.sql` — new column `eap_phase_receipts JSONB` on `remediationSessions` (additive, default `[]`).
- New helper: `web/lib/services/eap-phase-attestation.service.ts` — `attestPhase(sessionId, kind, payload)` calls `POST {EAP_SERVER_URL}/receipts/phase`, persists the returned PhaseReceipt to the new column.
- Wire site #1: `web/lib/ai/remediate.ts` after the hypothesis is generated — call `attestPhase(sessionId, "hypothesis", { root_cause, model, prompt_hash })`.
- Tests: unit tests for the helper (mock fetch), integration test that `runRemediation` populates the column with at least one phase.
- Definition of done: any new remediation session ends with `eap_phase_receipts` array containing at least the hypothesis phase.

**Session 2 — Wire the remaining 5 phases (6h)**
- Add attestPhase calls for evidence, fix_patch, build_artifact, deploy, post_merge.
- Build the SessionChain when the session terminates (success or fail), sign its root via `POST /receipts/phase` with kind=null+ a special chain-finalize endpoint (TBD design call: either reuse phase or add `POST /receipts/chain-finalize`).
- Tests: a full mock remediation populates 6 phase receipts + a signed chain root.
- Definition of done: end-to-end remediation produces 6 PhaseReceipts whose ordered receipt_ids hash to the SessionChain.root.

**Session 3 — Inclusion proof endpoint + UI surface (6h)**
- Server: `GET /chain/{session_id}/proof/{phase_id}` returns `{root, leaf, sibling_hashes: [...]}`.
- Web: extend `/api/eap/verify/[receiptId]` to handle phase IDs (auto-detect by length / new column), return inclusion proof when requested.
- UI: add a phase-chain visualization to the remediation session detail page (one card per phase, click to copy receipt_id, badge for signed/unsigned).
- Definition of done: a user can pull up any past session, click any phase, copy its proof, and verify it offline against the chain root.

---

## Track 3 — Intent contracts compiler (7 sessions)

**Goal:** unify TS, Python, Go, Java, Rust source code into the same Intent JSON shape so InariWatch can match patterns + classify hypotheses across languages.

**Already shipped (Session 0 — 2026-04-24):**
- New repo skeleton at `C:\Users\jesus\desktop\intent-compiler\`
- `intent-core` crate: schema (`Intent`, `Param`, `Effect`, `ErrorMode`, `Source`), content-addressable IDs via SHA-256, tampering detection. 10 tests.
- `intent-ts` crate: skeleton `parse_typescript()` returns a stub Intent (real swc parser deferred). 4 tests.
- `intent-cli` crate: dispatch-by-extension binary. Wired for TS/JS, others print error.
- `README.md` + this handoff doc explaining the per-session plan.
- 14/14 workspace tests green.

**Session 1 — TS frontend real swc impl (8h)**
- File: `intent-compiler/crates/ts/src/lib.rs` (replace skeleton).
- Add deps: `swc_common`, `swc_ecma_ast`, `swc_ecma_parser`, `swc_ecma_visit`.
- Walk the AST extracting top-level `function`, `class` methods, arrow functions assigned to const at module scope, Express `app.METHOD(path, handler)` (HttpHandler tag).
- Type strings: pretty-print TsType nodes verbatim.
- Effect detection: `await` → async, `fetch(`/`axios.` → Network, `process.env` → Read, `Date.now`/`Math.random` → Nondet, `console.` → Log, `throw new` → Throws.
- Tests: 10+ tests over fixture .ts files in `tests/fixtures/`.
- Definition of done: parsing a real fixture file produces a list of Intents matching expectations.

**Session 2 — Python frontend (tree-sitter-python) (6h)**
- New crate: `intent-compiler/crates/py/`.
- Parse via `tree-sitter` + `tree-sitter-python`. Extract `def`/`async def` + class methods + `@app.route` decorators (Flask) / FastAPI route decorators.
- Tests: 8+ tests over fixture .py files.
- Definition of done: same shape Intents from .py as from .ts for equivalent code.

**Session 3 — Go frontend (go/parser via cgo or external go binary) (6h)**
- Decide: cgo bindings (more deps) vs spawning `go ast-print` subprocess (simpler).
- Recommendation: subprocess approach using `go run cmd/intent-ast-helper.go`. Ships a tiny Go helper alongside.
- Definition of done: parse simple .go files producing equivalent Intents.

**Session 4 — Rust frontend (syn) (6h)**
- New crate: `intent-compiler/crates/rs/` using `syn` for parsing.
- Tests: parse intent-core's own lib.rs and assert at least one Intent for `Intent::compute_id`.
- Definition of done: dogfood — `intent-cli intent-compiler/crates/core/src/lib.rs` produces valid Intents.

**Session 5 — Java frontend (8h)**
- Java is the hardest because there's no good pure-Rust Java parser. Two options:
  - (A) Spawn a small Java helper jar that prints AST as JSON, Rust reads stdout.
  - (B) Use tree-sitter-java (less precise type info but no JVM dependency).
- Pick (A) for type fidelity; document the JVM dependency.
- Definition of done: parse simple .java files producing equivalent Intents.

**Session 6 — intent-server HTTP service + Redis cache (6h)**
- New crate: `intent-compiler/crates/server/`.
- Endpoint: `POST /parse` body `{path, code}` → returns Intents JSON.
- Endpoint: `POST /parse-batch` for multi-file requests.
- Cache: keyed by SHA-256(path + code), 24h TTL, Upstash Redis (use the same `UPSTASH_REDIS_REST_URL` pattern as InariWatch web).
- Definition of done: deployable binary with health check; Docker image builds; can serve N concurrent parse requests with cache hits visible in Redis.

**Session 7 — InariWatch web TS bindings + RCA-Net wiring (4h)**
- File: `web/lib/services/intent.service.ts` — calls intent-server.
- Use site: hypothesis tier classifier — when the AI generates a hypothesis pointing to a specific function, fetch its Intent + cross-reference with similar Intents in the corpus to find prior fixes.
- Tests: integration test mocking intent-server, asserting hypothesis classifier returns the expected tier.
- Definition of done: at least one tier-classification decision in production references an Intent ID.

---

## Track 4 — Replay engine + Replay-as-a-Service standalone (covered in Track 1 sessions 2, 3, 4, 5)

This was listed separately in the briefing but is the natural continuation of Substrate v2 — keeping it under Track 1 avoids artificial split. If the team prefers a separate owner, sessions 2-5 of Track 1 can be reassigned without other changes.

---

## Cross-cutting work (post-Track work, ~3 sessions)

**Session A — Auto-merge gate integration (4h)**
- Wire `eap_chain_verified` (gate 6) to validate the SessionChain root locally (extending the EAP local verify shipped 2026-04-24).
- Wire `substrate_replay` (gate 9) to require deterministic-replay verdict from Replay-as-a-Service.
- Tests: gate behavior under green chain, tampered chain, missing replay verdict.

**Session B — End-to-end dogfood: one real remediation produces all artifacts (4h)**
- Run a real (non-mock) remediation against InariWatch's own codebase.
- Verify: 6 PhaseReceipts created + signed; SessionChain root persisted + signed; deterministic replay verdict on the fix branch; Intent JSON for the changed function attached to the session.
- Document the trace ID for the team's first verifiable autonomous remediation.

**Session C — Telemetry + Ops widgets (3h)**
- /admin/ops: add `EapChainHealth` widget (chains/day, signed %, integrity failures), `ReplayVerdict` widget (pass/fail rate, p50 latency), `IntentCoverage` widget (% of repo functions parsed).
- Definition of done: 3 new widgets live on /admin/ops.

---

## Total budget

| Track | Sessions | Hours |
|---|---|---|
| Substrate v2 + Replay-as-a-Service | 5 | 40 |
| EAP v2 chain | 3 | 18 |
| Intent compiler | 7 | 44 |
| Cross-cutting | 3 | 11 |
| **TOTAL** | **18** | **~113** |

Add 25-30% slack for interrupts, debugging the inevitable swc/syn/V8 ABI mismatch, and gVisor sandbox drift = realistic **~145 hours** = roughly **18-25 working days** of single-author effort.

---

## Already shipped this session (2026-04-24)

| Wedge | Commit / Path | Tests |
|---|---|---|
| Substrate v2 schema foundations | `Substrate/crates/core/src/event.rs`, `recording.rs` | 10/10 ✓ |
| EAP v2 chain types + endpoint | `EAP/crates/receipt/src/phase.rs`, `EAP/crates/server/src/routes.rs::submit_phase`, `EAP/crates/server/tests/phase.rs` | 18/18 (11 phase + 7 endpoint) ✓ |
| Intent compiler skeleton | `intent-compiler/` (new repo, 3 crates) | 14/14 ✓ |
| **TOTAL new tests this session** |  | **42/42 ✓** |

(In addition to the 68/68 EAP local-verify tests already shipped earlier on 2026-04-24 in the prior task — see `project_eap_local_verify.md` in memory.)

NOT pushed to remotes yet — left staged locally in each repo for explicit review before deploy. See "Status snapshot" below for the exact `git status` of each.

---

## Status snapshot

```
Substrate (master):
  M  crates/core/src/event.rs       — 4 new EventKind variants + tests
  M  crates/core/src/recording.rs   — RECORDING_SCHEMA_VERSION + schema_version field + tests
  M  crates/core/src/lib.rs         — re-export

EAP (master):
  M  crates/receipt/src/lib.rs      — re-export phase module
  ?? crates/receipt/src/phase.rs    — PhaseKind, PhaseReceipt, SessionChain, 11 tests
  M  crates/server/src/lib.rs       — register POST /receipts/phase
  M  crates/server/src/routes.rs    — submit_phase handler + PhaseInput struct
  ?? crates/server/tests/phase.rs   — 7 integration tests

intent-compiler (NEW REPO at C:\Users\jesus\desktop\intent-compiler):
  ?? Cargo.toml                     — workspace manifest
  ?? README.md                      — schema + roadmap
  ?? crates/core/                   — Intent + Param + Effect + Source schema, 10 tests
  ?? crates/ts/                     — skeleton parse_typescript, 4 tests
  ?? crates/cli/                    — dispatch-by-extension binary
```

When ready to push, the suggested order is: Substrate → EAP → intent-compiler. EAP server side needs Hetzner rebuild before the new endpoint is reachable in prod (same constraint as the 2026-04-24 EAP `/attestor` endpoint).

---

## Why split this way

- **Each session has ONE deliverable.** No session bundles "build the parser AND wire the UI AND write the docs". Discipline keeps PRs small, reviewable, and revertable.
- **Skeleton-then-fill is the cheapest path to a stable contract.** The Intent shape, EAP phase shape, and Substrate v2 schema are committed first. That lets parallel work on consumers (intent-server, EAP web wire, Substrate replayer) start before the producers are complete.
- **Disk + context budget realistic.** Substrate v2 + swc + tree-sitter + syn + java parser + replay engine in one workspace would require 40+ GB of compiled artifacts and would exceed any single context window. Splitting into separate workspaces and sessions is the only sustainable path.
