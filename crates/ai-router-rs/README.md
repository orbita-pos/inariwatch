# `ai-router-rs`

Rust mirror of [`@inariwatch/ai-router`](../../packages/ai-router/). Single
dispatch entry point for every AI call originating from `cli/` and
`desktop/src-tauri/`.

> **Status:** v0.3 S7 — LOCKDOWN ACTIVE 2026-05-02. Per
> [`INARI_AI_ARCHITECTURE.md`](../../INARI_AI_ARCHITECTURE.md) §9, no
> Rust source outside this crate may issue HTTP requests to provider
> endpoints (`api.openai.com`, `api.anthropic.com`, `api.groq.com`,
> `api.x.ai`, `api.deepseek.com`, `generativelanguage.googleapis.com`).
> The integration test [`tests/lockdown.rs`](tests/lockdown.rs)
> enforces this on every CI run.

## Why this crate exists

Pre-S7, the CLI and the Inari Live desktop sidecar each shipped their
own ad-hoc OpenAI / Claude HTTP client (`cli/src/ai/mod.rs` and
`desktop/src-tauri/src/ai/openai.rs`). Two routers, two retry policies,
two SSE parsers, two URL boundaries — Frankenstein. S7 collapses them
into one crate with one HTTP boundary.

## Public surface

```rust
use ai_router_rs::{dispatch, dispatch_stream, AIMessage, DispatchInput, TaskName};

let msgs = vec![AIMessage::user("explain this stack trace")];
let mut input = DispatchInput::new(
    TaskName::ChatCode,
    api_key,
    "be terse",
    &msgs,
    1024,
);
let response = dispatch(input).await?;
println!("{}", response.text);
```

`dispatch_stream` returns `Stream<Item = Result<ChatChunk, _>>` for
token-by-token chat (Inari Live's S18 dock chat).

## Architecture

| Module | Mirrors |
|---|---|
| `tasks` | `packages/ai-router/src/tasks.ts` — 30 task variants, byte-identical wire names |
| `rules` | `packages/ai-router/src/rules.ts` — `Rule` / `Target` / `WorkspacePreferences` + `resolve_primary` |
| `dispatch` | `packages/ai-router/src/dispatch.ts` — `dispatch()` + `dispatch_stream()` + fallback policy |
| `receipts` | `packages/ai-router/src/receipts.ts` — `RouterReceipt` + sink registry (metadata-only, no Ed25519 in Phase 1) |
| `providers/openai_compat` | OpenAI / Grok / Gemini / DeepSeek / Groq HTTP adapter |
| `providers/anthropic` | Claude `/v1/messages` HTTP adapter |
| `adapters/cloud_proxy` | Dual-mode (Direct + Proxy) cloud-substrate runner |
| `adapters/llamacpp` | `LocalSidecar` trait — Inari Live wires its own llama.cpp impl |

## Lockdown enforcement

Two complementary checks gate the boundary:

1. **Integration test** — [`tests/lockdown.rs`](tests/lockdown.rs)
   walks every `.rs` file under `cli/src/` and `desktop/src-tauri/src/`
   and panics if a literal provider URL is found. This is the
   authoritative source-level enforcement; runs on every PR via
   `.github/workflows/ai-router-rs-ci.yml`.

2. **`cargo deny`** — [`deny.toml`](deny.toml) enforces dependency-graph
   constraints (license + advisories) but does **not** grep source.
   Cargo-deny in a multi-crate path-dep tree without a workspace root
   has known false positives for the source-grep pattern; we use it
   only for `[advisories]` and let the integration test own lockdown.

If you genuinely need to mention a provider URL in a comment in a
non-router source file (e.g., a TODO that references where a value
came from), break up the URL: `api .openai .com` → `the OpenAI host`,
or describe it as "the provider's chat completions endpoint."

## Cloud routing — dual-mode

`adapters::cloud_proxy::CloudMode::from_env` resolves at every dispatch:

| Condition                                     | Mode    |
|-----------------------------------------------|---------|
| `INARI_AI_DIRECT=true` (or `=1`)              | Direct  |
| `INARI_WEB_URL` + `INARI_WEB_TOKEN` both set  | Proxy   |
| otherwise                                     | Direct  |

**Direct mode** — the Rust caller has a BYOK / platform key. We pick
a provider via `pickProvider` (caller override → key prefix → rule
hint → `openai` default), instantiate the matching adapter from
`providers/`, and issue the HTTP call. Provider URL strings live only
in `providers/openai_compat.rs` and `providers/anthropic.rs`.

**Proxy mode** — env vars set. We POST the dispatch payload to
`<INARI_WEB_URL>/api/ai/dispatch` (Bearer auth via `INARI_WEB_TOKEN`).
The web side authenticates against `apiKeys` (service in {desktop,
cli}), resolves the actual provider key via `web/lib/ai/get-key.ts`,
and forwards into the canonical TS `dispatch()` (`packages/ai-router`).

CLI standalone with BYOK lands in Direct (no env vars set in the
default `~/.inariwatch/config.toml` flow). Cloud-authed Inari Live
+ future cloud-authed CLI land in Proxy after Phase 1 of v0.4 wires
the device-flow auth.

## Receipts — metadata-only in Phase 1

Mirrors `packages/ai-router/src/receipts.ts`: every dispatch emits a
`RouterReceipt` with task / substrate / provider / model / token usage
/ workspace identity, and `signature: None`. The TS side is also
metadata-only (verified against `web/lib/ai-router/persist-receipt.ts`
which leaves `cloudReceipt: null` and never signs). When TS adds
Ed25519 signing in Phase 4+, this crate adds it too — both sides move
in lockstep.

## Development

```bash
cd crates/ai-router-rs
cargo test                  # 65 lib + 3 lockdown tests
cargo check --lib --tests   # quick compile validation
```

`RUST_TEST_THREADS=1` is locked via `.cargo/config.toml` because
several tests touch global registries (sink table, sidecar slot,
`INARI_*` env vars). Parallel execution races on those.

## Adding a new task

1. Add a variant to [`src/tasks.rs`](src/tasks.rs) with the same wire
   string the TS side uses.
2. Add the variant to `from_str`, `as_str`, `namespace_of`, and
   `ALL_TASKS`. The compiler will refuse to build until all four are
   present.
3. Add a rule to [`src/rules.rs`](src/rules.rs) `get_rule()`.
4. Mirror steps 1–3 in `packages/ai-router/src/tasks.ts` and
   `rules.ts` if the TS side does not already have them. The
   `tasks::tests::ts_string_parity` test catches drift between the
   two.
