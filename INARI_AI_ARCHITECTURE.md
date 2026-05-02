# InariWatch AI Architecture (SSOT)

**Status:** LOCKED — 2026-05-02. Draft ratified by Jesus before v0.3 work begins.
**Scope:** Cross-cutting AI dispatch for ALL InariWatch surfaces (web, desktop / Inari Live, CLI, capture SDKs, MCP, mobile, Slack/Telegram bots, VS Code).
**Supersedes:** ad-hoc per-surface AI implementations across `web/lib/ai/*`, `desktop/src-tauri/.../openai_client.rs`, `cli/src/`, etc.

---

## 1. Thesis

InariWatch is **one product**, with **one AI brain**, that runs on **multiple substrates**. The brain is task-aware: every AI call across every surface tags itself with a task type, and a single router decides where it runs (cloud / user's box / user's process / CLI process).

The split that drives every routing decision:

> **Cloud (GPT / Claude / Groq) = "qué hacer"** — diagnóstico, código, agent loop, gates, security scan. Donde ser correcto importa más que privacidad o costo.
>
> **Local (Llama / Qwen / Piper) = "cómo decirlo"** — el cuerpo del email, del WhatsApp, del Slack, del Telegram, del push, de la voz, del status page, del postmortem-prose, del dock chat conversacional. Donde tono natural + privacidad + latencia + costo importan más que razonamiento profundo.

Una oración para users:
> **InariWatch usa GPT para arreglar tu código. Tus alertas se componen en tu máquina.**

---

## 2. The Router (`@inariwatch/ai-router`)

### 2.1 What it is
- TypeScript package living at `packages/ai-router/` (workspace internal — **NOT published to npm**).
- Single point of entry for every AI call in the monorepo.
- Owns: task taxonomy, routing rules, dispatch function, provider adapters, eval harness, EAP receipt emission.

### 2.2 What it is NOT
- NOT a replacement for provider SDKs (`openai`, `@anthropic-ai/sdk`, `groq-sdk`, `llama.cpp`, `fastembed`, etc.). Those stay installed and in use — the router imports them internally.
- NOT a public package. Stays in the monorepo. May be published later if third-party integrations need it.
- NOT a model server. It's a dispatcher. Models run in their substrates (cloud APIs, Inari Live sidecar, embedded onnxruntime, linked llama.cpp).

### 2.3 Public surface (the only thing surfaces import)
```ts
import { dispatch } from "@inariwatch/ai-router"

const response = await dispatch({
  task: "notify.compose.email",         // task taxonomy enum
  payload: { alert, recipient, ... },   // task-specific
  workspace: workspaceId,               // for routing decisions per workspace
  hints: { latencySensitive: true },    // optional, advisory
})
```
That's it. No surface code touches `openai`, `anthropic`, `llama.cpp`, or any provider SDK directly anymore.

---

## 3. Substrates (where models can run)

| # | Substrate | What runs there | Reachable from |
|---|---|---|---|
| 1 | **Cloud** (OpenAI, Anthropic, Groq, Google, Grok, DeepSeek) | Code-fix tasks, agent loops, gates, security scan, RCA | All surfaces (web → direct API; desktop/CLI → web's `/api/ai/proxy`) |
| 2 | **Inari Live sidecar** (user's box) | Notification composition, voice TTS, dock chat conversational, redaction (heavy) | Inari Live (loopback HTTP); web/Slack/Telegram/mobile (via WS relay) |
| 3 | **Capture embedded** (user's process) | Pre-send PII redaction, breadcrumb summarization, fingerprint suggestion | Capture SDK only (in-process, no IPC) |
| 4 | **CLI linked** (`llama.cpp` linked into Rust binary) | Same as Inari Live sidecar but for `inariwatch dev` / `inariwatch watch` use cases | CLI only (in-process) |

The router knows which substrates are available per dispatch:
- Web call: substrates 1 + 2 (via relay if user online)
- Desktop call: substrates 1 + 2 (loopback)
- Capture call (Node): substrates 1 + 3 (if embedded model installed)
- CLI call: substrates 1 + 4

---

## 4. WS Relay Protocol (`relay.inariwatch.com`)

The relay is the **only piece of new infra** the architecture requires.

### 4.1 Purpose
Lets the InariWatch cloud dispatch tasks to the user's local Inari Live sidecar, transparently. Without this, "web composes notification" can never reach the user's local model.

### 4.2 Topology
```
   Inari Live (user's box)
        │
        │ WS connection (long-lived, keep-alive)
        │ Auth: per-user JWT signed by web
        ▼
   wss://relay.inariwatch.com   ←  hosted on Hetzner alongside Go staging server
        ▲
        │ web/Slack/Telegram/mobile push tasks here
        │
   InariWatch cloud (Vercel + Hetzner)
```

### 4.3 Behavior
- Inari Live registers on boot: `register({ user_id, capabilities: ["notify.compose.*", "voice.tts", "chat.conversational"] })`.
- Relay tracks online users + their capabilities.
- When web's router decides "this task should go local for user X", it POSTs to relay → relay forwards over WS → sidecar runs model → response streams back.
- If user offline OR sidecar timeout (>2s) → router falls back to cloud transparently. Caller never sees the difference.
- Relay is **stateless** beyond connection tracking. No payloads logged. No model state stored.

### 4.4 Auth
- User JWT issued by web on Inari Live login. Embedded in WS handshake.
- Relay verifies JWT signature + expiry, extracts `user_id`, scopes connection.
- Web → relay request signs the destination `user_id` with `RELAY_DISPATCH_SECRET` (server-to-server).

### 4.5 Privacy commitment
- Relay sees: task type, payload size, dispatch timestamp, response timestamp.
- Relay does NOT see: payload contents (E2E? — see open question §13.1).

---

## 5. Task Taxonomy (~30 tasks, growing)

Tasks are namespaced. Format: `<domain>.<verb>.<specifier>`.

### 5.1 `code.*` — code understanding & modification (CLOUD ONLY, locked)
- `code.fix.single-shot` — single-pass fix with full context (web remediation)
- `code.fix.agent-loop` — multi-turn tool-use agent (web Container Agent + agentic loop)
- `code.review.self` — self-review of generated diff (gate 7)
- `code.review.security` — security AI review (gate 17 layer 3)
- `code.risk.assess` — PR risk assessment (action + gate 5)
- `code.fingerprint` — error fingerprinting (Capture + web dedup) — *MAY move to local in §5.5 redact*
- `code.fim.completion` — Tab autocomplete (Inari Live S23/S24) — **ALREADY LOCAL** (Qwen2.5-Coder-1.5B)
- `code.apply.diff` — Fast Apply (Inari Live S25/S26) — **ALREADY LOCAL** (Kortix-7B)
- `code.embed` — code embeddings for Code Intelligence search — **ALREADY LOCAL** (fastembed/MiniLM)

### 5.2 `alert.*` — alert ingestion & analysis (HYBRID)
- `alert.auto-analyze` — short prose analysis on arrival (today: GPT-4o-mini; planned: stays cloud — analysis quality matters)
- `alert.correlate` — cross-alert correlation (cloud)
- `alert.classify` — severity / category classification (small task — *candidate for local*, deferred)

### 5.3 `notify.*` — notification composition (LOCAL when user online, cloud fallback)
- `notify.compose.email` — alert email body
- `notify.compose.slack` — Slack message prose
- `notify.compose.telegram` — Telegram message prose
- `notify.compose.whatsapp` — WhatsApp message body (NEW surface, v0.3)
- `notify.compose.push` — push notification text (web/mobile)
- `notify.compose.digest` — weekly digest prose
- `notify.compose.status-page` — status page incident narrative
- `notify.compose.postmortem-prose` — postmortem human-facing prose (NOT the technical RCA, which stays cloud)

### 5.4 `voice.*` — voice surface (LOCAL only)
- `voice.tts.alert` — TTS for incoming critical alert (Piper)
- `voice.tts.digest` — TTS for digest summaries (Piper)

### 5.5 `chat.*` — conversational surfaces (HYBRID with intent routing)
- `chat.conversational` — dock chat "¿qué pasó?" "¿es urgente?" (LOCAL)
- `chat.code` — dock chat "fix this" / "explain this stack trace" (CLOUD)
- `chat.intent-classify` — small router classifier (LOCAL, ~500MB model)

### 5.6 `redact.*` — privacy-sensitive transforms (LOCAL preferred)
- `redact.pii.breadcrumbs` — strip PII from Capture breadcrumbs pre-send (CAPTURE EMBEDDED if available; else cloud)
- `redact.pii.stacktrace` — strip secrets from stacktraces

### 5.7 `gate.*` — auto-merge gate evaluators (CLOUD)
- `gate.prediction` — predict deploy risk (gate 8)
- `gate.substrate-replay` — replay analysis (gate 9 AI-mode)
- `gate.community-fix-match` — pattern matching (gate 10)
- (Other gates are deterministic, no AI — not in taxonomy)

---

## 6. Routing Rules

### 6.1 Format
`packages/ai-router/src/rules.ts` — TypeScript config. Per task:
```ts
{
  "notify.compose.email": {
    primary: { substrate: "user-sidecar", model: "llama-3.2-3b-q4" },
    fallback: { substrate: "cloud", provider: "groq", model: "llama-3.2-3b" },
    fallbackTriggers: ["sidecar-offline", "sidecar-timeout", "workspace-flag-cloud-only"],
  },
  "code.fix.single-shot": {
    primary: { substrate: "cloud", provider: "openai", model: "gpt-4o" },
    fallback: { substrate: "cloud", provider: "anthropic", model: "claude-sonnet-4-6" },
    fallbackTriggers: ["openai-error", "openai-rate-limit"],
  },
  // ...
}
```

### 6.2 Initial state (Phase 1 deploy)
**Every task routes to cloud, behavior identical to today.** The router is a no-op refactor at first. Local routing turns on per-task in Phase 3+.

### 6.3 Workspace overrides
A workspace can opt out: `workspace.aiPreferences = { forceCloudOnly: true }`. Useful for users who don't want local routing even if they have Inari Live.

### 6.4 BYOK (existing feature, preserved)
Workspaces with their own API key (via existing `apiKeys` table) get routed to their key for `code.*` tasks. The router knows about BYOK and uses it transparently.

---

## 7. What Stays (no changes)

| Category | Specifics |
|---|---|
| Provider npm packages | `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@google/generative-ai`, `axios`/`fetch`, `fastembed` — all stay installed |
| Capture polyglot SDKs | `@inariwatch/capture` (Node/Py/Go/Rust/Java/C#/Browser) — capture errors, NOT AI dispatch |
| `@inariwatch/mcp` | npx init tool — stays as-is |
| External SDKs | `@slack/web-api`, Telegram bot SDK, Expo push SDK, GitHub Octokit, Vercel SDK — stay |
| `web/lib/ai/prompts.ts` | Prompt SSOT — stays. Router adapters call into it. |
| EAP receipt chain | Stays. Router emits receipts the same way as today. |
| MCP sampling-first protocol | Stays for tools that need client-LLM. Router only kicks in for `trigger_fix` and other non-sampling paths. |

---

## 8. What Changes (refactor surface)

| File / Area | Change |
|---|---|
| `web/lib/ai/auto-analyze.ts` | Replace direct provider call with `dispatch({ task: "alert.auto-analyze", ... })` |
| `web/lib/ai/remediate.ts` | Same — `dispatch({ task: "code.fix.single-shot" \| "code.fix.agent-loop", ... })` |
| `web/lib/ai/correlate.ts` | `dispatch({ task: "alert.correlate", ... })` |
| `web/lib/ai/risk-assessment.ts` | `dispatch({ task: "code.risk.assess", ... })` |
| `web/lib/ai/postmortem.ts` | Splits into `code.review.security` (cloud RCA) + `notify.compose.postmortem-prose` (local prose) |
| `web/lib/ai/prediction.ts` | `dispatch({ task: "gate.prediction", ... })` |
| `web/lib/ai/security-scan.ts` (AI layer) | `dispatch({ task: "code.review.security", ... })` |
| `web/lib/ai/managed-agent.ts` | Internal, but becomes a substrate adapter inside router |
| `web/lib/ai/container-agent.ts` | Same |
| `web/lib/ai/agentic-loop.ts` | Same |
| `web/lib/notifications/*` | Email/push/Slack/Telegram body composition switches to `dispatch({ task: "notify.compose.<channel>", ... })` |
| `web/lib/slack/blocks.ts` | Block layout stays cloud-side (deterministic); prose inside blocks via dispatch |
| `web/lib/telegram/format.ts` | Same — formatting deterministic; prose via dispatch |
| `desktop/src-tauri/src/openai_client.rs` (S18) | Becomes a router adapter; sidecar exposes router-protocol HTTP loopback |
| `desktop/src/.../chat.tsx` (S18 frontend) | Calls Tauri command that calls router |
| `cli/src/...` (Rust) | Router accessed via FFI binding OR HTTP loopback to sidecar |
| `capture/src/redact.ts` (NEW in Phase 5) | New file; uses router (substrate: capture-embedded if available) |
| All tests | Existing AI tests get a router mock; provider mocks move into router test fixtures |

---

## 9. Lockdown Rules (enforce after Phase 1)

**After Phase 1 lands, the following becomes prohibited:**

1. ❌ Importing `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@google/generative-ai`, etc. **outside `packages/ai-router/src/providers/`**.
2. ❌ Calling provider APIs directly from any surface code (`web/lib/`, `web/app/`, `desktop/src/`, `desktop/src-tauri/src/` outside router adapter, `cli/src/` outside router adapter, `capture/src/`).
3. ❌ Adding a new AI feature without first defining its task in `packages/ai-router/src/tasks.ts` and a routing rule in `rules.ts`.

**Enforcement:**
- ESLint custom rule: `no-direct-ai-sdk-import` — fails CI if any non-router file imports a provider SDK.
- Rust: `cargo deny` rule blocking direct `reqwest` calls to OpenAI/Anthropic endpoints outside `crates/ai-router-rs/`.
- Code review checklist gets an "AI router" line item.

---

## 10. Migration Phases

| Fase | Trabajo | Sesiones | User-visible |
|---|---|---|---|
| **0** | This document. Decisiones lockeadas. Sin código. | 0.25 | No |
| **1** | `packages/ai-router/` package (TS) — taxonomy + rules + dispatch + adapters para los 6 cloud providers actuales. Wirear web's `lib/ai/*` para pasar por router. **Reglas: TODO cloud (zero behavior change).** ESLint rule activada. | 1 (~6h) | No |
| **2** | WS relay (`relay.inariwatch.com`) — Hetzner Caddy + Go service. Auth (JWT). Inari Live registra al boot. Web dispatch path. | 1 (~6h) | No |
| **3** | Primer task migrado a local: `notify.compose.email`. Eval harness valida calidad. Behind workspace flag `localNotifyEnabled`. | 1 (~6h) | **Sí — primera demo end-to-end** |
| **4** | Resto de `notify.*`: Slack, Telegram, push, digest, status-page, postmortem-prose. WhatsApp + voice (Piper TTS) son NUEVAS superficies que vienen ya local. | 2 (~12h) | Sí |
| **5** | Capture embedded (`@inariwatch/capture` Node) — opcional `redact.pii.breadcrumbs` con onnxruntime in-process. Si no está disponible → fallback al router cloud. | 1 (~6h) | Sí (privacy claim) |
| **6** | CLI Rust + MCP usan el mismo router (FFI o loopback). Cierra el círculo. Lockdown rules en CI. | 1 (~4h) | No (consolidación) |

**Total: ~7 sesiones (40h efectivas).** Comienza después de S31 (unsigned pipeline) y S32 (waitlist) de v0.2.

---

## 11. Eval Harness (shared across substrates)

`packages/ai-router/src/eval/` — same fixtures, same rubric, runs against any substrate.

- **Corpus:** `eval/corpora/` — categorized by task. E.g., `notify-compose-email/` = 200 alert objects + 200 reference message bodies (human-rated).
- **Runner:** `eval/run.ts task=notify.compose.email substrate=user-sidecar model=llama-3.2-3b-q4` → outputs scoring.
- **Rubric:** per task, rubric JSON defines acceptable variance (length range, required entities, tone keywords).
- **CI:** weekly cron runs full eval on cloud + local substrates → posts diff to `/admin/ai-eval`.
- **Public page:** `/local-vs-cloud` shows the comparison weekly. Honesty wins.

---

## 12. Receipts (EAP)

Every dispatch emits an EAP receipt. Receipt fields:
- `task`, `payload_hash`, `response_hash`
- `substrate` (cloud / user-sidecar / capture-embedded / cli-linked)
- `provider`, `model`, `version`
- `ts_start`, `ts_end`
- `workspace_id`, `user_id`
- `relay_path` (if went through relay) or `direct` (if same-process)
- Signed by either:
  - Cloud key (web's existing EAP key) for cloud substrates
  - User's local Ed25519 key (S27/S28 chain) for user-sidecar/capture-embedded/cli-linked

The unified claim: **"Every AI action InariWatch takes — code fix or notification compose — has a verifiable receipt. We can prove WHO ran the model, WHERE it ran, and WHAT it produced."**

This is the moat. No competitor has this end-to-end.

---

## 13. Open Questions (deferred — NOT blockers)

### 13.1 E2E encryption on relay
Should the relay carry encrypted payloads (web encrypts → Inari Live decrypts), so even a relay breach doesn't leak alert content? Adds ~50ms RTT overhead. Decide in Phase 2 design. Default: yes if compatible with WS framing budget.

### 13.2 Substrate auto-detection in Capture
For Node Capture in long-running processes — should `@inariwatch/capture` ship with a tiny ONNX model bundled, or download on first use? Tension: zero-deps philosophy vs. zero-config local AI. Decide in Phase 5.

### 13.3 Mobile (Expo) AI calls
Mobile today consumes web AI. Should it also be able to dispatch to user-sidecar via relay? Probably yes for `chat.conversational` when on same WiFi. Defer to post-Phase 6.

### 13.4 BYOK + local routing interaction
If a workspace has BYOK Claude key AND user has Inari Live online — for `notify.compose.email`, do we use BYOK (their preference) or local (substrate priority)? Default: substrate priority wins for `notify.*` (privacy goal); BYOK wins for `code.*` (quality goal). Document explicitly.

### 13.5 MCP sampling-first vs router
MCP's sampling-first model passes the analysis to the client LLM. Does the router intercept MCP responses? No — sampling-first is intentional preservation of client agency. Router only handles InariWatch-internal AI dispatch.

### 13.6 Cost telemetry
Per-task, per-substrate, per-workspace cost tracking. Already exists for cloud; needs equivalent for local (compute-time as proxy for cost). Phase 4 adds this to `/admin/ops`.

### 13.7 Model registry sharing
Inari Live's `registry::catalogue()` (S21) lists models with BLAKE3 hashes. Should the router use this same registry, or have its own? **Same registry.** Single SSOT for model identity. Phase 1 wires it in.

---

## 14. The Lockdown Commitment

> **After Phase 1 lands: NO new AI feature in ANY surface enters the codebase without a task in `packages/ai-router/src/tasks.ts`, a rule in `rules.ts`, and going through `dispatch()`. ESLint + cargo deny enforce this in CI. Code review rejects bypass attempts.**
>
> This commitment is what turns "5 fragmented AI implementations" into "one coherent product" and prevents drift back to fragmentation. Any future session — mine, Jesus's, a parallel session — that adds AI must read THIS document first.

---

## 15. Marketing One-Liner (locked claim)

> **InariWatch is one product, one AI brain, that runs in the right place automatically. We use the best cloud models to fix your code. We use local models on your hardware to compose your notifications. Every action is cryptographically verifiable. Your stack traces never leave your machine for prose composition. Your code never goes to a model that isn't best-in-class for the job.**

---

## Appendix A — File map after Phase 1

```
packages/ai-router/                    NEW
├── package.json                       workspace:*, NOT published
├── src/
│   ├── index.ts                       exports dispatch()
│   ├── dispatch.ts                    router core
│   ├── tasks.ts                       task taxonomy enum
│   ├── rules.ts                       routing rules config
│   ├── providers/
│   │   ├── openai.ts                  ONLY file that imports `openai`
│   │   ├── anthropic.ts
│   │   ├── groq.ts
│   │   ├── google.ts
│   │   ├── grok.ts
│   │   ├── deepseek.ts
│   │   ├── user-sidecar.ts            HTTP loopback to Inari Live (Phase 2)
│   │   ├── relay.ts                   WS to relay.inariwatch.com (Phase 2)
│   │   ├── capture-embedded.ts        in-process onnxruntime (Phase 5)
│   │   └── cli-linked.ts              FFI to llama.cpp (Phase 6)
│   ├── eval/
│   │   ├── corpora/                   eval datasets per task
│   │   ├── rubrics/                   per-task scoring
│   │   └── run.ts                     CLI runner
│   ├── receipts.ts                    EAP receipt emission
│   └── lockdown/
│       ├── eslint-rule.js             custom no-direct-ai-sdk-import
│       └── cargo-deny.toml            Rust equivalent

crates/ai-router-rs/                   NEW (Phase 6)
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── dispatch.rs
    └── adapters/
        ├── llamacpp.rs
        └── http_proxy.rs              hits web's router via /api/ai/dispatch

services/relay/                        NEW (Phase 2)
├── main.go                            Hetzner Go service
├── auth.go
├── ws.go
└── deploy/
    └── caddy.snippet                  routes wss://relay.inariwatch.com → :9402
```

---

**END OF DOCUMENT — DO NOT MODIFY WITHOUT JESUS APPROVAL.**
