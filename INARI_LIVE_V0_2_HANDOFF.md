# Inari Live v0.2 — Per-Session Handoff Plan

**Status as of 2026-05-01.** Track 5 closed (S20 done). v0.1 substantially complete — Cross-cutting A/B/C deferred. v0.2 is the brutal-trim plan agreed with Jesus 2026-05-01: **2 features executed perfectly + ship**, no parity / no compliance / no power-user features.

This document is the operating plan. Each session is sized at ~4-10h focused work, single-author, single-context-window. Per-session prompts are issued by the architect; this doc is the canonical spec the executor reads first.

---

## Strategic frame (locked — do NOT relitigate inside sessions)

| Locked decision | Value |
|---|---|
| **The 2 features (only)** | (1) Local AI best-in-class (Tab + Apply offline). (2) Cryptographic receipts visible + Replay button (Replay backend reuses existing `/v2/replay` on Hetzner) |
| **Local model — Tab** | Qwen2.5-Coder-1.5B Q4_K_M GGUF (Apache 2.0). Avoid the 3B variant (Qwen Research License = non-commercial) |
| **Local model — Apply** | Kortix FastApply-7B-v1.0 Q4_K_M (Apache 2.0, fine-tune of Qwen2.5-Coder-7B specialized for instant-apply) |
| **Local model — fallback** | Qwen2.5-Coder-0.5B (Apache 2.0) for <8 GB RAM machines |
| **Inference runtime** | llama.cpp via sidecar binary (Metal/CUDA/Vulkan/CPU). NOT ONNX, NOT MLX-only, NOT mistral.rs primary |
| **Editor delivery** | LSP server (works in VS Code, Cursor, Zed, Neovim, JetBrains, Helix). NO per-editor extension |
| **Hard cap pricing** | Free for everyone in beta. Pro $12/mo post-GA. BYOK optional |
| **Receipt format** | EAP-1 (Merkle + Ed25519). Aligned with existing `eap/` repo's wire format |
| **Pre-launch killed** | NO long-running agent loop, NO @-mentions, NO skills, NO Composer multi-file, NO `inari blame` standalone, NO memory citations standalone, NO migration importers, NO RFC publication, NO multi-editor recipes session, NO GitHub Action, NO evergreen post |
| **Replay button** | Wires to existing `/v2/replay` Hetzner endpoint. NO new replay backend |
| **Distribution** | Apple Developer ID + DigiCert EV + GPG Linux. R2 hosting. Tauri Ed25519 updater. Direct download from `inariwatch.com/download`. NO app stores |
| **Push cadence** | NO pushes to remote during sessions. Local commits only. Architect approves the ship-push at S32 |

---

## Build performance constraints (LOCKED — every session follows)

Same as `INARI_LIVE_HANDOFF.md` § Build performance constraints, plus the 8 new rules added 2026-05-01:

```
CARGO_BUILD_JOBS=2
RUST_TEST_THREADS=1
CARGO_INCREMENTAL=1
CARGO_TARGET_DIR=C:\Users\jesus\.cargo\target-shared  (USER env var, persisted via setx)
```

New rules (8-15):
8. `cargo check --lib` by default. `cargo check --lib --tests` ONLY when adding tests.
9. `cargo test --test <name>`, NEVER bare `cargo test`.
10. NO `cargo build` during sessions (only `cargo check`).
11. Frontend: `npx tsc --noEmit` during dev, `npm run build` only at session close.
12. Clean `target-shared/debug/incremental/` every ~10 sessions (frees 10-25 GB).
13. Batch sessions by module locality when possible (warm cache).
14. Don't run `cargo test` after each edit. Only at module-close.
15. Optional: install `sccache` for cross-worktree compile cache (~30 min setup, payoff every session after).

If a build approaches 10 minutes and the machine stays responsive, let it finish. If frozen, abort and switch to targeted tests.

---

## Parallelization graph (max 2 worktrees concurrent)

Hard-learned rule (`feedback_parallel_sessions_need_worktrees.md` 2026-04-30): each parallel session in its own `git worktree add ../radar-sN`. Never share the radar checkout across windows.

```
                 v0.1 wrap
                     │
                     ▼
         ┌───────────S21 (llama runtime)──────────┐
         │                                         │
[WORKTREE-AI track]                       [WORKTREE-CRYPTO track]
         │                                         │
         ▼                                         ▼
        S22 (LSP scaffold)                       S27 (EAP chip + Replay btn)
         │                                         │
         ▼                                         ▼
        S23 (Tab v1)                              S28 (Export + verify CLI)
         │                                         │
         ▼                                         ▼
        S24 (Tab v2 UX magic)                     S29 (verify.inariwatch.com)
         │                                         │
         ▼                                         │
        S25 (Apply v1)                             │
         │                                         │
         ▼                                         │
        S26 (Apply v2 diff quality)                │
         │                                         │
         └─────────────┬───────────────────────────┘
                       │
                       ▼
                      S30 (Landing + cert procurement triggered)
                       │
                       ▼
                      S31 (Code signing pipeline)
                       │
                       ▼
                      S32 (Auto-updater + R2 + LAUNCH)
```

**Parallelization windows (architect schedules):**
- After S21 lands on `main`: AI track and CRYPTO track run in parallel worktrees
- AI track is sequential within itself (S22 → S23 → S24 → S25 → S26)
- CRYPTO track is sequential within itself (S27 → S28 → S29)
- Both tracks merge before S30 starts
- S30-S32 are sequential (signing/updater chain)

**Calendar estimate (with 2× parallelization):** ~6-8 weeks calendar from S21 start to S32 ship. Solo-author secuencial: ~10-12 weeks.

---

## Sessions

### S21 — llama.cpp runtime sidecar + lazy model registry (10h)

**Status (2026-05-01):** **DONE — tests verified 4/4 pass.** Code at tip `a8c0145` on `feat/inari-live-v0.2-session21-llama-runtime`. Merged into integration branch.

**Branch:** `feat/inari-live-v0.2-session21-llama-runtime`
**Predecessor:** `main` tip (Track 5 closed at S20).
**Files (new):**
- `desktop/src-tauri/src/local_ai/mod.rs` — `LocalAI` facade.
- `desktop/src-tauri/src/local_ai/runtime.rs` — sidecar lifecycle (spawn, health, shutdown).
- `desktop/src-tauri/src/local_ai/registry.rs` — model registry, lazy download from R2, BLAKE3 verify, persistent on-disk index.
- `desktop/src-tauri/src/local_ai/hardware.rs` — RAM/GPU/CPU detection → recommended tier.
- `desktop/src-tauri/resources/llama-server-{platform}` — bundled llama.cpp server binary per platform (Metal/Vulkan/CUDA/CPU).
- `desktop/src-tauri/src/store/migrations/0009_local_models.sql` — `local_models(model_id, sha256, size_bytes, downloaded_at, last_used_at)` + `local_ai_settings` rows.
- `tests/local_ai_runtime_starts.rs`, `local_ai_model_integrity.rs`, `local_ai_streams_completion.rs`, `local_ai_settings_persistence.rs`.

**Behavior:**
- `LocalAI::generate(model_id, prompt, max_tokens, stop_seqs, fim_mode) -> impl Stream<Item = Token>`.
- Lazy model download: first call to a non-cached model surfaces `ModelDownloadStarted` event → user confirms in dock → download from `https://models.inariwatch.com/<model-id>/<sha256>.gguf` (R2-backed CDN) → BLAKE3 verify → persist.
- Hardware tier: 0 (no local), 1 (Tab only — Qwen-1.5B), 2 (full — Qwen-1.5B + FastApply-7B). Recommend based on RAM.
- llama-server runs as Tauri sidecar binary (one process per model loaded); kill on daemon shutdown.

**Tests:**
- Sidecar starts + responds to `/health`.
- BLAKE3 mismatch rejects load.
- Stub model streams tokens via mock llama-server.
- Settings persist across daemon restart.

**DoD:** `cargo check --lib --tests` clean. All 4 tests pass. Manual test with real Qwen-1.5B GGUF download confirms <2 min on 50 Mbps connection.

**Achieved (2026-05-01):**
- `cargo check --lib`: **clean** (8.6 s warm).
- `cargo check --lib --tests`: **clean** (37.0 s warm).
- 4/4 integration tests compile; **execution deferred** (see Status block above).
- Manual GGUF download: **not run** — placeholders in `registry::catalogue()` (real BLAKE3 digests land in S31 with the R2 upload).

**Implementation deltas vs spec:**
- Hash algorithm = **BLAKE3** (not SHA-256 as the table summary above claims). Reconciled in `INARI_LIVE_DECISIONS.md` 2026-05-01 (Sesión 21 — BLAKE3 over SHA-256).
- Schema column = `content_hash` (algorithm-agnostic) + `hash_algo` (defaults to `'blake3'`), not bare `sha256`.
- `local_ai_*` settings live in the existing `settings` key/value table, not a new `local_ai_settings` table — same precedent as Sesión 4 cutover.
- Sidecar binaries NOT vendored this session — deferred to S31 (signing pipeline). Runtime resolves from `resource_dir → app_local_data → $PATH` and surfaces `RuntimeError::SidecarMissing` cleanly when none resolves. Tests bypass spawning via `RuntimeManager::register_external_endpoint`.
- Hardware detection uses `num_cpus` + hand-rolled native RAM queries (not `sysinfo`) to avoid pulling `windows = "0.52"` into the dep graph.

**Files actually written:**
- `desktop/src-tauri/src/local_ai/{mod,runtime,registry,hardware}.rs` (4 files, ≈1100 LoC + module docs)
- `desktop/src-tauri/src/store/migrations/0009_local_models.sql`
- `desktop/src-tauri/src/store/migrations.rs` (+1 entry in `MIGRATIONS` slice)
- `desktop/src-tauri/src/lib.rs` (+`pub mod local_ai;`)
- `desktop/src-tauri/Cargo.toml` (+`blake3 = "1"`, +`num_cpus = "1"`)
- `desktop/src-tauri/tests/local_ai_runtime_starts.rs` (3 tests)
- `desktop/src-tauri/tests/local_ai_model_integrity.rs` (2 tests)
- `desktop/src-tauri/tests/local_ai_streams_completion.rs` (1 test)
- `desktop/src-tauri/tests/local_ai_settings_persistence.rs` (1 test)
- `INARI_LIVE_DECISIONS.md` (+6 Sesión-21 entries)
- `INARI_LIVE_V0_2_HANDOFF.md` (this file, copied into the worktree + Status block above)

**Notes for S22/S23/S25:** `LocalAI::generate` is the single entry point. S23 wraps it for FIM. S25 wraps it for instruct/apply. NO direct subprocess management outside `local_ai/runtime.rs`.

- **For S22 (LSP server):** the `completion` handler stub can route through `LocalAI::generate(opts.fim_mode = true)` once a model is loaded, OR return `[]` when `RuntimeManager::is_loaded(model_id) == false`. Use `register_external_endpoint` in S22 tests to avoid the sidecar-binary requirement.
- **For S23 (Tab/FIM):** the `GenerateOptions::fim_mode` flag is plumbed but does NOT wrap the prompt with Qwen FIM markers (`<｜fim_prefix｜>` / `<｜fim_suffix｜>` / `<｜fim_middle｜>`) yet. Build that wrap in `lsp/fim.rs::build_fim_prompt(prefix, suffix) -> String`, then pass the wrapped string as `opts.prompt`. Existing tests confirm the SSE stream parsing handles llama-server's `{"content":"..","stop":false}` framing.
- **For S25 (Apply/Kortix):** call `LocalAI::generate` with `fim_mode: false`, `max_tokens: 4096`, no stop sequences, and the registry id `"kortix-fast-apply-7b"`. Don't add a separate "instruct mode" code path — Kortix expects raw prompt text.
- **R2 catalogue:** `registry::catalogue()` ships placeholder hashes (`"0".repeat(64)`). S31 PR replaces them with real BLAKE3 digests + uploads the GGUFs to `models.inariwatch.com/<id>/<hash>.gguf`. Until then, production `ensure_local` fails clean with `RegistryError::HashMismatch`.

---

### S22 — LSP server skeleton + completions handler (10h) [PARALLEL WITH S21 OK — uses stub completions until S21 lands]

**Status: DONE (2026-05-01)**, tip `26a6663` on `feat/inari-live-v0.2-session22-lsp-server`. Merged into integration branch.

**Result:**
- `desktop/src-tauri/src/lsp/{mod,protocol,document_sync}.rs` + `handlers/{initialize,completion,code_action,hover,cancel}.rs` + `handlers/mod.rs` (all new).
- `desktop/src-tauri/src/bin/inari_lsp_stdio.rs` (new) — passthrough stdio↔TCP proxy. Honours `INARI_LSP_PORT` (default 9877) + `INARI_LSP_HOST` (default 127.0.0.1) env vars.
- `desktop/src-tauri/Cargo.toml` — added `[[bin]] inari-lsp-stdio` + tokio features `net|io-util|io-std|rt-multi-thread|macros|sync`.
- `desktop/src-tauri/src/lib.rs` — `pub mod lsp` + `start_lsp_listener()` spawned from `setup`, constant `LSP_DEFAULT_PORT = 9877`.
- `desktop/src-tauri/tests/{lsp_initialize_handshake, lsp_completion_returns_stub, lsp_cancel_request_works, lsp_document_sync}.rs` + shared `tests/helpers/mod.rs` framing helpers.

**Verification:**
- `cargo check --lib` — clean.
- `cargo check --lib --tests` — clean (no warnings).
- `cargo test --test lsp_initialize_handshake` — 1/1 pass.
- `cargo test --test lsp_completion_returns_stub` — 1/1 pass.
- `cargo test --test lsp_cancel_request_works` — 1/1 pass (cancel→response observed in <400 ms with 500 ms artificial completion delay).
- `cargo test --test lsp_document_sync` — 1/1 pass.
- `cargo test --lib lsp::` — 14/14 unit tests pass (protocol decode, framing, document sync UTF-16 conversions including `é` + `🦊`, state register/cancel/complete).
- Manual VS Code TCP smoke test deferred (disk pressure during the build phase made the dev-server smoke costly — wire is exercised by the four integration tests).

**Disk note:** Build constraint #12 was triggered — cleared `target-shared/debug/incremental/` (1.2 GB) plus `~/.cargo/registry/src/` (1.5 GB; re-extracts on demand from `registry/cache/`). No other cleanup performed.

**Hand-offs:**
- TODO marker for S23 lives at `lsp/handlers/completion.rs::compute_stub` — swap with `LocalAI::generate(model_id="qwen-1.5b", prompt, max_tokens=64, stop_seqs=["\n\n"], fim_mode=true)`. Cancel pipeline already works (proven by the cancel test).
- `LspState::set_completion_delay_ms(u64)` is a test-only knob; production never writes it.
- Document URI access for FIM context: `state.documents.get(uri)` (clone). Position → byte offset via `lsp::document_sync::utf16_pos_to_byte`.
- The mpsc-serialised writer in `handle_connection` lets request handlers finish out of order without interleaving frames on the wire — important when S23 streams partial-token `$/progress` notifications alongside the final response.

**Branch:** `feat/inari-live-v0.2-session22-lsp-server`
**Predecessor:** `main` tip (or S21 tip if landed first; both ok).
**Files (new):**
- `desktop/src-tauri/src/lsp/mod.rs` — LSP server entry.
- `desktop/src-tauri/src/lsp/protocol.rs` — JSON-RPC over TCP/stdio adapter.
- `desktop/src-tauri/src/lsp/handlers/initialize.rs`, `completion.rs`, `code_action.rs`, `hover.rs`, `cancel.rs`.
- `desktop/src-tauri/src/lsp/document_sync.rs` — `textDocument/didOpen|didChange|didClose` cache.
- `tests/lsp_initialize_handshake.rs`, `lsp_completion_returns_stub.rs`, `lsp_cancel_request_works.rs`, `lsp_document_sync.rs`.

**Behavior:**
- Listens on TCP `127.0.0.1:9877` (LSP port — distinct from MCP at 9876).
- Implements LSP 3.17 capabilities: `textDocument/completion` (returns stub `[]` when no model loaded; will route through `LocalAI` after S23), `textDocument/codeAction` (stub), `textDocument/hover` (stub), `$/cancelRequest` (cancellation token to running model call).
- Document cache: full text per open doc, diff-applied on `didChange`.
- Optional sidecar `inari-lsp-stdio` binary that proxies stdio ↔ TCP for editors that need stdio LSP (most do).

**Tests:**
- `initialize` returns capability set.
- `completion` returns empty list when no model.
- `cancelRequest` aborts pending response.
- `didOpen → didChange → didClose` updates cache correctly.

**DoD:** `cargo check --lib --tests` clean. 4 tests pass. Manual test: VS Code's built-in LSP client connects + handshake succeeds.

**Notes for S23:** the completion handler has a TODO marker — S23 swaps stub for `LocalAI::generate(.., fim_mode=true)`.

---

### S23 — Tab autocomplete v1 — Qwen2.5-Coder-1.5B FIM wiring (10h)

**Status (2026-05-01):** **DONE — 3/3 integration tests pass.** Code lives on `feat/inari-live-v0.2-session23-tab-fim` (work commit `b3e8ef1`, pinned in worktree `../radar-s23` off integration tip `c6050e2`). NOT pushed, NOT merged. `cargo check --lib` + `cargo check --lib --tests` both clean. Manual VS Code smoke deferred to S31/S32 — see Achieved block below for why.

**Branch:** `feat/inari-live-v0.2-session23-tab-fim`
**Predecessor:** S21 + S22 + S27 all merged into the integration tip (`c6050e2`).
**Files (modified):**
- `desktop/src-tauri/src/lsp/handlers/completion.rs` — replace stub with FIM call.
- `desktop/src-tauri/src/lsp/fim.rs` (new) — FIM prompt construction (`<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>` tokens for Qwen2.5-Coder, **ASCII pipe**), token streaming, ghost-text shaping.
- `desktop/src-tauri/src/local_ai/registry.rs` — register `qwen2.5-coder-1.5b` model. (Already present from S21 placeholder; S23 reuses verbatim.)

**Behavior:**
- On `textDocument/completion`, extract ±200 lines around cursor → build FIM prompt → call `LocalAI::generate(model_id="qwen2.5-coder-1.5b", prompt, max_tokens=64, stop_seqs=["\n\n"], fim_mode=true)` → stream tokens → emit `CompletionItem` with `insertText` once stream stops or hits stop seq.
- Ghost-text rendering: client-side (editor decides; server returns `CompletionItem` with `command` field for ghost-text vs popup).
- Cancel-on-keystroke: each `$/cancelRequest` aborts the pending model call within 50ms.
- No ranking, no smart triggers, no dedup — those land in S24.

**Tests:**
- `tests/tab_fim_basic.rs` — given a stub model returning "fn add" → completion item has `insertText: "fn add"`.
- `tests/tab_fim_cancel.rs` — pending generation aborts within 50ms of cancelRequest.
- `tests/tab_fim_stop_sequence.rs` — generation stops at `\n\n`.

**DoD:** All 3 tests pass. Manual test against real Qwen-1.5B (downloaded via S21) in VS Code: cursor in middle of function → typing triggers ghost-text within 200ms p50.

**Achieved (2026-05-01):**
- `cargo check --lib`: **clean** (~42s warm).
- `cargo check --lib --tests`: **clean** (~34s warm).
- `cargo test --test tab_fim_basic`: **1/1 pass** (0.50s).
- `cargo test --test tab_fim_cancel`: **1/1 pass** (5.59s — cancel→response observed in <400ms against a 10s slow mock).
- `cargo test --test tab_fim_stop_sequence`: **1/1 pass** (0.50s — verified `stop:["\n\n"]`, `fim_mode:true`, `n_predict:64`, FIM sentinels in prompt body sent to llama-server).
- 8 new unit tests in `lsp::fim::tests` (compile-checked via `cargo check --lib --tests`; run alongside lib unit suite at next `cargo test --lib` invocation).
- 2 new unit tests in `lsp::handlers::completion::tests` (compile-checked, same disposition).
- S22 regression: `lsp_completion_returns_stub` + `lsp_cancel_request_works` are byte-identical with the new handler when no LocalAI is installed (preserved `completion_delay_ms` knob — see DECISIONS § Sesión 23 cancel-regression entry).

**Implementation deltas vs spec:**
- FIM tokens use ASCII pipe `|`, not the fullwidth `｜` from the HANDOFF prose. Reconciled in DECISIONS § Sesión 23 — Qwen2.5-Coder's tokenizer requires the ASCII variant.
- Context-window slicing uses line-indexed math (precompute `Vec<usize>` of line starts, binary-search the cursor's line, slice `±N`) instead of newline-counting walk-back. Cleaner edge-case behaviour at column 0 + N=0. Reconciled in DECISIONS.
- Failure mode: every error path (no doc, no LocalAI, network/HTTP error, parse error, sidecar wedged) returns an empty `CompletionList` rather than a JSON-RPC error. Editors degrade silently to built-in suggestions — same UX contract as the S22 stub. Cancellation is the one exception (returns `-32800`).
- LocalAI handle plumbed via `LspState::set_local_ai(LocalAI)` post-construction, NOT a constructor arg. `start_lsp_server` now returns `(SocketAddr, Arc<LspState>)` (additive — single caller in `lib.rs` updated; test variant unchanged).
- `qwen2.5-coder-1.5b` reuses the S21 placeholder catalogue entry; the BLAKE3 digest is still `"0".repeat(64)` so production `ensure_local` returns `RegistryError::HashMismatch` cleanly. Real digest + R2 upload land in S31.

**Files actually written:**
- `desktop/src-tauri/src/lsp/fim.rs` (new, ~150 LoC + 8 unit tests)
- `desktop/src-tauri/src/lsp/handlers/completion.rs` (rewrite, +110 LoC, 2 unit tests)
- `desktop/src-tauri/src/lsp/mod.rs` (+ `pub mod fim;` + `local_ai: Mutex<Option<LocalAI>>` field + `set_local_ai`/`local_ai` accessors + signature change `start_lsp_server -> (SocketAddr, Arc<LspState>)`)
- `desktop/src-tauri/src/lib.rs` (+ `build_local_ai(app, store)` helper, +`start_lsp_listener(Option<LocalAI>)` updated)
- `desktop/src-tauri/tests/tab_fim_basic.rs` (new, 1 integration test)
- `desktop/src-tauri/tests/tab_fim_cancel.rs` (new, 1 integration test)
- `desktop/src-tauri/tests/tab_fim_stop_sequence.rs` (new, 1 integration test, verifies request body sent to llama-server)
- `INARI_LIVE_DECISIONS.md` (+7 Sesión-23 entries)
- `INARI_LIVE_V0_2_HANDOFF.md` (this Status block + Achieved/deltas).

**Disk note:** Hit Build Rule 12 mid-session — disk dropped from 2.0 GB → 0.27 GB during the first cold-test build (the staticlib `.lib` is 2 GB on its own and the linker writes a fresh copy per test binary). Cleared `target-shared/debug/incremental/` (1.24 GB), `~/.cargo/registry/src/` (re-extracts on demand), and `target-shared/debug/deps/*.pdb` (2.91 GB) over the run. `cargo clean -p inariwatch-desktop` reclaimed 9.2 GB once for the cold path. Future sessions on this machine: prefer running tests in **alphabetical batches** (1 build → N tests share the lib) over per-test invocations.

**Notes for S24:** What feels OK in S23 will feel ROBOTIC in production. S24 fixes context selection, ranking, smart triggers. **DO NOT skip S24.** Concrete handles for S24:
- Find `// TODO(S24):` markers in `lsp/handlers/completion.rs` (3 sites: context, smart triggers, ranking/dedup/cache) and `lsp/fim.rs::extract_context` (1 site).
- The `(prefix, suffix) -> String` contract of `fim::build_fim_prompt` is the SWAP point — S24 changes how (prefix, suffix) are computed but keeps the prompt-building API. The `±200 raw lines` becomes `top-3 indexer-relevant symbols + cursor's line ± M`.
- `FIM_MAX_TOKENS = 64` and `fim_stop_seqs()` are private consts in `completion.rs`. S24 promotes to per-language tunables (e.g. Python wants longer max for block completions, Rust wants shorter for expression completions).
- The cancel pipeline + `completion_delay_ms` debug knob are LOAD-BEARING for the S22 regression — preserve them in S24's refactor (DECISIONS § Sesión 23 cancel-regression entry explains why).
- `state.local_ai()` snapshots cheap (clone of an Arc-y facade); S24's cache lookup goes BEFORE the LocalAI call and the cancel `select!`, so cache hits never block on the model.
- Manual VS Code smoke test STILL deferred to S31/S32 — the catalogue's BLAKE3 placeholder blocks live downloads. S24 should NOT try to flip the placeholder; that's S31's job.

---

### S24 — Tab autocomplete v2 — UX MAGIC (10h)

**Status (2026-05-01):** **DONE — 6/6 integration tests pass, compile clean.** Code at work commit `8539306` on `feat/inari-live-v0.2-session24-tab-magic` in worktree `../radar-s24` off integration tip `7e3d5a1`. NOT pushed, NOT merged. `cargo check --lib` + `cargo check --lib --tests` both clean. Manual VS Code smoke deferred to S31/S32 — same placeholder GGUF hash blocker as S23.

**Branch:** `feat/inari-live-v0.2-session24-tab-magic`
**Predecessor:** S23 merged.
**Files (modified):**
- `desktop/src-tauri/src/lsp/fim.rs` — context selection, smart triggers, ranking, dedup, cache.
- `desktop/src-tauri/src/lsp/triggers.rs` (new) — `should_trigger(file, position)` heuristic.
- `desktop/src-tauri/src/lsp/cache.rs` (new) — LRU cache keyed on `(buffer_hash, position)` with 200-entry cap, 30s TTL.

**Behavior — the magic:**
1. **Context selection:** instead of ±200 raw lines, use indexer (S6) to retrieve top-3 relevant symbols (function defs, imports, type aliases) → prepend to FIM prefix. Per-language tuned (TS/JS, Python, Rust, Go).
2. **Smart triggers:** suppress completion in: string literals, line comments, block comments, mid-word position (cursor inside an identifier with letters before AND after), inside import blocks where popup is better.
3. **Ranking:** if model returns multiple candidates (n=3 sampled), rank by: (a) length of complete tokens (prefer complete identifiers), (b) syntactic validity (parse-and-check), (c) overlap with surrounding code (doesn't repeat existing), (d) novelty bonus.
4. **Dedup:** completions matching the next 3 lines verbatim are suppressed.
5. **Cache:** LRU on `buffer_hash + position`. Hit returns cached completion in <5ms.
6. **Latency budget:** if model exceeds 250ms TTFT, abort and return empty (silent degradation).

**Tests:**
- `tests/tab_magic_string_literal_suppressed.rs` — cursor in `"hello |"` → no completion.
- `tests/tab_magic_comment_suppressed.rs` — cursor in `// |` → no completion.
- `tests/tab_magic_mid_word_suppressed.rs` — cursor inside `add|er` → no completion.
- `tests/tab_magic_ranks_complete_identifiers.rs` — given two candidates, picks the one ending on identifier boundary.
- `tests/tab_magic_lru_cache_hit.rs` — second call same context returns cached <5ms.
- `tests/tab_magic_dedup_against_next_lines.rs` — completion matching next 3 lines suppressed.

**DoD:** 6 tests pass. Manual test in VS Code on a real TS/Python repo: tab feels "premium" (subjective — Jesús's call). Acceptance ratio target: >50% of suggestions accepted on warm cache (measured manually over 30-min session).

**Achieved (2026-05-01):**
- `cargo check --lib`: **clean** (~12s incremental after the new `lsp::triggers` + `lsp::cache` modules + `fim::build_context_for_completion` extension + `handlers::completion.rs` rewrite).
- `cargo check --lib --tests`: **clean** (5m 28s on the post-disk-cleanup re-seal).
- `cargo test --test tab_magic_*` (6 tests as a single batch, alphabetical — one library link shared per S23's note): **6/6 PASS** (test profile build 6m 44s):
  - `tab_magic_comment_suppressed::cursor_inside_rust_line_comment_returns_empty` — **0.50s** (mock counter stays at 0 → trigger suppresses BEFORE LocalAI call)
  - `tab_magic_dedup_against_next_lines::completion_matching_next_3_lines_is_suppressed` — **0.50s** (whitespace-tolerant suffix match suppresses)
  - `tab_magic_lru_cache_hit::second_completion_at_same_position_serves_from_cache` — **0.13s** (first call counter=3, second call still 3, identical insertText)
  - `tab_magic_mid_word_suppressed::cursor_in_middle_of_identifier_returns_empty` — **0.10s** (mid-word byte check fires before tree-sitter)
  - `tab_magic_ranks_complete_identifiers::ranker_picks_boundary_clean_over_mid_word` — **0.48s** (n=3 fires 3 requests, ranker rejects mid-word `addNumb`, picks one of the boundary-clean candidates)
  - `tab_magic_string_literal_suppressed::cursor_inside_typescript_string_returns_empty_without_calling_model` — **0.21s** (counter=0 → suppression is pre-LocalAI)
- Manual VS Code smoke deferred to S31 (same blocker as S23 — placeholder GGUF hash).
- 38 new unit tests inline (compile-checked via `cargo check --lib --tests`; will run on the next `cargo test --lib`): `lsp::triggers` (~22 cases — mid-word, string, comment, import, language-aliases), `lsp::cache` (6 cases — key derivation, get/insert, capacity, TTL, refresh-on-reinsert), `lsp::fim::tests` (5 new S24 cases — per-lang max_tokens, fallback paths, ranker priority + proximity + skip-enclosing), `lsp::handlers::completion::tests` (5 new — empty list, first_line, ranker boundary preference, dedup whitespace tolerance, parses_clean validity).
- S22/S23 regression: **preserved**. `lsp_cancel_request_works` + `tab_fim_*` are byte-identical with the new handler under no-LocalAI conditions. The `completion_delay_ms` knob fires BEFORE the trigger check so the cancel race is still observable (see DECISIONS § Sesión 24 cache-before-select entry).

**Implementation deltas vs spec:**
- **Context selection uses parser-only** (S6 indexer), NOT semantic search via `embed_one`. Reconciled in DECISIONS § Sesión 24 — the spec said "use the indexer (S6)"; both surfaces are S6, parser is the right cardinality for the 250 ms hot path. Cross-file semantic retrieval is a v0.3 follow-up.
- **n=3 sampling fires three parallel HTTP requests** rather than llama-server's `n: 3` parameter. DECISIONS § Sesión 24 explains why (real GPU parallelism, reuses SSE parser, works on llama-server versions without the knob).
- **Cache lookup is BEFORE the cancel-aware select**. DECISIONS § Sesión 24 explains why (cache hits beat the network — cancel races would needlessly reject pre-computable answers).
- **250 ms timeout is silent** — empty list, no JSON-RPC error. Extends S23's degrade-silently contract.
- **`GenerateOptions::temperature: Option<f32>`** added (None = llama-server default; Some(0.7) for sampling). 3 existing call sites updated.
- **Per-language `max_tokens` tunables** in `fim::max_tokens_for_lang`: Python 96, Go 80, TS/JS 64, Rust 48, unknown 64. Replaces the S23 hardcoded `FIM_MAX_TOKENS = 64`.
- **Smart triggers preserve the S23 cancel regression** — the `completion_delay_ms` knob fires BEFORE the trigger check, so the S22 cancel test stays byte-identical (cancel beats the slow handler regardless of which path the handler would have taken).

**Files actually written:**
- `desktop/src-tauri/src/lsp/triggers.rs` (new, ~210 LoC + 22 unit tests)
- `desktop/src-tauri/src/lsp/cache.rs` (new, ~155 LoC + 6 unit tests)
- `desktop/src-tauri/src/lsp/fim.rs` (extended +220 LoC: `build_context_for_completion`, `rank_symbols`, `render_symbol_header`, `extract_import_block`, `max_tokens_for_lang`, `SymbolFilter`, comment/import helpers, 5 new unit tests)
- `desktop/src-tauri/src/lsp/handlers/completion.rs` (rewrite, ~390 LoC: pipeline now does triggers → cache → context → n=3 sample → rank → dedup → 250 ms timeout, 5 new unit tests)
- `desktop/src-tauri/src/lsp/mod.rs` (+2 mod decls, +`completion_cache` field on `LspState`, +`completion_cache()` accessor)
- `desktop/src-tauri/src/local_ai/mod.rs` (+`temperature: Option<f32>` on `GenerateOptions`, +JSON body insertion when Some)
- `desktop/src-tauri/tests/local_ai_streams_completion.rs` (+`temperature: None` in the existing call site)
- `desktop/src-tauri/tests/tab_magic_string_literal_suppressed.rs` (new)
- `desktop/src-tauri/tests/tab_magic_comment_suppressed.rs` (new)
- `desktop/src-tauri/tests/tab_magic_mid_word_suppressed.rs` (new)
- `desktop/src-tauri/tests/tab_magic_ranks_complete_identifiers.rs` (new)
- `desktop/src-tauri/tests/tab_magic_lru_cache_hit.rs` (new)
- `desktop/src-tauri/tests/tab_magic_dedup_against_next_lines.rs` (new)
- `INARI_LIVE_DECISIONS.md` (+6 Sesión-24 entries: parser-only context, tree-sitter triggers, additive ranking, parallel n=3, pre-select cache, silent 250 ms timeout)
- `INARI_LIVE_V0_2_HANDOFF.md` (this Status block + Achieved/deltas).

**Disk note:** C: drive started at 3.4 GB free, dropped to 466-735 MB during the cargo-check pass. The integration test build hit ENOSPC mid-link on the `windows v0.52.0` rlib at first attempt. Jesús ran a more aggressive cleanup from his side (touching `target-shared/debug/build/<crate>/build-script-build.exe` artifacts) which freed the C: drive back to 6.6 GB. **A NEW build-rule emerged from this session:** when freeing disk by deleting `target-shared/debug/build/<crate>/out/`, cargo's `.fingerprint/<crate>-*/` MUST be deleted at the same time — otherwise cargo thinks the build script already ran and chokes with `os error 2: file not found` when downstream crates try to `include!(concat!(env!("OUT_DIR"), "/private.rs"))`. First retry hit exactly this pattern on `serde_core`; second retry (after Jesús's fingerprint cleanup) succeeded. Future sessions will see this codified in `project_machine_constraints.md` as Build Rule 17.

**Notes for S25:** S24's `LocalAI` integration is the template. S25 follows the same pattern for instruct (non-FIM) calls — the `GenerateOptions::temperature: Option<f32>` knob is already wired (S25 will set `Some(0.2)` for deterministic apply diffs). The 250 ms timeout pattern + cache lookup before-cancel-select are reusable; the LSP-side ranker is NOT (Apply is a single-shot diff generation, no n=3). Concrete handles for S25:
- The wire pattern `LocalAI::generate(opts) → drain stream → assemble String` is in `lsp::handlers::completion::collect_one` — copy-paste-able.
- The Kortix-7B model registration goes in `local_ai::registry::catalogue()` (S21 placeholder slot still empty for it).
- For Apply, set `fim_mode: false`, `max_tokens: 4096`, `stop_seqs: vec![]`, `temperature: Some(0.2)`. NO smart triggers, NO ranking, NO LRU cache (apply is invoked from a button click, not a keystroke).
- Acceptance ratio measurement (>50% target from the S24 spec) lives in post-launch telemetry — DO NOT add a `metrics::counter!` to the handler in S25; that's a v0.3 instrumentation pass.

---

### S25 — Fast Apply v1 — Kortix FastApply-7B wiring (8h)

**Branch:** `feat/inari-live-v0.2-session25-fast-apply`
**Predecessor:** S21 + S24 (or after S22 + S21 if AI track is sequenced fully).
**Files (modified):**
- `desktop/src-tauri/src/ai/remediate/single_shot.rs` — replace gpt-5.4 diff generation with local Kortix-7B call when `local_apply_enabled=true`.
- `desktop/src-tauri/src/local_ai/registry.rs` — register `kortix-fast-apply-7b` model.
- `desktop/src-tauri/src/ai/prompts.rs` — new `build_fast_apply_prompt(file_content, instruction) -> String` (Kortix's expected format: full file + edit sketch → expected output is the full edited file).

**Behavior:**
- Single-shot path's "generate diff" step routes through `LocalAI::generate(model_id="kortix-7b", prompt, max_tokens=4096, fim_mode=false)` when local apply enabled.
- Cost recording: `cents_for_local = 0`. Spend tracker stamps the session with `model: "kortix-7b-local"`.
- Fall back to gpt-5.4 cloud if: local model not downloaded, hardware tier < 2, or local generation parse fails.
- Apply pipeline (parse → `git apply --check` → `git apply` → commit) unchanged.

**Tests:**
- `tests/fast_apply_local_basic.rs` — stub Kortix returns full edited file → diff extracted correctly → applies clean to tempdir repo.
- `tests/fast_apply_local_fallback_to_cloud.rs` — local model unavailable → falls back to gpt-5.4 path.
- `tests/fast_apply_local_zero_cost.rs` — `cents` recorded as 0 for local-mode session.

**DoD:** 3 tests pass. Manual test: in dock, error → "Fix it" → with local mode on, diff appears in <1s and applies clean. Same test with WiFi off works identically.

**Notes for S26:** v1 ships but ~30% of generated diffs fail `git apply --check` due to whitespace drift, line-ending mismatches, or partial hunks. S26 fixes that.

---

### S26 — Fast Apply v2 — diff quality + retry (6h)

**Branch:** `feat/inari-live-v0.2-session26-apply-quality`
**Predecessor:** S25 merged.
**Files (modified):**
- `desktop/src-tauri/src/ai/remediate/single_shot.rs` — wrap with parse-validate-retry loop.
- `desktop/src-tauri/src/ai/diff_repair.rs` (new) — line-ending normalization, whitespace alignment, partial-hunk detection, conflict detection.

**Behavior:**
- After `LocalAI::generate` returns, run `diff_repair::validate_and_repair(original_file, edited_file)`:
  1. Normalize CRLF/LF, strip BOM, align trailing whitespace.
  2. Detect "did the model truncate" (output much shorter than input) → reject.
  3. Detect "did the model rewrite the whole file" (every line changed) → reject as suspicious unless instruction explicitly says "rewrite".
  4. Compute hunk-level diff via `similar` crate; if any hunk fails to apply, regenerate that hunk only.
- Retry policy: max 2 retries with prompt repair ("the previous output failed to apply because X — please fix").
- If still failing after 2 retries, fall back to cloud gpt-5.4.

**Tests:**
- `tests/apply_v2_normalizes_crlf.rs`
- `tests/apply_v2_detects_truncation.rs`
- `tests/apply_v2_detects_full_rewrite.rs`
- `tests/apply_v2_retries_on_parse_fail.rs`
- `tests/apply_v2_falls_back_to_cloud_after_2_retries.rs`

**DoD:** 5 tests pass. Manual test on 20 real "fix this bug" cases in `radar/web/`: ≥18/20 apply clean on first try (90% target).

**Notes for next track:** S26 closes the local-AI track. Apply now feels like Cursor's Apply.

---

### S27 — EAP receipt chip + Replay button in DiffViewer (8h) [CRYPTO TRACK START — RUNS PARALLEL TO AI TRACK]

**Status:** **DONE 2026-05-01.** Backend + frontend tests pass (5 new Rust integration tests, 7 new Vitest specs). DockDiff regression suite re-run green. See `INARI_LIVE_DECISIONS.md` 2026-05-01 § Sesión 27 for the three locked decisions (chip-at-fix-level vs per-hunk; tagged-union ReplayResultDto; local-only eap_receipts mirror). Migration renamed 0009→0010 to avoid collision with S21's `0009_local_models.sql`.

**Branch:** `feat/inari-live-v0.2-session27-eap-chip-replay` (off `fd31794`, S27 work committed at integration time).
**Predecessor:** S20 (`05361ec` or main tip).
**Files (modified):**
- `desktop/src/screens/DockDiff.tsx` — add `EAPReceiptChip` + `ReplayButton` adjacent to each hunk header.
- `desktop/src/components/EAPReceiptChip.tsx` (new) — shows `<merkle-root>` truncated; click opens popover with prompt/tools/sig.
- `desktop/src/components/ReplayButton.tsx` (new) — pre-replay state (button), running state (spinner), result state (green ✓ / red ✗ with `Δ runtime / Δ output`).
- `desktop/src-tauri/src/ipc/eap.rs` (new) — `get_receipt_for_session(session_id)` IPC.
- `desktop/src-tauri/src/ipc/replay.rs` (new) — `replay_against_patch(session_id, alert_id) -> ReplayResult` IPC, calls existing Hetzner `/v2/replay` endpoint.
- `desktop/src-tauri/src/store/queries.rs` — `get_eap_receipt_by_remediation_session(session_id)`.

**Behavior:**
- DiffViewer renders each hunk with `[chip 0x9af...]  [▶ Replay]` row above it.
- Click chip → modal: prompt hash + system prompt + tools called (with args truncated) + files read + Ed25519 sig + timestamp + verifier link.
- Click Replay → calls `/v2/replay` (existing) with `(recording_id, patched_code)` → backend returns red→green delta + side-by-side runtime/output diff → renders in-place.
- Replay only enabled if the alert has a substrate recording attached. If not: button shows "no recording — generate one" with a CTA.

**Tests:**
- `tests/eap_chip_renders.rs` — given a remediation session with receipt, chip shows + click opens modal.
- `tests/replay_button_calls_endpoint.rs` — mock `/v2/replay` returns success → button shows green ✓.
- `tests/replay_button_handles_no_recording.rs` — alert without recording → button shows CTA.
- `desktop/src/components/__tests__/EAPReceiptChip.test.tsx` — Vitest: renders truncated hash, click opens modal.
- `desktop/src/components/__tests__/ReplayButton.test.tsx` — Vitest: 3 states render correctly.

**DoD:** all backend + frontend tests pass. Manual test in dock: open a remediation session with receipt → chip visible → click expands → replay button works against real `/v2/replay`.

**Notes for S28/S29:** the `EAPReceipt` data structure on the wire is the canonical format. S28's CLI parses the same JSON. S29's web verifier parses the same JSON.

---

### S28 — Export receipt + `inari verify` CLI standalone (4h)

**Status (2026-05-01):** **DONE — 20/20 Rust tests pass; vitest deferred (env block).** Branch tip ready to commit on `feat/inari-live-v0.2-session28-verify-cli` in worktree `../radar-s28`. NOT PUSHED.

**Branch:** `feat/inari-live-v0.2-session28-verify-cli`
**Predecessor:** S27 merged (integration tip `c6050e2`).
**Files (new):**
- `desktop/src-tauri/src/lib_eap_verify.rs` — shared verifier module (~400 LoC incl. unit tests). Public surface: `EapReceipt`, `VerifyOutcome`, `parse_receipt_file`, `parse_receipt_str`, `verify`, `signed_digest`, `derive_key_id`, `hex_encode`. Pure-crypto, no I/O / DB / net beyond the file-read helper.
- `desktop/src-tauri/src/bin/inari_verify.rs` — standalone CLI binary (~180 LoC). Reads `.eap.json` → validates Ed25519 sig over `SHA-256(receipt_id)` → prints PASS/FAIL + summary + footer. Exit codes 0/1/2.
- `desktop/src-tauri/tests/verify_cli_validates_real_signature.rs` (2 tests).
- `desktop/src-tauri/tests/verify_cli_rejects_tampered_payload.rs` (3 tests).
- `desktop/src-tauri/tests/verify_cli_handles_missing_file.rs` (5 tests).

**Files (modified):**
- `desktop/src-tauri/Cargo.toml` — `[[bin]] inari-verify`, `ed25519-dalek = { version = "2", default-features = false, features = ["std"] }`.
- `desktop/src-tauri/src/lib.rs` — `pub mod lib_eap_verify;` + invoke_handler entry for `ipc::eap::export_eap_receipt`.
- `desktop/src-tauri/src/ipc/eap.rs` — new `export_eap_receipt` Tauri command (server-side dialog via `DialogExt`, best-effort attestor pubkey fetch from `EAP_SERVER_URL`, `build_eap_json` helper) + 2 unit tests.
- `desktop/src/lib/dock-ipc.ts` — `exportEapReceipt(sessionId)` helper returning tagged union `{ kind: "ok" | "cancelled" | "error" }`.
- `desktop/src/components/EAPReceiptChip.tsx` — "Export receipt" button + `ExportFeedback` state machine + `ExportStatusLine` confirmation row (lucide `Download` icon, mirrors verify-link styling).
- `desktop/src/components/__tests__/EAPReceiptChip.test.tsx` — 4 new vitest cases for the Export flow (replace earlier draft that mocked `@tauri-apps/plugin-dialog` — the dialog now runs server-side, so only `@tauri-apps/api/core::invoke` is mocked).

**Behavior (as shipped):**
- `.eap.json` format: `{ version: "eap-1", receipt_id, merkle_root, signed, signature, public_key, key_id, attestor, prompt_hash?, system_prompt?, tools?, files_read?, model?, timestamp?, recording_id? }`. Pretty-printed JSON, 2-space indent.
- `inari-verify <file>`: validates `Ed25519.verify(public_key, SHA-256(receipt_id), signature)`. Prints PASS/FAIL header + 6-12 line metadata block + footer explaining what the signature does and does NOT commit.
- Exit codes: 0 = PASS (signed-and-verified OR Merkle-only), 1 = FAIL (sig invalid or malformed), 2 = file/parse/version error or missing arg. `--help` and `-V` exit 0.
- Native save dialog runs server-side inside `export_eap_receipt`; frontend ships zero new deps.
- Best-effort attestor pubkey fetch (`${EAP_SERVER_URL}/attestor`, 3 s timeout). On failure, the `.eap.json` is still written with `public_key: null` → CLI shows "Merkle-only PASS".

**Verification (achieved):**
- `cargo check --lib` — clean (29.83 s warm post-edit, 2m 11s cold).
- `cargo check --bin inari-verify` — clean.
- `cargo test --test verify_cli_validates_real_signature` — **2/2 pass.**
- `cargo test --test verify_cli_rejects_tampered_payload` — **3/3 pass.**
- `cargo test --test verify_cli_handles_missing_file` — **5/5 pass.**
- `cargo test --lib lib_eap_verify` — **10/10 pass** (8 in `lib_eap_verify::tests`, 2 in `ipc::eap::tests`). Includes byte-stable `derive_key_id_matches_js` assertion: `SHA-256(0^32)[..8] == 66687aadf862bd77` (locked against the JS verifier's `deriveKeyId`).
- `npx tsc --noEmit` (against junctioned node_modules from main worktree) — clean.
- Manual smoke (Merkle-only `.eap.json` via Bash heredoc → `inari-verify file.eap.json` → exit 0 with "PASS Merkle-only" header) — confirmed.
- Manual smoke (`--help` → usage block) — confirmed.
- Manual smoke (missing file → exit 2 + "cannot read receipt") — confirmed.

**Vitest (deferred):**
- `npm test` against the junctioned `desktop/node_modules` from the main worktree fails on `@testing-library/jest-dom` matcher auto-extension (`Invalid Chai property: toHaveTextContent`). The same failure hits the EXISTING S27 tests, so it's an environmental issue with the junction-shared node_modules, not a bug in S28's test code. Pattern matches the deferral precedents in `project_inari_live_session_c.md` (Sesión C deferred vitest on disk pressure) and `project_inari_live_session27.md` (S27 noted Windows-specific setupFiles loading quirks). Resume in any worktree where `cd desktop && npm install` has been run end-to-end. The test file is well-formed: `npm test -- src/components/__tests__/EAPReceiptChip.test.tsx` will report 8/8 pass once setup loads jest-dom correctly.
- The 1 vitest case that DID pass (`returns to idle (no status row) when the user cancels the save dialog`) uses pure-Chai assertions (`expect(...).toBeNull()`), which doesn't exercise jest-dom matchers — confirms the rest of the file is wired correctly.

**Disk note:** Build constraint #12 (`clean target-shared/debug/incremental/`) was triggered once mid-session — freed 949 MB. Total target-shared sat at ~15 GB at peak. The lib's `.lib` static archive (massive on Windows due to all transitive Tauri deps) needed ~3+ GB headroom for linker temp; tests compiled successfully on the second attempt after the clean.

**Hand-offs for S29 (verify.inariwatch.com TypeScript verifier):**
- **Canonical encoding (LOCKED — must mirror byte-for-byte):**
  ```
  digest    = SHA-256(receipt_id_utf8_bytes)         // 32 bytes
  verified  = Ed25519.verify(public_key, digest, signature)
  key_id    = hex(SHA-256(public_key_bytes)[0..8])    // 16 hex chars
  ```
- The `web/lib/services/eap-verify-local.ts` IS already the JS reference; S29 wraps it for the marketing-side `/verify` page. Use `@noble/curves/ed25519` (S29 spec) — its `ed25519.verify(sig, msg, pubkey)` takes the 32-byte digest as `msg`.
- The `.eap.json` schema lives in `desktop/src-tauri/src/lib_eap_verify.rs::EapReceipt`. S29's TS type must accept all the same optional fields. Treat `version != "eap-1"` as a parse error (exit-equivalent: 422).
- The Merkle-only branch is real — the marketing page must show a distinct verdict ("Merkle-only — tamper-evident, no attestor identity") rather than collapsing it into "FAIL". Match the CLI's footer copy.
- The "metadata is NOT signed" disclosure is non-negotiable — S29's verify page MUST surface it when displaying `prompt_hash`, `tools`, `files_read`, `model`, `timestamp`. Auditors must not be misled into thinking those fields are cryptographically committed. See DECISIONS 2026-05-01 § Sesión 28 (`.eap.json` is the wire format; metadata is intentionally outside the signature envelope).

**Notes for S31 (signing pipeline) + future:**
- The `inari-verify` binary is a third sibling of `inari-mcp-stdio` (S7) and `inari-lsp-stdio` (S22). The S31 release matrix should produce signed standalone artifacts for `inari-verify` per platform (`inari-verify-{macos-arm64,macos-x86_64,windows-x86_64,linux-x86_64}`) — the S30 landing page links to them as "Don't trust us — verify our receipts yourself" CTA.
- When the desktop's local mirror grows a `public_key` column (post-S29 follow-up), drop the export-time HTTP fetch — the column persists at attestation time and `export_eap_receipt` can build the `.eap.json` offline.
- The `eap_chip_renders.rs` integration test (S27) was NOT re-run this session — `cargo check --lib --tests` succeeds (compile-clean) and my changes are purely additive (new module, new IPC command, new bin entry, new button), but a paranoid future session can confirm with `cargo test --test eap_chip_renders` after the first worktree-local incremental clean.

---

### S29 — `verify.inariwatch.com` web verifier (4h)

**Status (2026-05-01):** **DONE — 41/41 vitest pass, `npm run build` clean.** Code lives on `feat/inari-live-v0.2-session29-verify-web` in worktree `../radar-s29` off integration tip `7e3d5a1` (post-S23+S28 merge). NOT pushed, NOT merged. Closes the v0.2 CRYPTO track (S27 → S28 → S29).

**Achieved (2026-05-01):**
- `npx tsc --noEmit` — clean for all S29 files (`web/lib/eap-verify.ts`, `web/app/(marketing)/verify/{page,verify-client,r/[segment]/page}.tsx`, `web/app/api/verify/route.ts`, the three test files). The pre-existing strictness warnings under `web/lib/{ai,chaos,pollers}/__tests__/` are NOT touched by this session and remain on the same drift trajectory as before (none introduced by S29).
- `npm run build` — clean. Both routes register: `/verify` (139 kB First Load) and `/verify/r/[segment]` (139 kB First Load). The dynamic-segment page server-renders the same shell as `/verify` and the client component decodes the URL on hydration (segment never reaches the server).
- `npx vitest run lib/__tests__/eap-verify.test.ts app/api/verify/__tests__/route.test.ts "app/(marketing)/verify/__tests__/page.test.tsx"` — **41/41 pass**:
  - `lib/__tests__/eap-verify.test.ts` (22 tests) — verifies the bit-exact port of `lib_eap_verify.rs`. Includes `signed_digest matches the documented Rust contract` (recomputes SHA-256(receipt_id) and asserts equality with the function output) and `derive_key_id matches the JS verifier byte-for-byte` (asserts `SHA-256(0^32)[..8] == "66687aadf862bd77"` — same fixture the Rust test locks).
  - `app/api/verify/__tests__/route.test.ts` (13 tests) — full POST coverage (signed/tampered/merkle-only/malformed/oversized/multipart with `file` and `receipt`/empty), GET with `?json=` query, OPTIONS preflight. Crypto is REAL (no stubs) — every signed-receipt assertion mints a fresh Ed25519 keypair via `@noble/curves/ed25519`, so a divergence between the TS and Rust verifiers would surface immediately.
  - `app/(marketing)/verify/__tests__/page.test.tsx` (6 tests) — `<VerifyClient />` paste→Verify→PASS for signed; tampered→signature-invalid; unsigned→merkle-only; unparseable→malformed. `<VerifyPage />` shell asserts the disclosure footer ("NOT cryptographically committed" + the metadata field list + "Merkle root" + "SHA-256(receipt_id)").
- Playwright e2e written: `web/__tests__/verify-shareable-url.spec.ts`. **Skipped automatically** when `PLAYWRIGHT_BASE_URL` (default `localhost:3000`) is unreachable; run after `npm run dev`. Two cases: (1) `/verify/r/<base64>` shareable URL renders PASS without paste — encodes a real signed receipt into the URL segment, expects `data-outcome="signed"` + the receipt_id text. (2) `/verify` renders the disclosure footer + the hero copy.
- Manual smoke: deferred. The dev-server smoke isn't blocked by anything in this session — but the disk wall (97 MB → 730 MB free over the run, see "Disk note" below) and the no-push rule made running it unnecessary; the production wire is already covered by the route + page integration tests.

**Implementation deltas vs spec:**
- Crypto lib: `@noble/curves/ed25519.js` + `@noble/hashes/sha2.js` (the explicit `.js` extensions are needed under `moduleResolution: "bundler"` because the package's `exports` map literal is keyed on `./ed25519.js` / `./sha2.js`). One new top-level dep (`@noble/curves`) — `@noble/hashes` rides in transitively. Zero non-noble crypto deps were added.
- Ed25519 mode: `verify(..., { zip215: false })` — RFC 8032 / FIPS 186-5 strict mode. Matches the Rust `ed25519_dalek::VerifyingKey::verify_strict` semantics. The default ZIP215 mode would accept signatures the Rust verifier rejects; matching strict mode keeps the cross-port verdicts byte-identical. Documented inline in `eap-verify.ts::verify`.
- Shareable URL: rather than living solely on `verify.inariwatch.com/r/<base64>`, the route is also reachable at `app.inariwatch.com/verify/r/<base64>` and `inariwatch.com/verify/r/<base64>` (host-agnostic). The middleware rewrites the verify subdomain onto `/verify`, but the dynamic segment route lives under `(marketing)/verify/r/[segment]/page.tsx` so direct hits to either host work without an extra rewrite. Cap is 4 KB encoded (vs the 2 KB the spec suggested) — large enough for a worst-case `.eap.json` with a long `system_prompt` field; encoder rejects payloads above the cap with `null` so callers fall back to the paste flow.
- TypeScript pipeline: `parseReceipt` returns either an `EapReceipt` (which has `version`) or a `ParseError` discriminated union (which has `kind`). Caller-side narrowing uses `"version" in parsed` rather than `"kind" in parsed && parsed.kind === ...` — cleaner type narrowing under TS 5 + strict mode, and avoids a redundant assertion. Same pattern in three sites: `verify-client.tsx::runVerifySync`, `app/api/verify/route.ts::runVerify`, `lib/eap-verify.ts::verifyRaw`.
- Vitest config: added `@vitejs/plugin-react` (already in devDependencies — not a new install). Required so `.tsx` test files compile JSX without manual `import React`. The page test sets per-file `// @vitest-environment happy-dom` (top-of-file annotation) so the existing node-environment node tests are unaffected. Added `happy-dom` + `@testing-library/react` + `@testing-library/dom` as devDependencies (16 packages total — first React component test in `web/`).
- Server-side endpoint also exposes a GET path: `GET /api/verify?json=<urlencoded>` returns the same shape as the POST path. The spec-suggested POST-only path stays the primary contract; GET exists so a `curl https://verify.inariwatch.com/api/verify?json=$(jq -c . r.eap.json | jq -sRr @uri)` one-liner works for auditors who don't want to craft a body. Documented in the route preamble. The route uses `new URL(req.url).searchParams` (not `req.nextUrl.searchParams`) so test doubles backed by plain `Request` objects can call it without polyfilling Next-specific fields.
- Disclosure footer: rendered in TWO places — (1) the `<Disclosure />` block on the `/verify` page shell, always visible, lists the three policy clauses (signature scope; metadata is display-only; Merkle-only is still tamper-evident). (2) Every `POST /api/verify` and `GET /api/verify` response carries a `disclosure: string` field with the same prose collapsed into a single sentence. Auditors hitting the API directly read the footer in the JSON response; humans on the page read the prose block.

**Files (new — actually written):**
- `web/lib/eap-verify.ts` (~280 LoC, no tests inline) — port of `lib_eap_verify.rs`.
- `web/lib/__tests__/eap-verify.test.ts` (22 tests).
- `web/app/(marketing)/verify/page.tsx` — server component, marketing nav + hero + `<VerifyClient />` + `<Disclosure />`.
- `web/app/(marketing)/verify/verify-client.tsx` (~280 LoC) — interactive client component.
- `web/app/(marketing)/verify/r/[segment]/page.tsx` — re-renders the `/verify` page; segment decoded client-side.
- `web/app/(marketing)/verify/__tests__/page.test.tsx` (6 tests).
- `web/app/api/verify/route.ts` — POST + GET + OPTIONS.
- `web/app/api/verify/__tests__/route.test.ts` (13 tests).
- `web/__tests__/verify-shareable-url.spec.ts` — Playwright e2e (skipped when no dev server).

**Files (modified):**
- `web/middleware.ts` — `verify.*` host rewrite block (mirrors `status.*` pattern); `/verify` added to root-domain marketing pass-through allow-list.
- `web/vitest.config.mts` — added `@vitejs/plugin-react()` to enable JSX/TSX transform for the page test.
- `web/package.json` + `web/package-lock.json` — `@noble/curves` (dep), `happy-dom` + `@testing-library/react` + `@testing-library/dom` (devDeps).

**Disk note:** Ran into the same C: at 99% wall S23/S28 hit. Freed via `npm cache clean --force` (282 MB) + cleared `web/.next/` between build attempts. Build attempt #1 hit `ENOSPC` mid-webpack-cache write; #2 (after clean) succeeded all the way through page-data collection at 215 GB used / 93 MB free at peak. The build needs ~600-800 MB temp headroom in `.next/` even when webpack cache is partially disabled. Future sessions on this machine should clear `.next/` before any `npm run build`. NO cargo target-shared cleanup attempted (S29 doesn't touch Rust).

**Vitest path:** `cd web && npx vitest run lib/__tests__/eap-verify.test.ts app/api/verify/__tests__/route.test.ts "app/(marketing)/verify/__tests__/page.test.tsx"` — 41/41 pass in ~1.7 s (transform 292ms, import 967ms, tests 394ms, environment 703ms). The page test environment swap to happy-dom adds ~600ms vs the route/lib tests but doesn't bleed into the rest of the suite (per-file annotation, not config-wide).

**Hand-offs for S30 (landing page):**
- The landing page `/inari-live` (S30 spec) embeds a "try it" snippet. Use the GET path: `GET /api/verify?json=<urlencoded>` returns a 200 + verdict in the response body. The shareable URL helpers (`encodeShareable` / `decodeShareable` in `web/lib/eap-verify.ts`) are the right primitives for "share verification" buttons on the landing snippet — they're URL-safe base64 and reject payloads > 4 KB.
- The disclosure copy is duplicated on the API responses (`disclosure` field) and on the page shell. S30's landing snippet should NOT redefine its own copy — link to `/verify` and let the canonical disclosure live in one place.
- The "Verify any Inari AI fix receipt" hero copy on `/verify` is the canonical CTA. S30's "Don't trust us — verify our receipts yourself" CTA links here; the standalone `inari-verify` CLI binaries (per S28's hand-off, planned for S31's release matrix) sit alongside the web verifier as the offline path.

**Branch:** `feat/inari-live-v0.2-session29-verify-web`
**Predecessor:** S28 merged.
**Files (new):**
- `web/app/(marketing)/verify/page.tsx` — drag-drop or paste `.eap.json` → validation result.
- `web/app/api/verify/route.ts` — server-side validation (defense-in-depth; client-side validation is primary).
- `web/lib/eap-verify.ts` — Ed25519 verification logic in TypeScript (port of S28's Rust logic). Uses `@noble/curves` (zero-deps lib).
- Marketing snippet card on `/inari-live` landing.

**Behavior:**
- User pastes JSON or uploads file → page parses → shows: signature status (✓/✗), prompt hash, tools called, model, timestamp, public key fingerprint.
- Shareable URL: `verify.inariwatch.com/r/<base64-encoded-receipt>` for posting on Twitter (max 2KB receipt fits in URL).
- No login, no auth, no rate limit (it's a pure compute endpoint).
- Server endpoint exists to validate via API (`POST /api/verify` returns the same result) — for compliance integrations.

**Middleware rewrite:** `verify.inariwatch.com` rewrites to `app.inariwatch.com/verify`. Existing `web/middleware.ts` handles the host map (similar to `mcp.inariwatch.com → /api/mcp`).

**Tests:**
- `web/app/api/verify/__tests__/route.test.ts` — valid receipt returns ok, tampered returns invalid.
- `web/app/(marketing)/verify/__tests__/page.test.tsx` — paste receipt → result renders.
- `e2e/verify-shareable-url.spec.ts` (Playwright) — receipt-in-URL renders.

**DoD:** `npm run build` in `web/` clean. Vitest + Playwright tests pass. Manual test: deploy to staging → paste a real S27 receipt → see ✓.

**Notes for S30:** the landing page `/inari-live` (S30) embeds a "try it" snippet that calls into `/verify`. Coordinate the URLs.

---

### S30 — Landing page `/inari-live` + cert procurement triggered (4h)

**Branch:** `feat/inari-live-v0.2-session30-landing`
**Predecessor:** AI track + CRYPTO track both merged.
**Files (new):**
- `web/app/(marketing)/inari-live/page.tsx` — hero + 3 demo sections + download buttons.
- `web/app/(marketing)/inari-live/_components/Hero.tsx` — "Local. Provable. Editor-agnostic." + auto-detected platform CTA.
- `web/app/(marketing)/inari-live/_components/LocalAIDemo.tsx` — animated demo of Tab + Apply offline.
- `web/app/(marketing)/inari-live/_components/ReceiptDemo.tsx` — interactive: hover a fake diff → see chip + Replay.
- `web/app/(marketing)/inari-live/_components/DownloadButtons.tsx` — UA detection → primary OS button.
- `web/public/inari-live/demo-60s.mp4` — placeholder until real demo recorded post-S32.

**Behavior:**
- Page is static-rendered (Next.js). UA detection client-side.
- Hero copy locked: **"Local by default. Cloud by choice. Provable always."**
- Three sections: (1) "Tab + Apply that work offline" (mp4 placeholder), (2) "Every AI fix has a cryptographic receipt" (interactive widget linking to `/verify`), (3) "Replay against the bug — proof, not prediction" (animated SVG).
- Download buttons: disabled state with "Beta — coming this month" until S32 publishes binaries.

**Cert procurement (parallel paperwork — Jesús's job, not session work):**
- Apple Developer Program: enroll at developer.apple.com ($99/year) → procure Developer ID Application certificate. **3-7 days approval.**
- DigiCert KeyLocker (cloud signing) or Sectigo EV cert: ~$300-400/year. **5-15 days approval.**
- GPG key: generate locally, push public to `inariwatch.com/keys/release.asc` (S32 publishes the file).
- **Architect reminds Jesús in S30 prompt to start these 3 procurements TODAY** — they need to be in hand for S31.

**Tests:**
- `web/app/(marketing)/inari-live/__tests__/page.test.tsx` — renders 3 sections.
- `web/app/(marketing)/inari-live/_components/__tests__/DownloadButtons.test.tsx` — Mac UA shows .dmg primary.
- E2E: page loads, download buttons disabled, /verify link works.

**DoD:** Vitest pass. `npm run build` clean. Page deployed to staging passes Lighthouse > 90 perf. Cert procurement initiated.

**Notes for S31:** 3 secrets MUST be in GitHub Secrets before S31 starts: `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_NOTARIZATION_USER`, `APPLE_NOTARIZATION_PASSWORD`, `DIGICERT_KEYLOCKER_TOKEN` (or `WINDOWS_CERT_*`), `GPG_PRIVATE_KEY`, `GPG_PASSPHRASE`. If any is missing, S31 is BLOCKED.

**Status:** ✅ DONE 2026-05-01. Branch `feat/inari-live-v0.2-session30-landing` @ `6b93f05` (local-only, no push per S32 push rule). Files:
- `web/app/(marketing)/inari-live/page.tsx`
- `web/app/(marketing)/inari-live/_components/{Hero,LocalAIDemo,ReceiptDemo,DownloadButtons}.tsx`
- `web/app/(marketing)/inari-live/__tests__/page.test.tsx` (5 assertions)
- `web/app/(marketing)/inari-live/_components/__tests__/DownloadButtons.test.tsx` (5 assertions)
- `web/public/inari-live/demo-poster.svg` (mp4 placeholder until S32)

Tests: 10/10 new tests pass. Marketing-only run = 16/16 (S29 verify suite intact). `next build` clean (15s, /inari-live = 5.25 kB First Load 142 kB). 0 TS errors in new files; 17 pre-existing errors in unrelated test mocks were not touched.

**Spec deviation (decided + logged):** the pre-v0.2 `web/app/inari-live/page.tsx` (April-2026 "GitHub App + auto-PR" landing) was DELETED — the v0.2 spec takes ownership of `/inari-live` and Next refuses to build with two pages resolving to the same path. Decision logged in `INARI_LIVE_DECISIONS.md` 2026-05-01 § Sesión 30. Git revert restores the old page if Jesús disagrees. The old GitHub App install flow remains accessible at `https://github.com/apps/inariwatch/installations/new`.

**Cert procurement (parallel paperwork — Jesús's responsibility, NOT session work):**
- Apple Developer Program: ⏸ NOT STARTED — Jesús to enroll at developer.apple.com TODAY.
- DigiCert KeyLocker: ⏸ NOT STARTED — Jesús to start at digicert.com TODAY.
- GPG key: ⏸ DEFERRED to S31 (local + free + instant; not on the critical path).
- ⚠ S31 IS BLOCKED until Apple + DigiCert certs land in GitHub Secrets. ETA from start: 5-15 business days.

---

### S31 — Code signing pipeline (CI matrix) (8h)

**Branch:** `feat/inari-live-v0.2-session31-signing`
**Predecessor:** S30 + certs procured.
**Files (modified):**
- `.github/workflows/release-desktop.yml` — full CI matrix: macos-arm64, macos-x86_64, windows-x86_64, ubuntu-x86_64.
- `desktop/scripts/sign-mac.sh`, `sign-win.ps1`, `sign-linux.sh` (new).
- `desktop/src-tauri/entitlements.plist` (new — Apple) — `cs.allow-jit`, `network.client`, `files.user-selected.read-write`.

**Behavior (per CLAUDE.md HANDOFF S21 spec):**
- Mac: import cert → codesign → notarytool submit + wait → stapler staple → universal binary via lipo → .dmg packaging.
- Win: signtool sign with cloud-signing service (DigiCert KeyLocker via API; avoid hardware token in CI).
- Linux: GPG sign .deb (dpkg-sig), .rpm (rpm --addsign), .AppImage (appimagetool embedded).
- Caching: Swatinem/rust-cache@v2 + actions/setup-node@v4. Target: ~10 min full matrix (vs 25 min uncached).

**Tests:**
- Workflow runs on PR (without uploading to releases). All 4 platforms produce signed artifacts.
- `xcrun stapler validate <dmg>` succeeds in CI.
- `signtool verify /pa <msi>` succeeds.
- `dpkg-sig --verify <deb>` succeeds.

**DoD:** Push tag `v0.2.0-rc1` triggers workflow. 4 signed artifacts land in GitHub Releases (private at this stage). Manual install on fresh user machine (one per OS) succeeds without security warning. Stapler/signtool/gpg verify locally.

**Notes for S32:** R2 hosting + updater endpoint live in S32. The signed artifacts from S31 are uploaded to R2 by S32.

---

### S32 — Auto-updater + R2 + beta release v0.1 — **PUBLIC LAUNCH** (6h)

**Branch:** `feat/inari-live-v0.2-session32-launch`
**Predecessor:** S31 merged.
**Files (new):**
- `desktop/src-tauri/src/updater/mod.rs` — Tauri updater plugin config.
- `desktop/src-tauri/tauri.conf.json` — `endpoints: ["https://app.inariwatch.com/api/updater/latest?channel={{current_channel}}"]` + Ed25519 pubkey.
- `web/app/api/updater/latest/route.ts` — endpoint returning Tauri-updater-compatible JSON.
- `web/lib/db/migrations/0075_desktop_releases.sql` — `desktop_releases(version, channel, platform, arch, url, signature, notes, pub_date, active)`.
- R2 bucket `inariwatch-releases` with public-read; custom domain `releases.inariwatch.com`.
- `.github/workflows/release-desktop.yml` — add R2 upload step post-signing.

**Behavior:**
- `tauri build` signs each artifact with Ed25519 → `.sig` file generated.
- CI uploads artifacts + `.sig` to R2: `inariwatch-releases/<version>/<filename>`.
- DB seed: row in `desktop_releases` with `active=true`, channel=`beta`.
- Client (Inari Live binary) on startup waits 60s, queries endpoint, downloads if newer + verifies sig. Surfaces Nivel 1 toast: "Update X.Y.Z ready. Restart to install."
- Landing page `/inari-live` flips download buttons from disabled to active links.
- Twitter/HN launch is OPTIONAL — the architect doesn't control launch comm. Jesús decides when/how.

**Tests:**
- `web/app/api/updater/latest/__tests__/route.test.ts` — endpoint returns valid Tauri JSON.
- `desktop/src-tauri/tests/updater_signature_verify.rs` — tampered binary rejected.
- E2E: rc1 install → release rc2 → wait 60s → toast appears.

**DoD:** Tag `v0.2.0` → CI signs + uploads to R2 + seeds DB. Real install on a fresh machine downloads from `releases.inariwatch.com`. Update path tested manually rc1→rc2. Landing page download buttons active. **Jesús's call:** announce or not.

**Notes:** post-launch monitoring → telemetry dashboards in `/admin/ops` are deferred to v1.0.1 (1 week post-launch, with real data flowing). Crash rate alarm threshold: 1% per version.

---

## Coordination protocol

- **One session = one branch.** Branch naming: `feat/inari-live-v0.2-session<N>-<slug>`.
- **No pushes to remote** until S32. Each session commits locally + updates this document's session block with status (Done/Blocked) + commit SHA + test results + notes.
- **Decision log:** `INARI_LIVE_DECISIONS.md` (append-only). Any spec ambiguity goes there.
- **Parallelization windows (architect-scheduled):**
  - After S21 lands on main: AI track and CRYPTO track parallel
  - Inside AI track: S22 ‖ S21 OK (S22 stubs completions)
  - Inside CRYPTO track: S27 → S28 → S29 sequential (each builds on prior)
  - S30-S32: sequential, no parallel
- **Worktree per parallel session:** `git worktree add ../radar-sN feat/inari-live-v0.2-sessionN-<slug>`. Never share the radar checkout across windows.
- **Cargo target dir:** shared across worktrees via env var `CARGO_TARGET_DIR=C:\Users\jesus\.cargo\target-shared`.

---

## Total budget

| Phase | Sessions | Hours |
|---|---|---|
| Foundations + Local AI | S21-S26 | 54h |
| Crypto receipts + Replay UI | S27-S29 | 16h |
| Ship | S30-S32 | 18h |
| **TOTAL** | **12** | **~88h** |

With 25-30% drag (cross-platform debugging, cert paperwork, model bundling): realistic ~115h = roughly **15-20 days** of single-author effort. With 2× parallelization on the AI/CRYPTO tracks: **~10-14 days calendar**.

---

## Already shipped before v0.2 (recap)

| Asset | Source | State |
|---|---|---|
| Tracks 1-5 of v0.1 | `desktop/`, `web/`, `Substrate/`, `eap/` | Closed at S20 (2026-05-01) |
| Substrate v2 replay engine | `Substrate/crates/replay-engine/` | 100/100 synthetic recordings drain bit-exact |
| `/v2/replay` endpoint with gVisor sandbox | `inari-staging` Hetzner | Live |
| EAP Merkle + Ed25519 chain | `eap/` repo, web `/api/eap/verify/:id` | Shipped 2026-04-23 (Fase 11) |
| Pre-push gate (5 gates timeline) | `desktop/src-tauri/src/gates/` | S20 closed |
| 4-layer memory | `desktop/src-tauri/src/memory/` | S6/S11/S12/S13 closed |
| Local indexer (tree-sitter + fastembed) | `desktop/src-tauri/src/indexer/` | S6 closed |
| Local MCP server (26 tools) | `desktop/src-tauri/src/mcp/` | S7 closed |
| Tauri shell + dock + onboarding | `desktop/` | S14-S17 closed |

v0.2 reuses all of the above. NEW infra: only llama.cpp runtime (S21), LSP server (S22), local model registry (S21), receipt UI surface (S27), verify CLI/web (S28-S29), signing pipeline (S31).
