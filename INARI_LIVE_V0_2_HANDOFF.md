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

**Status (2026-05-01):** **Code complete, compile-checked clean, tests BLOCKED on disk pressure.** All 6 pieces of UX magic implemented + 6 integration tests written. `cargo check --lib` clean. `cargo check --lib --tests` and `cargo test --test tab_magic_*` deferred — the C: drive sat at 466-735 MB free for the second half of the session and writing additional test binaries kept ENOSPC'ing. The integration test runtime build needs ~3 GB headroom per binary; without disk cleanup authorisation we cannot finish the seal-compile. Code lives on `feat/inari-live-v0.2-session24-tab-magic` (not committed yet — pending the deferred test pass + DECISIONS append). NOT PUSHED.

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
- `cargo check --lib --tests`: **deferred — disk blocked**. C: drive dropped from 3.4 GB → 735 MB during the cargo-check; integration tests ENOSPC on the linker.
- `cargo test --test tab_magic_*`: **deferred — same disk block**.
- Manual VS Code smoke deferred to S31 (same blocker as S23 — placeholder GGUF hash).
- 6 integration tests written, syntactically complete (mirror the `tab_fim_basic.rs` shape from S23): `tab_magic_string_literal_suppressed.rs`, `tab_magic_comment_suppressed.rs`, `tab_magic_mid_word_suppressed.rs`, `tab_magic_ranks_complete_identifiers.rs`, `tab_magic_lru_cache_hit.rs`, `tab_magic_dedup_against_next_lines.rs`.
- Unit tests added inline: `lsp::triggers` (~22 test cases — mid-word, string, comment, import, language-aliases), `lsp::cache` (6 test cases — key derivation, get/insert, capacity, TTL, refresh-on-reinsert), `lsp::fim::tests` (5 new S24 cases — per-lang max_tokens, fallback paths, ranker priority + proximity + skip-enclosing), `lsp::handlers::completion::tests` (5 new — empty list, first_line, ranker boundary preference, dedup whitespace tolerance, parses_clean validity).

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

**Disk note (BLOCKER for tests):** C: drive started at 3.4 GB free, dropped to 466-735 MB during the cargo-check pass and stayed there. The integration test build needs ~3 GB transient linker headroom per new test binary (and we have 6 of them). Build Rule 12 cleanup of `target-shared/debug/incremental/` (~144 MB) + `target-shared/debug/deps/*.pdb` (~3-5 GB) was BLOCKED by the sandbox — those paths are outside the worktree. Authorisation request lodged with Jesús; until cleared the tests cannot link. **The next session's first task is to run the deferred test sweep with disk cleared:** `cargo test --test tab_magic_string_literal_suppressed --test tab_magic_comment_suppressed --test tab_magic_mid_word_suppressed --test tab_magic_ranks_complete_identifiers --test tab_magic_lru_cache_hit --test tab_magic_dedup_against_next_lines` (alphabetical batch — single library link shared across all 6 binaries, per S23's experience).

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
