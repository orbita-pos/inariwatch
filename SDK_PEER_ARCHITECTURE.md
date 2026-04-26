# InariWatch SDK Peer Architecture

> **Handoff document.** The SDK-side of the remediation system. This doc describes how `@inariwatch/capture` evolves from a unidirectional observability client into a bidirectional peer that actively participates in remediation inside the user's runtime.
>
> **Read with:** `REMEDIATION_SYSTEM_ARCHITECTURE.md` (cloud side), `PROTOCOL_SPEC.md` (wire format), `SECURITY_AND_COMPLIANCE_ROADMAP.md` (threat model).
>
> **Date:** 2026-04-22
> **Owner:** Jesus Bernal (@JesusBrDev)
> **License model:** Option B — SDK open (MIT, npm + GitHub), peer mode features gated behind cloud subscription token validation

---

## 0. Thesis

Traditional error monitoring SDKs are **observers** — they capture errors and ship them to a cloud. The cloud is on its own to figure out how to fix them. This creates three structural limits:

1. The cloud has to reconstruct context (git state, env vars, runtime values) from stack traces alone
2. The cloud has to spawn fresh containers and reinstall dependencies (30-90s per remediation)
3. Fixes are verified in cloud simulation, not in the user's actual runtime

**Peer mode inverts this.** The SDK becomes a first-class participant in remediation. The cloud issues signed commands; the SDK executes them in the user's own runtime under a strict policy the user controls. Result:

- Context is **native**, not reconstructed
- Container setup is **zero** — the user's process is the runtime
- Fixes are verified in the user's **actual system**, with Substrate replay providing cryptographic proof

This is not incremental. It's a category shift: from *error observability* to *active remediation peer*.

---

## 1. Current SDK state (`@inariwatch/capture`)

The existing SDK is well-designed for observability:
- Zero-config setup (auto-detects Next.js, Express, etc.)
- Zero deps (small footprint)
- Node.js / TypeScript coverage
- Substrate integration (optional I/O recording)
- Breadcrumbs, request context, user context
- Transport: HTTP POST to ingestion endpoint
- Already published on npm: `@inariwatch/capture`

**What it cannot do today:**
- Accept inbound commands (unidirectional by design)
- Execute code beyond error capture
- Run its own policy engine
- Verify signatures on incoming data
- Perform local replay on demand
- Attest anything cryptographically

The SDK evolution in this doc **preserves all of the above** while adding the missing capabilities as opt-in layers.

---

## 2. Design principles

1. **Backward compatible always.** Every existing `capture()` call works unchanged. Peer mode is strictly additive.
2. **Explicit opt-in.** Peer features activate only with explicit code: `InariWatch.enableRemoteRemediation({...})`. No inheritable-global-config surprise.
3. **User owns the policy.** Every command the cloud issues is checked against a user-authored policy before execution. The SDK ships with a **deny-by-default** policy.
4. **Zero trust on cloud identity.** Every command carries an Ed25519 signature. The SDK verifies before touching anything.
5. **Audit everything locally.** Every command executed is logged to a local append-only log the user can inspect.
6. **Kill switch always available.** `INARIWATCH_REMOTE_REMEDIATION=disabled` env var overrides any code-level enable.
7. **Subscription gating in protocol, not in SDK.** The SDK doesn't check "are you Pro?" — it forwards the subscription token to the cloud, and the cloud decides whether to issue peer commands. Free-tier users can install the SDK; peer commands simply never arrive.

---

## 3. The 5 Fases of SDK Evolution

### Fase A — Foundation: Bidirectional Transport + Signature Verification

**Status target:** Node.js SDK first. Other runtimes follow in Fase E.

**Work:**
- Add bidirectional transport layer:
  - **Primary:** WebSocket persistent connection to `wss://peer.inariwatch.com/v1/connect?token=<jwt>`
  - **Fallback:** Server-Sent Events if WebSocket blocked by firewall
  - **Last resort:** Long-polling every 5s to `/v1/poll?since=<cursor>`
  - Auto-detect firewall behavior; degrade gracefully
- Add signature verification subsystem:
  - Bundle cloud public key (Ed25519, 32 bytes) baked into SDK build
  - Every inbound message must carry `signature` field; verify before processing
  - Key rotation mechanism: cloud can publish new pubkey signed by previous pubkey (chain of trust)
  - TOFU fallback if baked key outdated: first contact, pin received pubkey, verify chain
- Add subscription token handling:
  - User sets `INARIWATCH_PEER_TOKEN=...` (or passes in code)
  - SDK includes token in WS handshake
  - Cloud validates token → issues peer connection or rejects
  - SDK refreshes token before expiry via refresh endpoint
- **Feature flag scope:** Fase A ships **disabled by default**. User must explicitly `InariWatch.enablePeerTransport()` to open the WS connection at all.
- **Behavior in Fase A:** SDK can **receive** messages but can **only respond to pings**. No command execution yet. This is the trust-building phase.

**Files (in `capture/` package):**
```
capture/src/
  index.ts                    # existing, unchanged
  transport/
    peer-ws.ts                # WebSocket client
    peer-sse.ts               # SSE fallback
    peer-polling.ts           # polling fallback
    transport-selector.ts     # auto-select
  crypto/
    verify.ts                 # Ed25519 signature verify (via @noble/ed25519 — already zero-dep-friendly)
    key-store.ts              # baked + TOFU keys
  peer/
    peer-client.ts            # top-level peer lifecycle
    handshake.ts              # token + pubkey negotiation
```

**Acceptance:**
- `enablePeerTransport()` establishes WS connection with valid token
- Malformed / unsigned messages rejected; logged locally
- Key rotation from cloud → SDK accepted when properly chained
- Connection survives network flaps (auto-reconnect with exponential backoff)
- Bundle size impact ≤ +8KB gzipped (hard constraint)

---

### Fase B — Read-only Remediation Peer

**Status target:** Safe inspection. No writes. No code execution.

**Work:**
- Add policy engine:
  - Policy file lives at `<project>/.inariwatch/policy.yml`
  - SDK loads policy on `enableRemoteRemediation()` call
  - Policy schema (v1):
    ```yaml
    version: 1
    default: deny
    permissions:
      read_file:
        allow:
          - "src/**/*.ts"
          - "package.json"
        deny:
          - "**/.env*"
          - "**/*secret*"
      read_runtime_var:
        allow:
          - scope: "request"
            vars: ["headers.host", "url", "method"]
        deny:
          - scope: "env"
            vars: ["*SECRET*", "*KEY*", "*TOKEN*", "DATABASE_URL"]
      tail_log:
        allow:
          - path: "/var/log/app/*.log"
            max_lines: 500
    audit:
      local_log: ".inariwatch/audit.log"
      retain_days: 30
      cloud_mirror: true  # also log to cloud for compliance
    ```
- Implement read-only tools:
  - `read_file(path)` — policy-checked file read, max 1MB
  - `read_runtime_var(scope, varname)` — access request/response/env/user vars within scope
  - `tail_log(path, n)` — tail last N lines of a log file
  - `get_git_state()` — `git rev-parse HEAD`, dirty flag, remote URL
  - `get_process_info()` — PID, uptime, memory, Node version
  - `get_substrate_recording(fingerprint)` — retrieve a specific Substrate recording if present
- All tools implemented as async functions that check policy → execute → return result with metadata → log to audit
- **Sandbox execution:** read-only tools run in the SDK's own process (not subprocess). Policy is the isolation, not process boundary.
- **Bundle impact constraint:** ≤ +15KB gzipped additional

**Cloud counterpart:**
- Cloud can now issue read-only commands via protocol (see `PROTOCOL_SPEC.md` §5)
- Tier 1 single-shot remediation enhanced: cloud uses SDK peer for context gathering when available, falls back to GitHub API otherwise

**Acceptance:**
- Policy engine blocks `.env` read even if cloud requests it
- Audit log records every read, with requester signature + timestamp + result size
- Running an alert through Tier 1 with SDK peer reduces context-gather time from 500ms+ (GitHub API) to 50ms (local file read)
- User can inspect audit log anytime: `npx @inariwatch/capture audit show`

---

### Fase C — Full Agent Peer (Writes + Execution)

**Status target:** Commercial-grade feature. **This is the phase that differentiates InariWatch from any competitor.**

**Work:**
- Add write + execution tools:
  - `write_file(path, content)` — policy-checked write, creates backup, returns file hash before/after
  - `apply_patch(envelope)` — unified-diff apply, atomic
  - `run_command(cmd)` — subprocess execution, policy-checked, timeout
  - `evaluate_in_scope(expression)` — evaluate JS expression in captured error's scope (powerful; requires scope capture during error)
  - `reload_module(path)` — hot-reload Node module (opt-in per framework)
  - `run_test(pattern)` — run user's test suite filtered to pattern
- Three-tier permission system:
  - **`read-only`** — Fase B tools only
  - **`suggest`** — can write to a "suggested" directory (`.inariwatch/suggestions/`); human must apply
  - **`auto-execute`** — full powers; user opted-in explicitly in `policy.yml`
- Sandboxed execution for `run_command`:
  - Linux: gVisor if available, else `prlimit`-restricted subprocess
  - macOS / Windows: Node.js `worker_threads` with message-passing isolation
- Subscription validation:
  - Full peer mode (Fase C) requires active Pro+ subscription
  - Token validated every 15 min; on expiry, SDK drops to Fase B capabilities automatically
- Policy UI:
  - `npx @inariwatch/capture policy init` generates default policy with wizard
  - `npx @inariwatch/capture policy validate` checks syntax
  - `npx @inariwatch/capture policy test <command>` dry-runs a command against policy
- Revocation:
  - Cloud can broadcast `REVOKE <command-id>` or `REVOKE-ALL` to kill in-flight commands
  - SDK acks within 5s or is force-disconnected by cloud

**Critical constraint — never template model-controlled strings:**
- The model writing code in the cloud's CodeAct sandbox generates code that **calls SDK tools via structured JSON**
- The JSON is signed and routed through the protocol
- The SDK **never** accepts a free-form code string from the cloud to `eval()` or execute directly
- All execution paths go through the typed tool interface → policy check → structured call

**Cloud counterpart:**
- Cloud Tier 2/3 agents can now execute tool calls directly against user runtime instead of cloning + npm-installing
- Wall time on Tier 2 with peer: estimated 8-15s (vs 30-50s cloud-container path)
- EAP attestation can include runtime state hashes (pre/post fix) for cryptographic proof of effect

**Acceptance:**
- All Fase B tests still pass
- Full remediation end-to-end: alert → cloud Tier 2 → SDK peer executes 5+ tools → patch applied → tests pass → report to cloud → user sees green
- Policy `auto-execute` requires explicit `.inariwatch/policy.yml` entry (no implicit default)
- Revocation works: cloud sends REVOKE; in-flight command aborts within 5s
- Subscription expiry gracefully degrades to Fase B capabilities
- Bundle impact ≤ +25KB gzipped (hard constraint for a feature of this complexity)

---

### Fase D — Local Replay + Certified Fix

**Status target:** Premium enterprise feature. Buttresses the "cryptographically verified" positioning.

**Work:**
- Integrate Substrate agent's replay capability into SDK peer
- Implement local replay on demand:
  - Cloud sends `REPLAY <recording-id> WITH <patch>`
  - SDK loads Substrate recording
  - SDK applies patch in-memory (to a fork of the user's code)
  - SDK replays recorded I/O events through the patched code
  - SDK reports: did error reproduce pre-patch? Did it reproduce post-patch? What's the diff in I/O traces?
- EAP attestation of replay:
  - Generate Merkle proof: `(recording_hash, pre_patch_code_hash, post_patch_code_hash, pre_replay_result, post_replay_result)`
  - Sign with SDK's ephemeral key (issued at handshake, valid for session)
  - Return to cloud for inclusion in EAP chain
- Public verification:
  - Cloud publishes receipt; anyone can verify via `/api/eap/verify/:receiptId`
  - Customer-facing proof: "This fix was verified by replaying your actual production recording and observing the error no longer reproduces. Here is the cryptographic proof."

**Acceptance:**
- Given a Substrate recording + a patch, SDK performs deterministic replay and reports diff
- EAP receipt verifiable via public endpoint
- Enterprise landing page demos live verification

---

### Fase E — Multi-language Coverage

**Status target:** Protocol is polyglot; implementations follow.

**Runtime priorities (ordered by ICP overlap):**

1. **Node.js / TypeScript** — already covered Fases A-D
2. **Python** — second largest developer population; Django + FastAPI + Flask coverage
3. **Go** — Cloudflare Workers + on-prem infra teams
4. **Ruby** — Rails shops
5. **Java / Kotlin** — enterprise back-office
6. **Rust** — systems + CLI tools (already have `@inariwatch/capture-rs` in CLI, reuse)

**For each runtime:**
- Port protocol client (WebSocket + Ed25519 verify + JSON-RPC wire)
- Port policy engine (same YAML schema, language-specific implementation)
- Port tool implementations (language-native file / subprocess / eval APIs)
- Port audit log (same format, SQLite for portability)
- Ship as native package (pip, gem, go get, cargo, maven)

**Open-source strategy:**
- Protocol spec under MIT on `orbita-pos/inariwatch-protocol`
- Reference implementation in TypeScript under MIT
- Other-runtime ports: optional community contributions under MIT; InariWatch maintains Node + Python officially
- This is what makes Option B work: community builds runtimes we don't have bandwidth for; cloud value is unchanged

**Acceptance (per runtime):**
- Protocol conformance test suite passes
- Policy engine enforces same rules as Node reference
- At least 3 paying customers live on the runtime before we stamp it "GA"

---

## 4. Enhanced paths in cloud tiers with SDK peer

Cross-reference with `REMEDIATION_SYSTEM_ARCHITECTURE.md` for cloud side.

### Tier 1 enhanced (Fase B sufficient)

Without peer: Cloud fetches files via GitHub API, parses stack trace, calls LLM.
- Context gather: ~500ms
- LLM call: ~6s
- Total: ~7s

With peer Fase B: Cloud requests `read_file` + `read_runtime_var` + `get_git_state` from SDK.
- Context gather: ~50ms (local reads)
- LLM call: ~6s (now with runtime state in prompt)
- Total: ~6s **but** with much richer context → higher success rate

### Tier 2 enhanced (Fase C required)

Without peer: Cloud allocates container, clones repo, npm installs, runs agentic loop.
- Container spawn: ~2s
- Clone + install: 5-60s (cold) or 2-5s (pool)
- Agentic loop: 30-50s
- Total: 37-115s

With peer Fase C: Cloud runs agentic loop, but every tool call proxies to SDK.
- Container spawn: 0s (no container needed)
- Clone + install: 0s (user's runtime IS the target)
- Agentic loop: ~15-25s (tool calls are local, no container round-trip)
- Total: ~15-25s

### Tier 3 enhanced (Fase C required, Fase D adds attestation)

Without peer: 5 parallel containers, each doing clone + install + exploration.
- 5x overhead on infrastructure

With peer: 5 parallel sub-agents all executing against single SDK peer connection.
- Zero container overhead
- Sub-agents coordinate in cloud, but tool execution is cheap
- Wall time: ~30-45s (vs 60-90s)

With peer Fase D: Winning sub-agent triggers local replay of Substrate recording.
- Adds cryptographic proof that fix eliminates error in user's actual runtime

### Pillar 4 Loop 3 — Fine-tune dataset richness

Without peer: Dataset row has `{ alert, context, tool_trace, patch, post_merge_health }`.

With peer: Dataset row has `{ alert, **pre_runtime_state**, context, tool_trace, patch, **post_runtime_state**, **replay_trace**, post_merge_health }`.

The added fields are what allow a future fine-tuned model to learn remediation grounded in runtime reality, not just text pattern matching. This is the differentiator that a competitor without SDK peer cannot replicate.

---

## 5. Threat model (in brief; full in `SECURITY_AND_COMPLIANCE_ROADMAP.md`)

| Threat | Mitigation |
|---|---|
| Cloud signing key compromise | Revocation broadcast; TOFU fallback pubkey refresh; rate-limited key rotation |
| Man-in-the-middle | TLS on WS transport; signature verification of payloads regardless of transport |
| Policy bypass via path traversal | Canonical-path resolution before glob match; symlink rejection |
| Command smuggling via JSON injection | Typed schema validation; reject non-matching payloads |
| Malicious cloud operator | User policy `default: deny`; audit log reviewable; kill switch env var |
| Exfiltration via allowed tool | Policy blocks `.env`, secrets; audit log reviewable |
| Memory exhaustion | Per-tool size/time/output caps |
| Compromised SDK user | Not our threat model — user's own runtime security is their responsibility |
| Protocol version mismatch | Strict version field; incompatible versions refuse handshake |

---

## 6. Licensing implementation (Option B)

The SDK is MIT-licensed from Fase A. Subscription enforcement happens **in the protocol**, not in the SDK code.

**How it works:**
1. User installs `@inariwatch/capture` freely from npm (MIT, no auth required)
2. Fases A-B require just a free-tier account (free cloud validates token, issues limited peer connection)
3. Fase C features (write tools, command exec) — cloud issues error `PEER_MODE_REQUIRES_PRO` when free-tier user attempts `enableRemoteRemediation({ level: "auto-execute" })`
4. Fase D features — cloud only issues `REPLAY` commands to Enterprise-tier subscriptions
5. Fork scenario: someone forks the SDK, runs against their own cloud → works, but they have to build all our cloud infrastructure; they're not freeloading off our service

**What's open:**
- Protocol spec (anyone can implement a cloud)
- Reference SDK (anyone can port to new runtimes)
- Policy schema (anyone can audit what tools do)
- Audit log format (anyone can build analyzers)

**What's not open:**
- The cloud implementation itself
- Fine-tuned models trained on our dataset
- Pattern memory accumulated from our user base
- EAP chain server

---

## 7. Rollout plan

Each fase gates on the previous. Per `REMEDIATION_SYSTEM_ARCHITECTURE.md`, fases are ordered by technical dependency, not calendar.

**Fase A** → ship with SDK v2.0.0. Breaking version bump. Communicate clearly.

**Fase B** → ship with SDK v2.1.0. No breaking changes. Opt-in feature.

**Fase C** → ship with SDK v2.2.0. Opt-in feature. Requires cloud Fase 5 (CodeAct) done.

**Fase D** → ship with SDK v2.3.0. Requires cloud Fase 11 (Substrate+EAP first-class).

**Fase E** → ongoing. Each runtime is its own release train.

**Back-compat:** v1.x continues receiving security fixes for 12 months after v2.0.0 ships. No feature work on v1.x.

---

## 8. Out of scope (explicitly)

- Replacing the container path. Peer mode is additive; users without peer continue on container path.
- SDK auto-update mechanism. Users control SDK version via package manager; we don't ship a self-updater (security nightmare).
- IDE integrations beyond VS Code (already have VS Code extension). Jetbrains/Sublime/etc. are community-contribution territory.
- Mobile runtime (React Native / iOS / Android) peer mode. Mobile devices are not usually the source of production remediation needs — captures go to cloud, cloud handles it.
- Browser JS peer mode. Same reason as mobile; browsers are a client, not a server runtime.

---

## 9. Key references to other docs

- Cloud Fases that depend on SDK peer: Fase 11 Substrate+EAP (depends on SDK Fase D), Fase 9 Loop 3 dataset enrichment (depends on SDK Fase C for runtime state capture)
- Wire format: `PROTOCOL_SPEC.md` is the authoritative spec
- Security: `SECURITY_AND_COMPLIANCE_ROADMAP.md` §Threat Model §SDK-specific

End of SDK peer architecture document.
