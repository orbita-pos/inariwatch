# Capture v2 — Implementation Spec

**Owner:** Jesus Bernal
**Status:** Spec — awaiting subspec-by-subspec sign-off before code
**Scope:** TS/Node ownership of @inariwatch/capture v2 — 9 areas mapped against existing infra
**Companion:** SKYNET_MASTER_PLAN.md §3 + §12, SDK_PEER_ARCHITECTURE.md, FORENSIC_VM_DESIGN.md

---

## 0. Locked defaults (Q1–Q6, sign-off granted 2026-04-24)

| ID | Decision | Consequence |
|----|----------|-------------|
| Q1 | **Additive payload** — v2 ships as minor bump (`schema_version: "2.0"` *advisory* only); server treats unknown fields as opaque `correlationData` extensions. SKYNET §12 full schema = 6-month target as v3.0 major bump. | No breaking change to ingest. v1 events keep working forever. v2 fields land one-by-one behind feature flags. |
| Q2 | **Subpath opt-in** — `@inariwatch/capture/forensics` exports `withForensics()` integration. Activation via `init({ integrations: [forensicsIntegration()] })`. Wraps `inspector.Session` from existing `capture-forensic/`. | Core SDK stays zero-dep. Power users opt in. No paquete separado. |
| Q3 | **Peer = local diagnostic pre-egress** (SKYNET §3 #10), NOT command receiver from `SDK_PEER_ARCHITECTURE.md` Fase A-E. `@inariwatch/capture-agent` runs GPT-5.4 with 4 local tools, produces 3 hypotheses inline before flush. | No bidirectional control plane. SDK never executes server-issued commands. |
| Q4 | **UI cards = batch separado** — payload v2 ingest + DB column + AI formatters first (ship dark). UI rendering of `hypotheses`, `runtime_snap`, `precursors`, `source_slices`, `fleet_match`, `eap_signatures` follows in second wave once data flows. | Avoids gating server work on React PRs. |
| Q5 | **Spec doc first** — this file. Each subspec gets explicit sign-off (`Q5.X = OK`) before its PR. | Granular control, no surprise scope creep. |
| Q6 | **Order**: Área 1 (payload core) → Área 9 (EAP verify endpoint) → Área 2 (capture-agent peer) → Área 4 (bloom filter) → Área 3 (MCP stdio) → Áreas 5/6/7/8 paralelo según dependencias. | Critical path is payload + verification first. P2P/Causal/Intent/Zero-retention are independent rails. |

---

## 1. Reuse map (verified against codebase)

Pieces I will **call** but **never reimplement**:

| Existing piece | Location | Reused for |
|----------------|----------|------------|
| `correlationData` jsonb column | `web/lib/db/schema.ts:360` | All v2 evidence subfields land here additively |
| Webhook ingest top-level → `correlationData` | `web/app/api/webhooks/capture/[integrationId]/route.ts:160-168` | Extend with `evidence`, `hypotheses`, `runtime_snap`, etc. |
| Capture v1 SDK (git/breadcrumbs/env/user/request) | `capture/src/types.ts:103-160` (v0.9.0) | Extend interface, do not replace |
| 5 AI formatters | `web/lib/ai/capture-context.ts:43,73,127,169,201` | Add `formatRuntimeSnap`, `formatPrecursors`, `formatHypotheses`, `formatSourceSlices`, `formatFleetMatch`, `formatEapSignatures` alongside |
| 18 auto-merge gates | `web/lib/ai/auto-merge-gates.ts:145-367` | Untouched. New v2 fields may *feed* gates (e.g. `hypotheses.confidence` feeds Gate 4 self-review prior); never modify gate executor |
| `eap_receipts` table + `verified` cache cols | migration `0070_eap_receipts.sql:60-66` | Endpoint `/api/eap/verify/:receiptId` reads/writes `verified` + `verified_at` |
| `submitReceiptForRemediation()` | `eap-attestation.service.ts:73` | Reused for zero-retention tombstone receipt |
| `contributeApprovedFix()` post-merge | `web/lib/ai/contribute-fix.ts` (called from `post-merge-monitor.ts:321`) | Untouched. Bloom filter consumes downstream |
| `lookupCommunityFix()` (60% threshold) | `web/lib/ai/community-fix-lookup.ts:22-60` | Reused inside fleet bloom server-side fallback |
| Pattern memory (pgvector HNSW) | `web/lib/ai/pattern-memory.ts:272,342` | Source of truth for bloom filter build script (server side) |
| Drizzle ORM | `web/lib/db/schema.ts` | Causal Graph hooks instrument it as primary ORM |
| AsyncLocalStorage scope | `capture/src/scope.ts:8-13` | Reused for Causal Graph root context |
| `capture-forensic/src/fallback-inspector.ts` | sibling pkg | Wired into core via `/forensics` subpath (Q2) |
| MCP web HTTP (25 tools) | `web/app/api/mcp/tools/` | Untouched. dev-mode stdio exposes a *different* tool set (5 local-only) |
| Substrate `replay.id` column | existing | `evidence.replay.id` references this; no new table |

---

## 2. Corrections to briefing / CLAUDE.md (already shared, restated for record)

1. `auto-merge-gates.ts` has **18 gates**, not 11. CLAUDE.md is stale. (`project_gates_count.md` correct.)
2. Latest migration is `0072_tier_router_labels.sql`, not 0031.
3. SDK sends fields **top-level** in `ErrorEvent`; webhook packs into `correlationData` server-side.
4. **No bloom filter exists** anywhere in repo — pattern memory is pgvector HNSW. Bloom is full new build (SDK + endpoint + nightly build script).
5. `@inariwatch/capture/shield` is shipped (commit `f3e0d3d`) — payload v2 should surface `securityContext` as a card too (zero extra SDK work).

---

## 3. Payload v2 — additive shape (Q1)

### 3.1 SDK output (`capture/src/types.ts` extension)

Add to `ErrorEvent` (every field optional, every field opt-in via config):

```ts
export interface ErrorEvent {
  // ... v1 fields unchanged ...

  /** v2 schema marker — advisory, not required by server. Absence = v1 behavior. */
  schemaVersion?: "2.0"

  /** Forensic capture from inspector.Session (requires forensics integration) */
  forensics?: {
    locals?: Record<string, SerializedValue>     // per-frame, capped at 4KB/frame
    closureChains?: Record<string, SerializedValue>
    asyncStack?: string[]
  }

  /** Per-frame source slice + git blame (requires sourceContext integration) */
  sourceContext?: Array<{
    frameIndex: number
    before: string[]   // 10 lines
    line: string
    after: string[]    // 10 lines
    blame?: { commit: string; author: string; date: string; message: string }
  }>

  /** Runtime snapshot at throw time (cheap, always-on when v2 enabled) */
  runtimeSnap?: {
    heapMb: number
    rssMb: number
    eventloopP99Ms: number
    openHandles: number
  }

  /** 1Hz precursor signals from last 60s (requires precursors integration) */
  precursors?: Array<{
    signal: "eventloop_p99" | "rss_trend" | "retry_burst" | "circuit_breaker_trip" | "near_miss_rejection"
    deltaPct: number
    windowSeconds: number
  }>

  /** Hypotheses produced by local capture-agent peer (Área 2) */
  hypotheses?: Array<{
    text: string
    prior: number              // 0-1
    cites: string[]            // JSONPath into this event
    confidence: number
    source: "local_agent" | "bloom_match" | "heuristic"
  }>

  /** Fleet bloom-filter match result (Área 4) */
  fleetMatch?: {
    bloomHit: boolean
    communityFixId?: string    // populated only on server lookup
    teamsHit?: number
  }

  /** Intent contracts compiler output (Área 7) */
  expected?: {
    contracts: Array<{ source: "ts" | "zod" | "drizzle" | "openapi"; path: string; shape: unknown }>
  }

  /** Causal graph edgelist (Área 6) */
  causalGraph?: {
    nodes: Array<{ id: string; kind: "io" | "fn" | "promise" | "syscall"; label: string }>
    edges: Array<{ from: string; to: string; kind: "causal" | "temporal" | "data" }>
  }

  /** EAP signatures over evidence merkle root (Área 9 ties to verify endpoint) */
  eapSignatures?: {
    evidenceMerkleRoot: string  // sha256 hex
    evidenceSignature: string   // Ed25519 hex
    signerPubkey: string        // Ed25519 pubkey hex
    signedAt: string            // ISO 8601
    receiptId?: string          // links to eap_receipts.id when issued
  }

  /** SDK-side estimated token count for the whole payload */
  tokensEstimated?: number
}

export type SerializedValue =
  | { type: "primitive"; value: string | number | boolean | null }
  | { type: "object"; preview: string; truncated: boolean }
  | { type: "redacted"; reason: "pii" | "size" | "secret" }
```

**Token budget default**: 8K per event. Drop priority (lowest dropped first when over budget):
`causalGraph > expected > sourceContext.after > precursors[3..] > breadcrumbs[15..] > forensics.closureChains > forensics.locals (per-frame > frame[0]) > runtimeSnap > hypotheses`

### 3.2 Server ingest extension (`web/app/api/webhooks/capture/[integrationId]/route.ts`)

Diff is purely additive at lines 160-168:

```ts
if (event.forensics) correlationData.forensics = event.forensics
if (event.sourceContext) correlationData.sourceContext = event.sourceContext
if (event.runtimeSnap) correlationData.runtimeSnap = event.runtimeSnap
if (event.precursors) correlationData.precursors = event.precursors
if (event.hypotheses) correlationData.hypotheses = event.hypotheses
if (event.fleetMatch) correlationData.fleetMatch = event.fleetMatch
if (event.expected) correlationData.expected = event.expected
if (event.causalGraph) correlationData.causalGraph = event.causalGraph
if (event.eapSignatures) correlationData.eapSignatures = event.eapSignatures
if (event.schemaVersion) correlationData.schemaVersion = event.schemaVersion
if (event.tokensEstimated) correlationData.tokensEstimated = event.tokensEstimated
```

No DB migration. No Zod gating (parse leniently — drop only if shape is dangerous, e.g. >100KB nested `forensics`).

### 3.3 Zod contracts (validator-only, never enforced server-side hard-block)

Live in `web/lib/capture-v2/schemas.ts`. Used by:
- AI formatters (`capture-context.ts`) for type-safe access
- Test fixtures
- `/api/dev/payload-validator` debug route (devs paste an event, get diagnostics)

Server **never** rejects an event because Zod failed — only logs a `payload_v2_shape_warning` metric and degrades gracefully.

---

## 4. Subspecs by area (each gets `Q5.X = OK` before its PR)

### Q5.1 — Payload v2 wire-up (Área 1)
**Deliverables:**
- `capture/src/types.ts` extended (no v1 field touched)
- `capture/src/serialize.ts` — token-budget drop logic with priority list
- `web/lib/capture-v2/schemas.ts` — Zod contracts
- Webhook route additive lines (3.2)
- Feature flag `CAPTURE_V2_INGEST_ENABLED=true` default (server-side; ingestion is harmless without consumers)
**Tests (Vitest):**
- Round-trip: SDK serialize → JSON → server parse → `correlationData` shape matches
- Budget: oversized payload drops in priority order, never exceeds 8K tokens
- Backward compat: v1-only event still produces identical alert row vs main
- Fuzz: 10K random events under 200KB never crash ingest
**Acceptance:** byte-identical alert row for v1 events (snapshot test).
**Estimate:** 2 days.

### Q5.2 — `/api/eap/verify/:receiptId` endpoint (Área 9)
**Deliverables:**
- `web/app/api/eap/verify/[receiptId]/route.ts` — GET handler
- Reads `eap_receipts` row; if `verified !== null` → return cached
- If null → call `verifyEAPChainLocally()` (Team Rust delivers helper); cache result + `verified_at = now()`
- 401 if receipt belongs to different workspace; 404 if not found
**Tests:**
- Cache hit returns <50ms, cache miss <500ms
- Workspace isolation (cross-workspace returns 401, never leaks chain)
- Idempotent: 100 concurrent calls produce 1 verify call (in-flight dedup via Redis `SET NX`)
**Acceptance:** verify endpoint live + invoked by alert detail page when `eapSignatures.receiptId` present.
**Dep:** Team Rust delivers `verifyEAPChainLocally(receipt: EAPReceipt): Promise<{ valid: boolean; chain: ChainNode[] }>`.
**Estimate:** 1.5 days.

### Q5.3 — `@inariwatch/capture-agent` peer (Área 2)
**Deliverables:**
- New package `capture-agent/` (sibling to `capture/`)
- `peerAgentIntegration()` exported integration; consumed via `init({ integrations: [peerAgentIntegration({ openaiKey })] })`
- 4 local tools: `getLocalsAtFrame`, `evaluateInFrame` (sandboxed inspector eval), `matchFingerprint` (consults bloom + local SQLite cache), `diffSinceDeploy` (git diff vs `git.commit`)
- Calls GPT-5.4 with prompt-caching breakpoints mirroring `web/lib/ai/remediate.ts` (commit `d5ea113`)
- Output → `event.hypotheses[]` before egress
- 1.5s deadline (configurable); on timeout, ship event without hypotheses
**Tests:**
- Bench: 1000 events, p99 added latency < 1.7s with timeout
- Failure isolation: agent crash never blocks event flush (try/catch + bypass)
- Cost cap: per-event spend < $0.01 (tools cap + prompt cache)
**Acceptance:** local Cursor session catches an error, event arrives at server with 3 ranked hypotheses inline.
**Estimate:** 4 days.

### Q5.4 — Fleet bloom filter (Área 4)
**Deliverables:**
- Server: `web/scripts/build-fleet-bloom.ts` — nightly cron, reads `errorPatterns` table, builds 2MB bloom (m=16M bits, k=7 hashes), uploads to `https://cdn.inariwatch.com/bloom/<release>.bloom`
- Server: `GET /api/fleet/bloom/latest` — redirects to current bloom URL with cache headers
- SDK: `fleetBloomIntegration({ refreshSeconds: 86400 })` — fetches on init, holds in memory, exposes `hasAnyoneElseHit(fingerprint): boolean` synchronous check (<1ms)
- SDK: optional `contribute: true` — POST anonymized fingerprint + minimal stack to `/api/fleet/bloom/observe` (rate-limited per workspace, 100/min); server inserts to `errorPatterns` if novel (existing `contributeApprovedFix()` *already does* the post-merge auto-contribution path; this is the live observation path)
**Tests:**
- False positive rate < 1% at 100K patterns
- SDK init blocks ≤ 200ms on bloom fetch (or skips if slower)
- Bloom build: 100K rows → 2MB output in < 30s
**Acceptance:** error fired locally → SDK reports `fleetMatch.bloomHit: true` for known patterns within 1ms.
**Estimate:** 3 days.

### Q5.5 — MCP dev-mode stdio server (Área 3)
**Deliverables:**
- New package `capture-mcp-dev/` exposing `inariwatch-mcp-dev` binary
- Stdio JSON-RPC 2.0 (custom impl mirroring `web/app/api/mcp/route.ts` patterns; no SDK dep)
- 5 local-only tools (different from web's 25):
  - `get_recent_errors(limit)` — reads SDK ring buffer
  - `diagnose_error_id(id)` — runs peer agent on cached event
  - `get_locals_at_frame(errorId, frameIdx)` — pulls from forensics
  - `replay_substrate(recordingId)` — invokes substrate-agent CLI
  - `match_fleet(fingerprint)` — bloom check
- Auto-config: `npx @inariwatch/capture init` (existing) detects MCP-capable clients, writes config to `.cursor/mcp.json`, `.claude.json`, etc.
**Tests:**
- Stdio transport conforms to MCP spec (initialize → tools/list → tools/call)
- Cursor and Claude Code both connect successfully (manual smoke + automated CI via `@modelcontextprotocol/inspector`)
**Acceptance:** Cursor invokes `diagnose_error_id` from chat, gets back hypotheses without cloud round-trip.
**Estimate:** 3 days.

### Q5.6 — Causal Graph Engine (Área 6)
**Deliverables:**
- `capture/src/causal-graph.ts` — async_hooks + AsyncLocalStorage root context
- Auto-instrumented: Drizzle, ioredis, undici, node-fetch, pg (5 hook adapters)
- Output: `event.causalGraph` edgelist when v2 enabled
- Opt-out per-orm via `init({ causalGraph: { exclude: ["pg"] } })`
**Tests:**
- Graph for a known query → handler → response chain matches expected edges (deterministic harness)
- Overhead bench: < 3% CPU on synthetic 10K rps load
- No hook leaks under load (handle count stable over 1M operations)
**Acceptance:** sample app showing pg query → throw produces graph with 4 nodes / 3 edges.
**Estimate:** 6 days.

### Q5.7 — Intent contracts compiler (TS subset) (Área 7)
**Deliverables:**
- `capture-intent/` package
- AST parser via `swc` (faster than tree-sitter for TS, both supported)
- Adapters: TS types (interface/type), Zod schemas, Drizzle table→shape, OpenAPI files
- For non-TS schemas (Prisma, GraphQL, Pydantic, Java records, Rust serde): HTTP call to Team Rust core compiler at `https://intent.staging.inariwatch.com/compile` (FFI later if hot-path)
- Runs at SDK init (cached on disk), refreshes when source files mtime changes
- Output → `event.expected` when route handler matches a known contract
**Tests:**
- TS interface with 5 fields → correct shape
- Drizzle table → matches column types
- Zod refinement preserved as JSON-schema-ish
**Acceptance:** known route throws → event includes the expected response shape under `expected.contracts[]`.
**Estimate:** 7 days (TS subset only; non-TS waits on Team Rust).

### Q5.8 — P2P gossip mesh workspace-level (Área 5)
**Deliverables:**
- `inari-web` adds WebSocket endpoint `/ws/fleet/:workspaceId` (auth via Bearer)
- Broadcasts: canary-flag-rollback, fix-published, fingerprint-spike (1s SLA)
- Each message Ed25519-signed by workspace key (stored in `workspaces.gossip_signing_key`, new column)
- SDK: `gossipIntegration({ workspaceId })` connects, verifies signatures, exposes events to user code via emitter
- Anti-abuse: per-workspace rate limit (50 msg/min), max payload 1KB
**Tests:**
- 50 SDKs connected → broadcast reaches all in < 1s p95
- Tampered signature dropped silently + logged
- Reconnect logic survives 30s server restart
**Migration:** `0073_workspaces_gossip_key.sql` — adds `gossip_signing_key text` to `workspaces`; backfilled with new key on first read
**Acceptance:** dev fires test broadcast from `/admin/ops`, all connected SDK instances receive it within 1s.
**Estimate:** 5 days. **Note:** Upstash pub-sub fallback if WebSocket scaling becomes pain — flagged but not blocking for v1.

### Q5.9 — Zero-retention mode + tombstone proofs (Área 8)
**Deliverables:**
- New column `workspaces.zero_retention boolean default false` (migration `0074_workspaces_zero_retention.sql`)
- Webhook ingest: when flag set, process event in-memory (still runs auto-analyze, alert dedup check via fingerprint hash only — no row inserted to `alerts`)
- Server returns receipt: `submitReceiptForRemediation()` reused to sign tombstone payload (hash of fingerprint + timestamp + workspace)
- Receipt persisted to `eap_receipts` (smallest possible: just hash + signature, no PII)
- SDK exposes returned receipt via `init({ onReceipt: (r) => …​ })` callback for compliance archiving
- Auditor export: `GET /api/compliance/zero-retention-export?from&to&format=csv|json` — returns all tombstones for a window
**Tests:**
- Flag on → no `alerts` row created, but receipt exists
- Auditor export verifiable: each tombstone's signature validates against workspace pubkey
- Existing flag-off behavior byte-identical
**Acceptance:** workspace toggles flag in `/settings/security` → next event leaves zero PII at rest, receipt returned to SDK.
**Estimate:** 4 days.

---

## 5. Cross-cutting work

### 5.1 AI formatters (Área 1 partial — needed for any consumer to use v2 fields)
Add to `web/lib/ai/capture-context.ts`:
- `formatRuntimeSnap(snap): string`
- `formatPrecursors(precursors): string`
- `formatHypotheses(hypotheses): string` — emits ranked list with priors + cites
- `formatSourceSlices(slices): string` — emits "Frame N (file:line):\n```\n...\n```"
- `formatFleetMatch(match): string`
- `formatEapSignatures(sig): string` — short form ("verified ✓" or "unverified")
Each formatter is null-safe and < 800 tokens output.

### 5.2 Telemetry events
Add to `web/lib/telemetry/events.ts`:
- `CAPTURE_V2_PAYLOAD_RECEIVED` (metric: schemaVersion, byteSize, fieldsPresent[])
- `CAPTURE_V2_HYPOTHESIS_USED` (metric: source, confidence, ledToFix)
- `CAPTURE_V2_BLOOM_HIT` (metric: workspaceId, fingerprint hash)
- `CAPTURE_V2_FORENSICS_TIMEOUT`
- `EAP_VERIFY_CACHE_HIT_RATE`
Surfaced on `/admin/ops` in widget #9 (new).

### 5.3 Documentation
- Update `web/app/(marketing)/docs/` after Q5.1 ships (single page: "Capture v2 — what's new")
- `CLAUDE.md` is updated **after** all 9 areas ship (single PR), not piecemeal
- README of `capture/` package gets v2 section per subspec PR

### 5.4 What I will NOT touch
- `gates-executor.ts` (only feed it via alert.correlationData — never modify)
- `eap_receipts` schema (only read/write existing columns)
- `substrate_recordings` table (only reference its `recordingId`)
- `contributeApprovedFix()` / `lookupCommunityFix()` (call them, don't reshape)
- The 25 web MCP tools (stdio server is a separate package with 5 local tools)
- `pattern-memory.ts` internals (feed via existing contribute-back path only)

---

## 6. Cross-team dependencies

| Need | From whom | When | Blocker if missing? |
|------|-----------|------|---------------------|
| Polyglot SDK schema alignment | SDK Polyglot team | Before Python port begins | No — TS ships first, Python aligns to it |
| RCA-Net peer package | ML team | Q3 2026 | No — peer agent uses GPT-5.4 in interim |
| `verifyEAPChainLocally()` helper | Rust team | Before Q5.2 PR | **Yes** — endpoint blocked without it |
| Intent compiler core (non-TS shapes) | Rust team | Before Q5.7 ships non-TS adapters | Partial — TS subset ships standalone |
| ForensicVM bindings | Runtime team | Q4 2026 | No — `inspector.Session` fallback works |
| eBPF agent consumer of `evidence.agent_correlation` | eBPF team | Whenever they're ready | No — field is opt-in |

---

## 7. Sign-off protocol

For each subspec (`Q5.1` through `Q5.9`):
1. I open a thread in this doc as a comment block at top of section
2. You reply `Q5.X = OK` (or with edits)
3. I open the PR; it must (a) match the spec, (b) include the listed tests, (c) leave the byte-identical snapshot test green, (d) be ≤ 800 lines added (excluding tests + fixtures) — anything bigger I split
4. PR description links back to its subspec section in this doc
5. Merge gates: existing CI + the byte-identical snapshot

Anything outside scope of an approved subspec **does not ship**, even if I think it's a good idea — I open a separate spec issue for review.

---

## 8. Status

- [x] Q0 — Audit complete, defaults locked, this doc written (2026-04-24)
- [x] Q5.1 — payload v2 wire-up — **shipped 2026-04-24 (53/53 tests pass, web typecheck clean for Q5.1 files, SDK typecheck clean)**
- [x] Q5.2 — `/api/eap/verify/:receiptId` — **already shipped in commit `94b039c` (Fase 11 follow-up). Only gap was Redis SET NX in-flight dedup — added 2026-04-24 (3 new tests, 33/33 pass).** Workspace isolation NOT applicable: receipts are content-addressed and intentionally public (third-party audit access). My audit was wrong on that point.
- [x] Q5.3 — `@inariwatch/capture-agent` peer — **shipped 2026-04-24**. New package `capture-agent/` (~600 LoC + 22 tests, all pass). Required additive `Integration.onBeforeSend?` hook in core SDK (backward-compat). 4 tools: getLocalsAtFrame (live), evaluateInFrame (v0.1 stub), matchFingerprint, diffSinceDeploy. Hand-rolled OpenAI client with prompt-cache breakpoints. 1.5s deadline enforced via AbortSignal.timeout. Never drops event on diagnose failure. **NOT yet published to npm** — needs `inariwatch-capture-agent` public mirror (see `feedback_publish_workflow.md`).
- [x] Q5.4 — Fleet bloom filter — **shipped 2026-04-24**. Server side: `web/lib/fleet-bloom/{bloom,build}.ts` (pure bloom impl + build runner), `GET /api/fleet/bloom/latest` (with ETag + HEAD + 304), `POST /api/fleet/bloom/observe` (live contribute, 100/min IP limit + 5-min Redis dedup), `GET /api/cron/build-fleet-bloom` (daily rebuild, Bearer auth). 17 vitest tests (FP rate < 1% at 100K verified mathematically). SDK side: new package `capture-fleet/` with `FleetBloomClient` (200ms init timeout, 24h refresh, 304-aware, never blocks init), `fleetBloomIntegration()`, byte-identical wire format (12 cross-compat tests pass). **NOT yet published to npm**. Migrations: none — reuses existing `error_patterns` table.
- [ ] Q5.5 — MCP dev-mode stdio
- [ ] Q5.5 — MCP dev-mode stdio
- [ ] Q5.6 — Causal Graph Engine
- [ ] Q5.7 — Intent contracts compiler (TS subset)
- [ ] Q5.8 — P2P gossip mesh
- [ ] Q5.9 — Zero-retention + tombstone proofs

---

**Next request:** review §3 (payload shape) and §4 Q5.1 (wire-up subspec). Reply `Q5.1 = OK` to unblock the first PR. If anything in §3.1 should be renamed/cut/added, mark it now — once Q5.1 ships, the field names are wire-format and harder to change.
