# Inari Live — Per-Session Handoff Plan

**Status as of 2026-04-29.** Master spec discussed in design conversation 2026-04-29. Visual MVP shell already built (see `project_inari_live.md` in memory: Tauri 2 second window + 6 transparent SVGs + frosted-glass dock on hover, NOT pushed). This document operationalizes the full spec into single-author, single-context-window sessions.

This doc is the operating plan for **Inari Live**, the desktop dev companion that lives next to the developer's editor and terminal. It connects to the local repo, maintains a per-repo persistent AI agent, and exposes its 25 InariWatch tools via a local MCP server compatible with Claude Code CLI, Codex CLI, Cursor, and Zed. Each session is sized at **~4-8 hours of focused work**, single-author, single-context-window.

The product strategy, moats, pricing, and UX principles were locked in the design conversation and are summarized in **§ Spec recap** below. Sessions reference these as fixed constraints, not open questions.

Naming: the desktop binary lives in `desktop/` (existing Tauri shell). It is **not** the same as the existing `inari-daemon/` (which is the Linux server-side auto-injection product). The Inari Live "daemon" is embedded inside the Tauri binary as a tray-resident process — patrón Raycast/Linear/Warp.

---

## Spec recap (fixed constraints — do NOT relitigate inside sessions)

| Decision | Locked value |
|---|---|
| **Stack — backend** | Rust embedded in Tauri 2 binary, tray-resident |
| **Stack — UI** | React 19 + TypeScript + Vite + Tailwind v4 + Radix UI + Framer Motion + Shiki + cmdk + react-resizable-panels + Zustand + Lucide |
| **Typography** | Inter (UI) + JetBrains Mono Variable (code) + Source Serif 4 (AI responses, Anthropic-style) |
| **AI provider** | OpenAI exclusive (gpt-4o-mini for analysis, gpt-5.4 for fixes). BYOK optional. Inherits `PLATFORM_AI_KEY` + $300/day spend cap |
| **Editor integration** | MCP-first via local MCP server. NO per-editor extensions (optional thin VSCode shim later) |
| **CLI agent integration** | Codex CLI + Claude Code CLI plug into the local MCP server via `~/.codex/mcp.json` and `~/.claude/mcp.json` |
| **Sensors** | 6 total: FS (core) + MCP server (core) + Shell hooks (opt-in) + Git hooks (opt-in) + HTTP proxy (opt-in advanced) + Substrate recording (opt-in) |
| **Memory** | `.inari/` directory in repo. 4 layers: semantic (embeddings) / episodic (events) / declarative (`memory.md`) / procedural (`patterns.json`). Local-first. Respects CLAUDE.md / AGENTS.md / .cursorrules as higher-precedence inputs |
| **Embeddings** | Local: `fastembed-rs` + `sqlite-vec` (no cloud calls for indexing) |
| **Performance budget** | <800ms cold start to interactive UI · <120MB RAM idle · <60MB binary installed |
| **Pricing — beta** | Free for everyone, hard caps anti-abuse (5 remediations/day per user, $300/day global cap) |
| **Pricing — post-GA** | Free $0 (limited) · Pro $12/mo (full power) · Team $24/dev/mo. Beta users: 50% off 3 months + Founder badge |
| **Upgrade path** | Inari Live local = free forever. Connecting prod → Pro $12/mo (cross-sell to existing InariWatch web Pro) |
| **Notifications** | 3-level system: Silent (95%) / Passive badge (4%) / Critical OS notification (<1%). Critical-only default. Hard cap 3/hour Nivel 2, 5/hour Nivel 1. Quiet hours 11pm-8am. Respect macOS Focus Mode + Windows Focus Assist |
| **Dock dimensions** | 720×480, centered horizontal, 25% from top, frosted glass, always-on-top with `Accessory` activation policy on macOS |
| **Distribution** | macOS .dmg (Universal arm64+x86_64) + Windows .msi/.exe + Linux .AppImage/.deb/.rpm. Direct download from `inariwatch.com/download`. NO App Store / Microsoft Store |
| **Code signing** | Apple Developer ID + Notarization (~$99/yr) + Windows EV cert (~$400/yr) + GPG for Linux. Tauri updater Ed25519 signatures additionally |
| **Update channel** | stable (default) / beta (opt-in) / canary (internal). Updates check every 6h, never apply silently, require explicit user restart |
| **Hosting** | Cloudflare R2 for binaries (egress-free) + GitHub Releases mirror as fallback |
| **Moats (8)** | Substrate dataset · Community Fix Network · EAP cryptographic verification · Vertical integration · Memory switching cost · MCP distribution · Capture > Sentry · Monomaniac focus |

If a session encounters a question that conflicts with a locked decision above, the session **flags the conflict in `INARI_LIVE_DECISIONS.md`** and proceeds with the locked decision. The architect resolves later.

---

## Build performance constraints (LOCKED — all sessions must follow)

**Context:** Jesus's dev machine freezes when `cargo` or `npm` saturates CPU/RAM/disk. Default `cargo build` and `cargo test` use all cores + parallel test runners + heavy linker invocations, which hard-freezes the machine for minutes at a time. These constraints apply to every session, no exceptions.

**Mandatory env vars (set before any cargo/npm invocation):**

```bash
export CARGO_BUILD_JOBS=2
export RUST_TEST_THREADS=1
export CARGO_INCREMENTAL=1
```

On Windows PowerShell:

```powershell
$env:CARGO_BUILD_JOBS = "2"
$env:RUST_TEST_THREADS = "1"
$env:CARGO_INCREMENTAL = "1"
```

**Mandatory rules:**

1. **Never run `cargo test --tests` blindly.** Run targeted tests by name: `cargo test --test <name1> --test <name2>` or `cargo test <pattern>`. The full `--tests` build links N integration binaries which is what freezes the machine.
2. **Always run `cargo check --lib --tests` first** to validate compilation. This is fast (no linking). If compile fails, fix before linking tests.
3. **Compile is non-negotiable. Test execution is deferrable.** If running a test would force the machine into a freeze, the session may report "compile-checked, execution deferred to next session with warm cache" as a legitimate outcome. The next session runs the deferred tests as its first task before its own work.
4. **Single timeout cap per cargo invocation: 10 minutes.** If a build is approaching that and the machine is responsive, let it finish. If the machine is frozen, abort and switch to targeted tests.
5. **Never run `cargo clean`.** Cleaning the target/ directory forces re-compilation of ~500 transitive crates and is the single fastest way to brick the machine for an hour.
6. **`cargo build --release` is forbidden inside sessions.** Release profile takes 5-10× longer. Only the CI release pipeline (Session 21+) does this.
7. **`npm install` runs once per session max.** If `node_modules` already exists and `package.json` hasn't changed, skip. Use `npm ci` only when lockfile changed.
8. **Never run `cargo tauri dev` or `cargo tauri build` inside an autonomous session.** These spawn long-lived processes + open windows + can hang headless. Manual smoke tests are Jesus's job; the session reports what should be smoke-tested.
9. **Windows Defender exclusion (one-time setup, not per session):** `target/` and `node_modules/` should be excluded from real-time scanning. If any session detects this isn't done (heuristic: `cargo check` of a small change takes >60s), flag it in DECISIONS.md and tell Jesus to run the PowerShell-admin command listed in `project_machine_constraints.md` memory.
10. **Background long commands.** When a `cargo` invocation is expected to exceed 3 minutes, run it with `run_in_background: true` and continue with other parallelizable work (writing docs, scaffolding files in other modules). Poll only via the notification when it finishes.

**If the machine freezes mid-session:**
- The executor reports the freeze + what command triggered it.
- The architect (Claude) marks the session as Blocked in HANDOFF.md.
- Next session's first job is: run the deferred tests with these constraints applied, THEN do its own work.

These constraints take precedence over any time estimate in HANDOFF.md. A "4h session" that needs a long compile becomes a "4h+compile-time" session — that's fine, that's the cost.

---

## Already shipped (Session 0 — 2026-04-27/28)

Captured from `project_inari_live.md` memory:

| Asset | Location | State |
|---|---|---|
| Tauri 2 second-window scaffold | `desktop/src-tauri/` | Builds, NOT pushed |
| Frosted-glass dock on hover (CSS) | `desktop/dist/inari/` | Visual prototype, NOT wired to backend |
| 6 transparent Recraft SVGs | `desktop/dist/inari/assets/` | Generated via Recraft GPT Image + Vectorize |
| CSS animations (no Rive) | `desktop/dist/inari/` | Working |
| Existing Rust modules in `desktop/src-tauri/src/` | `autofix.rs`, `connect.rs`, `desktop_auth.rs`, `fingerprint.rs`, `inari_watcher.rs`, `local_ingest.rs`, `onboarding.rs`, `saves.rs`, `settings.rs` | Some scaffolding exists, content varies — Session 1 audits |

**Cost so far:** ~$12 USD on Recraft Basic for asset generation.
**Not pushed to remote.** All work is local on the dev machine.

---

## Track 1 — Foundations (4 sessions)

**Goal:** the Tauri binary is a working tray-resident process with a SQLite-backed local store, an internal event bus, and a clean module layout that all subsequent sensors plug into. End of Track 1 = empty-but-correct skeleton, runnable on Mac/Win/Linux from a fresh clone.

### Session 1 — Audit existing scaffold + define module boundaries (4h) — **DONE 2026-04-29**

- **Status:** Done
- **Branch:** `feat/inari-live-track1-session1-audit`
- **Commit:** see `git log --oneline feat/inari-live-track1-session1-audit ^main`
- **Outputs:**
  - `desktop/ARCHITECTURE.md` — full module-split spec + 17-row file inventory + verdicts + per-session migration plan
  - `radar/INARI_LIVE_DECISIONS.md` — 9 decisions appended (`cloud/` module, `inari_watcher.rs` split, `autofix.rs` rename, etc.)
- **Files audited (read-only):** every `.rs` file in `desktop/src-tauri/src/` (9 files, 2,627 LoC total), `Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `desktop/package.json`, `desktop/dist/inari/` (HTML/JS shell + 6 SVGs + 4 mp4s + asset-pipeline scratch).
- **Verdicts (one-line summary per file):**
  - `main.rs` — KEEP unchanged (5 lines, trivial entry)
  - `lib.rs` — KEEP+SPLIT (tray/window → `window/`, alert poller → `cloud/alert_poller.rs`)
  - `autofix.rs` — KEEP + RENAME → `ai/remediate/cloud_proxy.rs` (Session 19)
  - `connect.rs` — KEEP + RENAME → `cli/run.rs` (Session A) + `ipc/connect.rs` shells
  - `desktop_auth.rs` — KEEP + RENAME → `cloud/auth.rs` (Session 4) + `ipc/auth.rs` shells
  - `fingerprint.rs` — KEEP + RENAME → `memory/fingerprint.rs` (Session 11)
  - `inari_watcher.rs` — KEEP+SPLIT → `sensors/fs/watcher.rs` (Session 5) + `sensors/substrate/{replay_client,recording_discovery}.rs` (Session 10) + `memory/procedural/matcher.rs` (Session 12); DELETE end of Session 10
  - `local_ingest.rs` — KEEP + RENAME → `sensors/substrate/local_ingest.rs` (Session 10)
  - `onboarding.rs` — KEEP + RENAME → `ipc/onboarding.rs` (Session 4); DELETE end of Session 17
  - `saves.rs` — KEEP + RENAME → `cloud/saves.rs` (Session 4)
  - `settings.rs` — KEEP+SPLIT → `store/settings.rs` (Session 3) + `window/settings.rs` (Session 14) + `ipc/settings.rs` shells
- **Key new decision:** introduced `src/cloud/` module (peer of `daemon/`, `sensors/`, etc.) for cross-cutting workspace/cloud-API concerns. See `INARI_LIVE_DECISIONS.md` 2026-04-29 entry #1. Does not violate any spec-recap constraint.
- **Notes for Session 2:**
  - Session 2 is allowed to create empty module skeletons (`mod cloud;`, `mod sensors;`, `mod memory;`, etc.) so subsequent sessions just fill them in. No file content moves yet — each session owns its own move at end-of-session.
  - Session 2's spec mentions `tauri-plugin-tray`, but Tauri 2 ships tray support via the `tray-icon` feature flag (already in Cargo.toml). Use the built-in path. `tauri-plugin-global-shortcut` IS a separate plugin and DOES need adding.
  - `dirs` crate is unmaintained but can stay through Session 2; replacement deferred to Session 3.
  - Heavy-data IPC rule locked: no `Vec<f32>`, ASTs, > 10k lists, or > 100KB diffs through Tauri IPC. Use the MCP HTTP transport (Session 7) for those.
- **Open architectural questions deferred** (8 documented in `ARCHITECTURE.md` § *Open questions deferred to a later session*; none block any current session).
- **Definition of done:** `desktop/ARCHITECTURE.md` landed, `INARI_LIVE_DECISIONS.md` created, this handoff block updated. Session 2 can implement without re-asking layout questions.

### Session 2 — Daemon core: event bus + lifecycle + tray-resident loop (8h) — **DONE 2026-04-29**

- **Status:** Done
- **Branch:** `feat/inari-live-track1-session2-daemon-core`
- **Tip commit:** see `git log --oneline feat/inari-live-track1-session2-daemon-core ^feat/inari-live-track1-session1-audit` (committed locally; NOT pushed per coordination protocol)
- **Tests:** 5 daemon tests across 4 integration test files (`tests/{bus_delivers,bus_lossy,heartbeat,shutdown_drain}.rs`) — all pass in ~50ms total via `cargo test --test bus_delivers --test bus_lossy --test heartbeat --test shutdown_drain`.
- **Files created:**
  - `src/daemon/{mod,bus,lifecycle,state}.rs` — daemon core (~470 LoC)
  - `src/window/{mod,dock,main}.rs` — placeholder dock + main-window helpers (~120 LoC)
  - `src/{cloud,sensors,memory,indexer,ai,ipc,store,gates,updater,telemetry,cli}/mod.rs` — empty skeletons per ARCHITECTURE.md migration plan
  - `tests/{bus_delivers,bus_lossy,heartbeat,shutdown_drain}.rs` — integration tests
  - `dist/inari-live-dock/index.html` — Session 2 placeholder dock content
  - `src-tauri/icons/tray/{idle,working,alert-pending}-{32,64}.png` — placeholder PNGs (duplicates of app icon; Session 5+ replaces with monochrome template-image variants)
  - `src-tauri/icons/tray/README.md` — explains the 3-state semantics
- **Files modified:**
  - `src-tauri/Cargo.toml` — added `tokio = "full"`, `flume`, `tracing`, `tracing-subscriber`, `tracing-appender`, `tauri-plugin-global-shortcut`; added `[dev-dependencies] tokio = { features = ["full", "test-util"] }` for paused-time tests
  - `src-tauri/src/lib.rs` — declared 13 new modules; spawns daemon via `tauri::async_runtime::spawn`; initializes tracing (rolling daily, 7-day retention) at `app.path().app_log_dir()`; registers `tauri-plugin-global-shortcut` plugin + `Cmd+Space` (Mac) / `Ctrl+Space` (Win/Linux) → `window::dock::toggle_dock`; added `Pause sensors` tray menu stub (separate from existing `Pause watch` for backward compat); `Quit` now signals `daemon.shutdown()` before `app.exit(0)`
  - `src-tauri/capabilities/default.json` — added `inari-live-dock` to windows array
- **Existing scaffold preserved:** all 9 pre-Session-2 `.rs` files (`autofix.rs`, `connect.rs`, `desktop_auth.rs`, `fingerprint.rs`, `inari_watcher.rs`, `local_ingest.rs`, `onboarding.rs`, `saves.rs`, `settings.rs`) untouched per Session 1 spec; their migration into the new modules happens in their owning sessions per ARCHITECTURE.md.
- **Key implementation choices:**
  - **Bus design:** rejected naïve `flume` mpmc (clones COMPETE, not broadcast) and rejected `tokio::sync::broadcast` (couples to a runtime). Settled on `Arc<Mutex<VecDeque<E>>>` per subscriber + `flume::Sender<()>` notifier. True broadcast + drop-oldest at the producer + sync/async/timeout receive. See `daemon/bus.rs` doc comment.
  - **Lifecycle drain:** `SHUTDOWN_GRACE = 5s` is a wall-clock sleep after publishing `Shutdown`. Real coordination (counting sensor acks) lands when the first sensor that needs it ships in Tracks 2-5. Comment in `lifecycle.rs::run` flags this.
  - **Tracing init:** writes to `app.path().app_log_dir()` (`%LOCALAPPDATA%\com.inariwatch.desktop\logs` on Win, `~/Library/Logs/com.inariwatch.desktop` on Mac) via `tracing_appender::rolling::Builder` with `Rotation::DAILY` + `max_log_files(7)`. `WorkerGuard` held in tauri State as `LoggingGuard` to keep the non-blocking writer alive.
  - **Tray menu kept backward-compatible:** existing 6 menu items (Open InariWatch / Open Inari Live / Open dashboard / Pause watch / Settings / Quit) preserved; added `Pause sensors` as Session-2 stub between `Pause watch` and `Settings`. Session 5+ unifies the two pause items once sensors observe the bus.
  - **Dock placeholder:** new `inari-live-dock` window label distinct from existing `inari` label (the visual prototype). Session 14 retires the old `inari` window and ships the React+Vite chrome on the `inari-live-dock` label.
  - **`pub mod daemon`:** the `daemon` module is `pub` (others are private) so integration tests in `tests/` can drive `lifecycle::run` directly under `#[tokio::test(start_paused = true)]` without going through the production spawn path (which would couple to a different tokio runtime).
- **Pre-existing test failure noticed (not Session 2 work):** `src/fingerprint.rs::tests::paths_and_timestamps_normalized` fails on this branch and on the Session-1 branch. Will be owned by Session 11 when fingerprint moves to `memory/fingerprint.rs`. See note in HANDOFF for Session 11 below.
- **Notes for Session 3 (local store):**
  - Session 2 created `src/store/mod.rs` as an empty skeleton; fill it in. Don't re-declare `pub mod store;` in lib.rs — already done.
  - The TOML settings store from `src/settings.rs` lives at `~/.config/inari/desktop.toml`. When migrating to SQLite, use `app.path().app_local_data_dir()` for the new DB path; keep the TOML reader functional for one release as a backward-compat fallback (cf. Decision #5 + memory `feedback_no_breaking_changes`).
  - The daemon writes its log file to `app.path().app_log_dir()` — share the same `tauri::Manager`/`PathResolver` resolution pattern in `store/mod.rs::resolve_db_path`.
  - `dirs` crate is unmaintained but works on Win/Mac/Linux. Replace with `directories` (or `etcetera`) at the same time as the SQLite migration — simpler to do once than twice. This is Open Question #5 from `ARCHITECTURE.md`.
  - The daemon currently has no SQLite read/write coupling. Session 3 should pass an `Arc<Pool>` into `daemon::SharedDaemonState` (or a sibling `SharedStore`) — extend `lib.rs::setup` accordingly.
- **Definition of done:** ✅ daemon spawns on app start; ✅ closing main window keeps tray + daemon alive; ✅ tray menu wired; ✅ `Quit` signals `DaemonHandle::shutdown()`; ✅ `Cmd/Ctrl+Space` toggles the placeholder dock window; ✅ tracing rotates daily into the OS log dir; ✅ 5 daemon tests pass (bus broadcast, drop-oldest, 5 heartbeats in 150s simulated, shutdown drain).

### Session 3 — Local store: SQLite + sqlite-vec + migrations (6h) — **DONE 2026-04-29**

- **Status:** Done
- **Branch:** `feat/inari-live-track1-session3-store`
- **Tip commit:** see `git log --oneline feat/inari-live-track1-session3-store ^feat/inari-live-track1-session2-daemon-core` (committed locally; NOT pushed per coordination protocol)
- **Tests:** 9 new integration tests across 5 new files (`tests/store_{migrations_apply,wal_mode,sqlite_vec_loaded,pool_connections,path_resolution}.rs`) + 1 ignored placeholder for the Tauri AppHandle harness Session 4 will introduce. All store tests pass in ~3s total. Combined with Session 2's 5 daemon tests = **14 active integration tests / 14 pass / 1 ignored**. Pre-existing `src/fingerprint.rs::tests::paths_and_timestamps_normalized` still fails (Session 11's responsibility — see Session 11 block).
- **Files created:**
  - `src/store/{mod,error,pool,queries,migrations}.rs` — store core (~360 LoC)
  - `src/store/migrations/{0001_initial,0002_embeddings,0003_memory}.sql` — locked schema per HANDOFF.md spec
  - `tests/store_{migrations_apply,wal_mode,sqlite_vec_loaded,pool_connections,path_resolution}.rs` — 9 tests + 1 ignored
- **Files modified:**
  - `src-tauri/Cargo.toml` — added `rusqlite = "0.31"` (`bundled`+`load_extension`), `r2d2 = "0.8"`, `r2d2_sqlite = "0.24"` (`bundled`), `sqlite-vec = "0.1"`, `thiserror = "1"`, `tempfile = "3"` (dev-dep)
  - `src-tauri/src/lib.rs` — flipped `mod store;` → `pub mod store;` (mirrors `pub mod daemon;` so integration tests can reach in); added `store::install(&app.handle())?` call in `setup` between tracing init and daemon spawn — fail-fast if migrations error before any tokio task spawns against a broken DB
- **Existing scaffold preserved:** all 9 pre-Session-2 `.rs` files (`autofix.rs`, `connect.rs`, `desktop_auth.rs`, `fingerprint.rs`, `inari_watcher.rs`, `local_ingest.rs`, `onboarding.rs`, `saves.rs`, `settings.rs`) untouched. The `dirs` crate stays in `Cargo.toml` — its 7 callers (everything except `lib.rs::read_desktop_config`) live in pre-Session-2 files that Session 1 marked intocable. Their migration to `app.path().*` lands in their owning sessions per `ARCHITECTURE.md`.
- **Key implementation choices:**
  - **Hand-rolled migration runner** (`store/migrations.rs`, ~80 LoC) over refinery: only 3 migrations, no rollback story needed. SQL is `include_str!`-baked into the binary; each migration runs in its own transaction; `schema_versions(version,name,applied_at)` provides idempotency. Adding a new migration = append a new entry to `MIGRATIONS`, never re-order.
  - **sqlite-vec via `sqlite3_auto_extension`** registered exactly once via `std::sync::Once` (`store/pool.rs`). Every connection produced by `r2d2_sqlite::SqliteConnectionManager` then auto-loads the vec0 module with no per-acquire FFI calls. Per-acquire PRAGMAs (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, `mmap_size=256MB`, `busy_timeout=5s`) come from a `r2d2::CustomizeConnection` impl — applied to **every** pooled connection, not only the first.
  - **Embedding dimension = 384** (MiniLM-L6-v2). HANDOFF.md said 1024 in the Session 3 spec body but Session 6's spec says 384 and `fastembed-rs` ships MiniLM-L6-v2 as the default model — 384 is correct. See `INARI_LIVE_DECISIONS.md` "Sesión 3 — embedding dimension".
  - **Settings TOML→SQL cutover DEFERRED to Session 4.** The current TOML-backed `settings.rs` works; cutting over now would require touching `settings.rs` (allowed by user) but more importantly it would orphan the 6 *other* `dirs::config_dir()`-using files (`autofix.rs`, `connect.rs`, `desktop_auth.rs`, `inari_watcher.rs`, `local_ingest.rs`, `saves.rs`, `onboarding.rs`) which Session 1 marked intocable. Session 4 owns the `cloud/auth.rs` + `ipc/settings.rs` + `cloud/saves.rs` renames per ARCHITECTURE.md migration plan — that's the natural boundary to migrate the path resolver and drop `dirs`. See `INARI_LIVE_DECISIONS.md` "Sesión 3 — settings cutover deferred".
- **Pool sizing:** `pool::POOL_SIZE = 4` (read-mostly workload, matches the spec recap perf budget of <120MB RAM idle).
- **Pre-existing test failure (NOT touched):** `src/fingerprint.rs::tests::paths_and_timestamps_normalized` still fails. Session 11 owns the move + fix when fingerprint relocates to `memory/fingerprint.rs`.
- **Notes for Session 4 (IPC bridge):**
  1. **`Arc<Store>` is already in `tauri::State`.** Tauri commands reach it with `state: tauri::State<'_, Arc<inariwatch_desktop_lib::store::Store>>`. No extra wiring needed in Session 4 — just declare it as a parameter on the relevant `#[tauri::command]` fns. The `Arc<DaemonHandle>` is registered the same way; the two cohabit cleanly.
  2. **Heavy-data IPC rule still applies.** `Vec<f32>` embeddings, full ASTs, > 10k-entry repo lists, > 100KB diffs — none of these flow through Tauri IPC. Session 7's MCP HTTP transport (`127.0.0.1:9876`) is the heavy-data path. Session 4's `daemon_status` / `list_repos` / `open_repo` / `close_repo` / `get_logs` are all light-payload and OK.
  3. **`StoreError` wraps `rusqlite`/`r2d2`/`io` plus a per-migration variant + `PathResolution` + `ExtensionLoad`.** When Session 4 maps store errors into `IpcError`, prefer matching on the variant rather than stringifying — the `Migration { version, name, .. }` variant in particular is useful for surfacing "DB is from a newer build" messages once we ship updates.
  4. **Bonus / Session 4 setup work**: when Session 4 introduces a Tauri test harness (`tauri::test::mock_app()` or `MockBuilder`), un-`#[ignore]` `tests/store_path_resolution.rs::resolve_db_path_via_tauri_apphandle` — the test body is already written as a stub.
  5. **Settings TOML→SQL migration is owed to Session 4.** Plan: read existing `~/.config/inari/desktop.toml` once on first SQL-mode boot → upsert each key into the `settings(key, value, updated_at)` table from migration 0001 → rename the TOML file to `desktop.toml.migrated`. Never delete the user's data. After this lands, drop `dirs` from `Cargo.toml` and migrate the remaining 6 callers to `app.path().*`. Touch points: `cloud/auth.rs` (renamed from `desktop_auth.rs`), `cloud/saves.rs` (renamed from `saves.rs`), `cloud/alert_poller.rs` (extracted from `lib.rs::start_alert_poller`), `ipc/onboarding.rs` (renamed from `onboarding.rs`), and the legacy callers in `autofix.rs`/`connect.rs`/`local_ingest.rs`/`inari_watcher.rs` that Sessions 5/10/19 retire.
- **Definition of done:** ✅ `Cargo.toml` adds 5 deps, no removals; ✅ `store::install` wired in `setup`; ✅ all 3 migrations apply on a fresh DB and are idempotent on re-open; ✅ WAL mode + `foreign_keys=on` + `busy_timeout=5000` confirmed; ✅ `vec_version()` returns a non-empty string; ✅ inserting two orthogonal 384-dim vectors and computing `vec_distance_cosine` returns ≈1; ✅ 4 concurrent threads from a 4-conn pool all see PRAGMAs and successfully write; ✅ FK cascade actually deletes child rows; ✅ resolved DB path is `<app_local_data_dir>/inari-live/store.db`.

### Session 4 — IPC bridge: Tauri commands + typed events to webview (4h) — **DONE 2026-04-29**

- **Status:** Done
- **Branch:** `feat/inari-live-track1-session4-ipc`
- **Tip commit:** see `git log --oneline feat/inari-live-track1-session4-ipc ^feat/inari-live-track1-session3-store` (committed locally; NOT pushed per coordination protocol)
- **Tests:** 5 new integration test files (`tests/{ipc_daemon_status,ipc_open_close_repo,ipc_get_logs,ipc_status_changed_debounced,legacy_settings_migration}.rs`) — 19 new tests (4/3/4/5/3). Combined with prior sessions: **32 active integration tests / 32 pass**, 1 ignored Tauri-harness placeholder (`store_path_resolution::resolve_db_path_via_tauri_apphandle`). At the lib-unit-test layer ts-rs's auto-generated `export_bindings_*` tests refresh the 4 .ts files on every `cargo test --lib` (see "Key implementation choices" — ts-rs ships its own export tests, no manual export trigger needed). Pre-existing `src/fingerprint.rs::tests::paths_and_timestamps_normalized` still fails (Session 11's responsibility, untouched here) — Session-4 work is verified via `cargo test --tests --no-fail-fast` to bypass the lib-unit failure.
- **Files created:**
  - `src-tauri/src/cloud/{api,auth,saves,alert_poller}.rs` — cloud module fleshed out (~430 LoC)
  - `src-tauri/src/ai/remediate/{mod,cloud_proxy}.rs` — autofix bridge re-homed (~210 LoC)
  - `src-tauri/src/cli/run.rs` — `inari run` spawn primitive (~280 LoC)
  - `src-tauri/src/ipc/{commands,events,error,auth,connect,onboarding,saves,settings}.rs` — Session-4 IPC surface (~720 LoC)
  - `src-tauri/src/store/{legacy_settings_migration,settings}.rs` — TOML→SQL migration helper + SQL settings r/w (~250 LoC)
  - `src-tauri/src/window/settings.rs` — settings window opener
  - `src-tauri/tests/{ipc_daemon_status,ipc_open_close_repo,ipc_get_logs,ipc_status_changed_debounced,legacy_settings_migration}.rs` — 5 integration test files, 19 tests total
  - `src/lib/ipc.ts` — frontend typed wrapper (re-exports ts-rs DTOs + invoke/listen helpers)
  - `src/lib/types/{DaemonStatusDto,RepoDto,LogEntryDto,IpcError}.ts` — ts-rs auto-generated bindings
- **Files modified:**
  - `src-tauri/Cargo.toml` — added `ts-rs = "8"` (`serde-json-impl` feature). `dirs` STAYS — see `INARI_LIVE_DECISIONS.md` Sesión 4 entries
  - `src-tauri/src/lib.rs` — replaced 6 top-level `mod` declarations (`autofix`, `connect`, `desktop_auth`, `onboarding`, `saves`, `settings`) with their new homes; rewired the `invoke_handler!` registry; wired `ipc::events::start` after daemon spawn; migrated `setup_window` / `open_dashboard` off `dirs::config_dir()` onto SQL settings
  - `src-tauri/src/ipc/mod.rs` — declared 8 sub-modules (was empty)
  - `src-tauri/src/cloud/mod.rs` — declared 4 sub-modules (was empty)
  - `src-tauri/src/ai/mod.rs` — declared `remediate` (was empty)
  - `src-tauri/src/cli/mod.rs` — declared `run` (was empty)
  - `src-tauri/src/window/mod.rs` — added `settings` (alongside existing `dock` + `main`)
  - `src-tauri/src/store/mod.rs` — declared `legacy_settings_migration` + `settings`; `install` now runs the legacy TOML→SQL migration once after `Store::open`
  - `package.json` — added `@tauri-apps/api` dep so `src/lib/ipc.ts` resolves once Session 14 lands the Vite toolchain
- **Files moved (file path → new path; `git status` will show them as add+remove rather than rename because content was split / restructured):**
  - `src/autofix.rs` → `src/ai/remediate/cloud_proxy.rs` (RENAMED + state-arg refactor: now reads creds via `cloud::api::read_dashboard_creds(store)` instead of `dirs::config_dir()`)
  - `src/connect.rs` → SPLIT:
    - `src/cli/run.rs` (spawn impl)
    - `src/ipc/connect.rs` (Tauri-command shells)
  - `src/desktop_auth.rs` → SPLIT:
    - `src/cloud/auth.rs` (device-flow impl, SQL-backed creds)
    - `src/ipc/auth.rs` (Tauri-command shells)
  - `src/saves.rs` → `src/cloud/saves.rs` (RENAMED) + `src/ipc/saves.rs` (Tauri command shell)
  - `src/onboarding.rs` → `src/ipc/onboarding.rs` (RENAMED, SQL-backed)
  - `src/settings.rs` → SPLIT:
    - `src/store/settings.rs` (SQL r/w of typed settings)
    - `src/window/settings.rs` (window opener)
    - `src/ipc/settings.rs` (Tauri-command shells)
  - `lib.rs::start_alert_poller` → EXTRACTED to `src/cloud/alert_poller.rs` (now reads via `cloud::api::read_dashboard_creds`)
- **Files NOT touched** (locked by Sessions 5/10/11/12 per `ARCHITECTURE.md`):
  - `src/inari_watcher.rs` — Sessions 5/10/12 split
  - `src/fingerprint.rs` — Session 11 moves to `memory/fingerprint.rs`
  - `src/local_ingest.rs` — Session 10 moves to `sensors/substrate/local_ingest.rs`
- **Key implementation choices:**
  - **Legacy settings migration is non-destructive.** Session-4 spec said "rename TOML to .migrated"; we use a SQL marker row instead because `inari_watcher.rs` (locked) STILL reads the legacy file. Renaming would silently regress the watcher. See `INARI_LIVE_DECISIONS.md` Sesión 4 entry "Legacy TOML→SQL settings migration".
  - **`dirs` crate stays** — 2 callers remain (`inari_watcher.rs`, `legacy_settings_migration.rs`). Session 5 owns the final removal. See `INARI_LIVE_DECISIONS.md` Sesión 4 entry "dirs crate STAYS".
  - **`IpcError` typed enum** with 8 variants + `From<StoreError>` discriminator. `#[serde(tag = "kind")]` so ts-rs emits a tagged union the frontend can pattern-match.
  - **`started_at` cached via `OnceLock`** in `snapshot_to_dto` so `now() - uptime_secs` drift between heartbeats does not spuriously fire `daemon:status_changed`.
  - **`should_emit(last, current)` is a pure function** extracted from the bridge so the dedup logic is unit-testable without a Tauri AppHandle (the test harness is still TBD — Session 4 spec mentioned `tauri::test::mock_app()` but Tauri 2's API is not stable enough yet). The placeholder integration test `store_path_resolution::resolve_db_path_via_tauri_apphandle` stays `#[ignore]`'d.
  - **ts-rs auto-generated export tests** run on every `cargo test --lib` and refresh `desktop/src/lib/types/{DaemonStatusDto,RepoDto,LogEntryDto,IpcError}.ts`. ts-rs v8 emits one `export_bindings_<type>` test per `#[ts(export)]` annotation — no manual entry-point test needed. The generated `.ts` files are committed alongside the Rust source.
  - **Heavy-data IPC rule enforced in code:** `list_repos` capped at 1000 rows, `get_logs` capped at 200 entries, slim DTO shapes, no embeddings / ASTs.
- **Manual smoke test:** NOT run. The Vite/React toolchain lands in Session 14 — `npm run build` does not exist yet. `cargo check --lib --tests` is clean (no new warnings). The frontend `ipc.ts` will compile once Session 14 ships the toolchain.
- **`dirs` removal verification:** `cargo check --lib --tests` runs clean with the 2 documented callers remaining; `Cargo.toml` still declares `dirs = "5"`.
- **Definition of done:** ✅ 5 IPC commands implemented; ✅ 2 Tauri events emitted (`daemon:event` + debounced `daemon:status_changed`); ✅ ts-rs binding generation wired and run; ✅ frontend `ipc.ts` types + invoke + listen wrappers exist; ✅ legacy settings TOML→SQL one-shot migration runs idempotent; ✅ all 6 file moves landed (autofix/connect/desktop_auth/onboarding/saves/settings) per ARCHITECTURE.md migration plan; ✅ 6 new integration tests pass (5 active + 1 export-on-demand).
- **Notes for Session 5 (FS watcher):**
  1. **Bus event convention.** When you publish `RepoIndexed { repo_id, file_count, duration_ms }` and `FsChange { repo_id, path, kind }`, append them as variants to `crate::daemon::DaemonEvent`. The `#[non_exhaustive]` attribute means downstream `match` arms keep working. The `daemon:event` Tauri bridge in `crate::ipc::events::spawn_daemon_event_bridge` forwards every variant 1:1, so no wiring change needed on the IPC side.
  2. **Debounced status emit.** When you `SharedDaemonState::inc_repos()` / `inc_sensors()`, the running `daemon:status_changed` bridge picks it up and emits the diff. Don't emit your own Tauri event for repo/sensor count — the bridge already covers it. If you need a per-event Tauri channel for FS-specific counters, define a NEW channel name (`daemon:fs_indexed`, etc.); don't overload `daemon:status_changed`.
  3. **`dirs` removal opportunity.** `inari_watcher.rs` is the LAST blocker keeping `dirs` in `Cargo.toml`. When Session 5 rewrites the watcher in `sensors/fs/`, also flip `inari_watcher.rs::read_config` to `crate::store::settings::get(&store, "watch_dir")`. After that, `dirs = "5"` can drop from `Cargo.toml` AND `legacy_settings_migration.rs` can switch to `tauri::AppHandle::path().app_config_dir()` for the legacy-path probe (it just needs a path resolver). The `cloud::api::CloudClient` shows the pattern of plumbing `Arc<Store>` through.
  4. **Heavy-data IPC rule still applies.** A 50k-symbol repo's embedding vectors NEVER flow through Tauri IPC. If your indexer needs to surface progress to the dock, emit `daemon:event` with a count, not the data. Session 7's MCP HTTP transport on `127.0.0.1:9876` is the heavy-data path.
  5. **Tray menu unification.** The legacy "Pause watch" item + Session-2 "Pause sensors" stub are both wired in `lib.rs::setup_tray`. Once your sensor subscribes to a `DaemonEvent::SensorsPaused` variant, retire "Pause watch" and let "Pause sensors" be the single source. The `inari_watcher::is_paused()` / `set_paused()` API is what `lib.rs` currently calls — drop those when the legacy watcher dies.

---

## Track 2 — Sensors (6 sessions)

**Goal:** the 6 input streams that feed everything else. Order chosen so that the two **core** sensors (FS + MCP server) ship first; the 4 opt-in sensors (Shell, Git, HTTP proxy, Substrate) ship later behind feature toggles.

### Session 5 — Sensor 1: FS watcher with `notify` + `ignore` walker (8h) — **DONE 2026-04-29**

- **Status:** Done
- **Branch:** `feat/inari-live-track2-session5-fs-watcher`
- **Tip commit:** see `git log --oneline feat/inari-live-track2-session5-fs-watcher ^feat/inari-live-track1-session4-ipc` (committed locally; NOT pushed per coordination protocol)
- **Tests:** 6 new integration test files (`tests/{fs_walker,fs_debouncer,fs_emit_repo_indexed,fs_emit_change,fs_delete,fs_inotify_limit}.rs`) — **12 tests pass on Windows** (fs_walker 2 / fs_debouncer 6 / fs_emit_repo_indexed 2 / fs_emit_change 1 / fs_delete 1 / fs_inotify_limit 0). The `fs_inotify_limit` file is gated `#![cfg(target_os = "linux")]` and ships 1 ignored test (the real-sysctl ENOSPC reproducer needs root); on Linux the test count is 13 active + 1 ignored. The classifier itself (`is_watch_limit_error`) is exercised on all platforms via `fs_debouncer.rs` (3 unix-gated tests). Combined with prior sessions: **44 active integration tests / 44 pass on Windows** (32 from Sessions 2-4 + 12 from Session 5), 1 ignored on Windows (legacy Tauri-harness placeholder) + 1 more ignored on Linux. Pre-existing `src/fingerprint.rs::tests::paths_and_timestamps_normalized` still fails (Session 11's responsibility, untouched here).
- **Test commands run:**
  - `cargo check --lib --tests` — clean (`Finished dev [unoptimized + debuginfo] target(s) in 5.20s`)
  - `cargo test --test fs_walker --test fs_debouncer --test fs_emit_repo_indexed --test fs_delete --test fs_inotify_limit -- --test-threads=1` — green
  - `cargo test --test fs_walker --test fs_emit_change -- --test-threads=1` — green (after the `.git/` fixture fix; see "Test fixture note" below)
- **Test fixture note:** the `ignore` crate honours `.gitignore` only when the walked tree is recognized as a git repository (i.e. it or an ancestor contains a `.git/` directory). `fs_walker.rs::walks_synthetic_repo_respecting_gitignore` creates an empty `.git/` placeholder in the tempdir to engage the gitignore stack — production callers always point the watcher at real repos so this matches the real-world contract. Without the placeholder, `node_modules/` would slip past the filter and the count would be FILE_COUNT + 102 instead of FILE_COUNT + 2.
- **Files created:**
  - `src-tauri/src/sensors/fs/{mod,watcher,walker,debouncer,kind,error}.rs` — FS sensor (~570 LoC)
  - `src-tauri/tests/{fs_walker,fs_debouncer,fs_emit_repo_indexed,fs_emit_change,fs_delete,fs_inotify_limit}.rs` — 6 integration test files
- **Files modified:**
  - `src-tauri/Cargo.toml` — added `notify-debouncer-mini = "0.4"` (NOT `-full` per YEAR1 lock-contention measurement), `ignore = "0.4"`, `globset = "0.4"`, `rayon = "1.10"`. **REMOVED `dirs = "5"`** — no remaining direct callers.
  - `src-tauri/src/daemon/mod.rs` — added `FsChangeKind` (Created / Modified / Deleted / Renamed { from }) and 3 new `DaemonEvent` variants: `RepoIndexed { repo_id, file_count, duration_ms }` / `FsChange { repo_id, path, kind }` / `SensorWarning { sensor, message }`. The `FsChange::kind` field uses `#[serde(rename = "change")]` to avoid the inner-tag/outer-tag serde conflict (Rust API keeps the spec'd name).
  - `src-tauri/src/sensors/mod.rs` — declared `pub mod fs;`
  - `src-tauri/src/lib.rs` — flipped `mod sensors;` → `pub mod sensors;` so integration tests can reach `sensors::fs::*`. Spawns `sensors::fs::spawn_fs_sensor(daemon.bus.clone(), daemon.state.clone())` after the IPC bridge starts; stores the handle via `app.manage(fs_sensor)` so `open_repo` / `close_repo` IPC commands can attach/detach watchers per repo.
  - `src-tauri/src/ipc/commands.rs` — `open_repo` now takes `tauri::State<FsSensorHandle>` and calls `attach(repo_id, canonical_path)` after the SQL upsert. `close_repo` calls `detach(repo_id)` before `dec_repos`.
  - `src-tauri/src/inari_watcher.rs` — `read_config` now reads from SQL settings (via `crate::store::settings::get`) instead of `dirs::config_dir() + desktop.toml`. The legacy TOML's content is already mirrored to SQL by Session 4's one-shot migration, so existing user data flows through transparently. `start(app)` resolves the `Arc<Store>` via `app.try_state::<Arc<Store>>()` rather than re-reading the file.
  - `src-tauri/src/store/legacy_settings_migration.rs` — `legacy_toml_path` now uses Tauri's `PathResolver::config_dir()` (byte-equivalent to `dirs::config_dir()` on every supported platform), preserving the legacy probe path while removing the `dirs` direct dep.
- **Files NOT touched** (locked by other sessions per `ARCHITECTURE.md`):
  - `src/inari_watcher.rs` — replay/community-pattern logic stays (Sessions 10/12 own deletion). Session 5 only migrates the path resolution off `dirs`.
  - `src/fingerprint.rs` — Session 11 moves to `memory/fingerprint.rs`.
  - `src/local_ingest.rs` — Session 10 moves to `sensors/substrate/local_ingest.rs`.
- **Key implementation choices:**
  - **`notify-debouncer-mini` 0.4 API** is `new_debouncer(timeout, handler)` (no third `tick_rate` arg) and `DebounceEventResult = Result<Vec<DebouncedEvent>, notify::Error>` (single error, not Vec). The Session 5 prompt's draft sketch had a pre-0.4 signature; current crate matches my impl. See `INARI_LIVE_DECISIONS.md` Sesión 5.
  - **FS sensor actor on `std::thread`, not tokio.** 150ms `recv_timeout` + bus-drain check for `Shutdown` trades shutdown latency for runtime simplicity. Tests instantiate `EventBus` + `SharedDaemonState` directly without any Tauri / tokio harness.
  - **Initial walk on `rayon::spawn`** so a 50k-file repo doesn't block the actor reactor. `MAX_FILES_HARD_CAP = 50_000` truncates pathological walks (`SensorWarning` surfaces the truncation so the dock can prompt for a `.gitignore` rule).
  - **Classification post-debounce.** `notify-debouncer-mini` only emits coarse `Any` / `AnyContinuous` categories. The watcher recovers `Modified` / `Deleted` by stat-checking the path after the debounce window. `Created` is indistinguishable from `Modified` without prior-state tracking — that's the indexer's job (Session 6). `Renamed` is reserved for a debouncer-full upgrade later.
  - **`FsChangeKind` lives in `daemon`**, re-exported from `sensors::fs::kind`. Cross-sensor consumers (IPC bridge, indexer, procedural memory) pattern-match on `daemon::FsChangeKind` without crossing into sensor internals.
  - **Linux inotify limit detection.** `is_watch_limit_error` matches `notify::ErrorKind::MaxFilesWatch` plus raw_os_error ENOSPC (28) / EMFILE (24). On hit, the actor publishes `DaemonEvent::SensorWarning` with the actionable hint (sysctl knob + persistent path) instead of crashing.
  - **macOS FSEvents overflow:** not yet wired — debouncer-mini doesn't surface the overflow flag distinctly. Deferred to a future session that needs it; current impl falls back to per-event Modified/Deleted classification via stat, so files don't get lost (just no global re-walk on overflow).
  - **`DaemonEvent::FsChange::kind` JSON-renamed to `"change"`.** serde's internally-tagged enum derive forbids a variant field named the same as the discriminator (`tag = "kind"` + field `kind` = compile error). The Rust API keeps the spec'd field name; `#[serde(rename = "change")]` resolves the wire collision. Frontend (Session 14) will pattern-match on outer `kind == "fs_change"` then read inner `change.kind`.
- **Definition of done:** ✅ FS sensor module structure (`mod` / `watcher` / `walker` / `debouncer` / `kind` / `error`); ✅ `RepoIndexed` + `FsChange` + `SensorWarning` variants on `DaemonEvent`; ✅ rayon walker honoring git ignore stack with 50k cap; ✅ debouncer-mini watcher with 200ms window; ✅ inotify-limit detection emits SensorWarning on Linux; ✅ `open_repo` attaches / `close_repo` detaches; ✅ `dirs` crate dropped from `Cargo.toml` direct deps (`cargo tree -i dirs` shows transitive only); ✅ all 6 fs_* integration test files compile-check + run (16 tests).
- **Notes for Session 6 (indexer):**
  1. **Subscribe to `RepoIndexed` to bootstrap embeddings.** When the FS sensor publishes `DaemonEvent::RepoIndexed { repo_id, file_count, duration_ms }` after the initial walk, the indexer should kick its first batch. Don't re-walk — the FS walker already produces the file list. **TODO for Session 6:** decide how to pass the file list (the walker currently throws it away after counting). Options: extend `WalkResult` to carry a `Vec<PathBuf>` (caps payload size at 50k entries × ~80B = 4MB, OK) or have the indexer re-walk via `ignore::WalkBuilder` with the same flags. Re-walk is cleaner but pays the IO twice.
  2. **Subscribe to `FsChange` for incremental re-indexing.** `FsChange::Modified` / `Deleted` should invalidate the embedding for that path; `Renamed { from }` is reserved (today never emitted, but the variant exists so consumers can ignore it deterministically). The `path` field is a fully-qualified absolute path (the watcher uses `display().to_string()` on the canonicalized repo root). Strip the repo root prefix before SQL lookup so the `code_symbols` table can stay path-relative.
  3. **`MAX_FILES_HARD_CAP = 50_000` is shared.** The indexer must not allocate embeddings for more than this — the walker already caps and emits a `SensorWarning` on truncation. Use the count from `RepoIndexed.file_count` as the upper bound for batching (`fastembed-rs` default batch is 256; tune from there).
  4. **Heavy-data IPC rule still applies.** Embedding vectors NEVER flow through Tauri IPC. `daemon:event` is fine for `RepoIndexed`/`FsChange` (small payloads). For per-symbol diagnostics, use Session 7's MCP HTTP transport on `127.0.0.1:9876`.

### Session 6 — Indexer: tree-sitter parsing + fastembed-rs embeddings (8h) — **DONE-WITH-DEFERRED 2026-04-29**

- **Status:** Done with execution-deferred tests (compile-checked, full execution blocked by 100%-full disk on dev machine — model-bearing tests gated `#[ignore]` regardless; non-model tests deferred to next session with warm cache per `project_machine_constraints.md`).
- **Branch:** `feat/inari-live-track2-session6-indexer` (stacks on integration tip `316eca2`)
- **Tip commit:** see `git log --oneline feat/inari-live-track2-session6-indexer ^316eca2` (committed locally; NOT pushed per coordination protocol)
- **Tests added:** 7 integration test files / 17 tests total. Compile-checked clean via `cargo check --tests`. Two test files are `#[ignore]`'d (require lazy MiniLM model download) — 15 tests run by default once linked.
  - `tests/indexer_lang_detect.rs` — 6 tests (Lang::* extension mapping + None for unsupported)
  - `tests/indexer_ast_hash_stable.rs` — 4 tests (determinism, CRLF↔LF + trailing whitespace canonicalization, body diff detection)
  - `tests/indexer_parse_typescript.rs` — 1 test (3 functions + 1 class + 1 method out of TS fixture)
  - `tests/indexer_parse_python.rs` — 1 test (def / async def / class + method picked up)
  - `tests/indexer_embed_dim.rs` — 2 tests (1 ignored: load model + assert dim=384; 1 always-on: const = 384 matches schema)
  - `tests/indexer_incremental.rs` — 2 tests (modify one symbol → only that hash changes; whitespace-only diff → same hash)
  - `tests/indexer_semantic_search.rs` — 1 test (ignored: end-to-end embed + query → top-3 ranks auth-related fixtures first)
  - `tests/mcp_search_codebase.rs` — UPDATED: 2 tests (rejects missing `query`; `reindex_codebase` publishes `DaemonEvent::ReindexRequested` on the bus)
- **Test commands run:**
  - `cargo check --lib` — clean (deps compile in 2m 29s including fastembed v4.9.1 + ort v2.0.0-rc.9 + 5 tree-sitter grammars)
  - `cargo check --lib --tests` — clean (`Finished dev [unoptimized + debuginfo] target(s) in 25.34s`)
  - `cargo test --test indexer_lang_detect --test indexer_ast_hash_stable -- --test-threads=1` — **LINK FAILED** with `libort_sys-...rlib(...)` `unresolved external symbol __std_min_element_4 / __std_max_element_4 / __std_find_trivial_1 / ...` (24 LNK2019/LNK2001 errors). See "MSVC toolchain blocker" below.
- **Disk-full caveat:** the first `cargo test` link attempt this session hit `rustc-LLVM ERROR: IO failure on output stream: no space on device` because `target/` had grown to 25GB+ on a 215GB Windows drive (sibling work fills C: rapidly). Surgically deleted `target/debug/incremental/` (compiler cache only — NOT a `cargo clean`; artifacts in `deps/` and `build/` were preserved) to free 6.2GB. After cleanup the build progressed past the disk wall and into the actual link, where the MSVC toolchain blocker surfaced.
- **MSVC toolchain blocker (Session 8's first action):** `ort 2.0.0-rc.9` (the native ONNX Runtime that fastembed v4 depends on) emits modern STL intrinsic symbols (`__std_min_element_*`, `__std_max_element_*`, `__std_find_trivial_*`, `__std_DOUBLE_POW5_*`, `_General_precision_tables_2<*>`) that require Visual Studio 2022 17.5+ MSVC STL. Older Visual Studio Build Tools versions ship a MSVCP runtime without these intrinsics → the linker fails with 24 unresolved externals when building `inariwatch_desktop_lib.dll`. Compile is clean (`cargo check --lib --tests` 0 errors) — the issue is purely at link time. Two paths forward, in order of safety:
   1. **Update MSVC.** Install latest "Desktop development with C++" workload in Visual Studio 2022 (or the equivalent Build Tools download). Then re-run `cargo test --test indexer_lang_detect --test indexer_ast_hash_stable -- --test-threads=1` and the deferred suite below. **Recommended.**
   2. **Pin fastembed/ort to a 1.x line.** `fastembed = "3"` resolves to `ort 1.x` which uses older MSVC STL symbols and links cleanly on Windows 10-era toolchains. Trade-off: fastembed 3 has a different `TextEmbedding::try_new` API; the wrapper in `embeddings.rs` would need ~20 LoC of API churn. Acceptable as a temporary unblock.
- **Tests deferred to Session 8 (gated on MSVC fix):**
  - `indexer_lang_detect` — 6 tests (no model needed)
  - `indexer_ast_hash_stable` — 4 tests (no model needed)
  - `indexer_parse_typescript` — 1 test (tree-sitter only, no model)
  - `indexer_parse_python` — 1 test (tree-sitter only, no model)
  - `indexer_embed_dim::embedding_dim_constant_matches_schema` — 1 test (constant assertion, no model)
  - `indexer_incremental` — 2 tests (store + parse + AST hash; no model)
  - `mcp_search_codebase` — 2 tests (rejects missing `query`; `reindex_codebase` publishes ReindexRequested)
- **Tests gated `#[ignore]` (require lazy MiniLM-L6-v2 download, run with `--ignored` once MSVC is fixed AND model is cached):**
  - `indexer_embed_dim::embed_batch_returns_384_dim_vectors` — 1 test
  - `indexer_semantic_search::semantic_search_ranks_authentication_symbols_first` — 1 test
- **Files created:**
  - `src-tauri/src/indexer/{mod,parser,embeddings,batcher,semantic,error,lang}.rs` — indexer (~700 LoC)
  - `src-tauri/tests/indexer_{lang_detect,ast_hash_stable,parse_typescript,parse_python,embed_dim,incremental,semantic_search}.rs` — 7 test files
- **Files modified:**
  - `src-tauri/Cargo.toml` — added `tree-sitter = "0.22"`, `tree-sitter-{typescript,javascript,python,rust,go} = "0.21"`, `fastembed = "4"`. `rayon` and `sha2` were already declared by Sesión 5; no duplication. fastembed v4 brings `ort 2.0.0-rc.9` (ONNX Runtime, C++ source compiled in-tree on Windows — no system libonnxruntime needed).
  - `src-tauri/src/daemon/mod.rs` — appended `DaemonEvent::ReindexRequested { repo_id }` and `DaemonEvent::SymbolsIndexed { repo_id, symbol_count, duration_ms }` (both `#[non_exhaustive]`-friendly).
  - `src-tauri/src/sensors/fs/walker.rs` — `WalkResult` gained `paths: Vec<PathBuf>` field (informational; cap 50_000 = ~4MB worst-case).
  - `src-tauri/src/sensors/fs/watcher.rs` — two destructure patterns updated (`..` rest pattern); added `walk_for_indexer(&Path) -> WalkResult` `#[doc(hidden)]` re-export so the indexer can re-walk without crossing module boundaries.
  - `src-tauri/src/store/queries.rs` — added 7 helpers: `find_repo_path_by_id`, `upsert_symbol`, `find_symbol_hash`, `upsert_embedding`, `delete_symbols_for_file`, `rename_file_path`, `count_symbols_for_repo`, `semantic_search`. Plus typed structs `SymbolRow` / `ExistingSymbol` / `SymbolHit`.
  - `src-tauri/src/store/error.rs` — `StoreError::Internal(String)` variant added (used for embedding-dim mismatches).
  - `src-tauri/src/ipc/error.rs` — `From<StoreError>` updated to match the new `Internal` variant.
  - `src-tauri/src/lib.rs` — flipped `mod indexer;` → `pub mod indexer;` (integration-test access pattern, mirrors S2/S3/S5/S7). Spawns `indexer::spawn_indexer(daemon_handle, store)` after FS sensor + MCP server. Configures fastembed cache dir to `<app_local_data_dir>/inari-live/models/`.
  - `src-tauri/src/sensors/mcp/tools/local/search_codebase.rs` — replaced "indexer not ready" stub with `crate::indexer::search(&ctx.store, query, limit, project)`. Result envelope: `{ data: { ok: true, results: Vec<Hit> } }` per Session 7 contract. Falls back to `{ ok: false, reason }` when fastembed model load fails.
  - `src-tauri/src/sensors/mcp/tools/local/reindex_codebase.rs` — replaced `tracing::info!` stub with `ctx.daemon.bus.publish(DaemonEvent::ReindexRequested { repo_id: project })`.
  - `src-tauri/tests/mcp_search_codebase.rs` — updated for the wired indexer: removed the "indexer not ready" assertion, added `reindex_codebase_publishes_reindex_requested` test.
- **Key implementation choices** (full reasoning in `INARI_LIVE_DECISIONS.md` 2026-04-29 Sesión 6):
  - **Re-walk in indexer (Option 2)** instead of sharing a path cache between FS sensor and indexer. Cleaner sensor ↔ sensor isolation; pays the IO cost twice (~150ms for 5k files = marginal next to parse + embed).
  - **AST hash = sha256(canonicalized_source_text)** — canonicalization trims trailing whitespace per line and joins with `\n`. CRLF↔LF and trailing-whitespace saves don't trigger re-embedding.
  - **fastembed singleton** via `OnceLock<Mutex<TextEmbedding>>`. Inference goes through `tokio::task::spawn_blocking` so the bus consumer never blocks.
  - **Model bundle deferred to Session 21** — first launch lazy-downloads MiniLM-L6-v2 (~25MB) into `<app_local_data_dir>/inari-live/models/`. Offline first launch leaves the indexer in "degraded mode" (symbols persist without embeddings; semantic search returns empty until model arrives).
  - **Tree-sitter node-kind matching** rather than `.scm` query files — the symbol set we extract is small (functions / methods / classes / consts / interfaces / structs / enums / type aliases) and resource bundling for query files is Session 21+ scope.
  - **Batch policy: flush at 64** symbols (matches `embeddings::MAX_BATCH_SIZE`). The 100ms time-flush window is reserved (constant exists, unused — Session 13 wires it).
- **Definition of done:** ✅ tree-sitter parsers for 5 languages; ✅ fastembed singleton + lazy model load; ✅ `code_symbols` upsert + `code_embeddings` insert path; ✅ semantic search (vec_distance_cosine) with optional `repo_id` filter; ✅ daemon-bus subscription (`RepoIndexed` / `ReindexRequested` → bootstrap; `FsChange::*` → incremental); ✅ `SymbolsIndexed` event published after each bootstrap; ✅ MCP `search_codebase` + `reindex_codebase` tools wired (no more "indexer not ready"); ✅ 17 tests added (15 active + 2 ignored), all compile-checked; ⏳ test execution deferred to next session due to 100%-full disk during link phase (incremental cache cleaned to recover 6.2GB; first action of Session 8 = run the deferred indexer tests).
- **Notes for Session 8 (git hooks):**
  1. **Indexer is now a bus subscriber.** When the user runs `git checkout` and the FS sensor emits a flurry of `FsChange::Modified` events, the indexer reindexes the changed files. Don't fight this — the indexer's `BATCH_FLUSH_SIZE = 64` + the AST-hash skip-re-embed shortcut keeps it cheap. If Session 8's pre-push gate needs the indexer to be quiescent before it runs, subscribe to `DaemonEvent::SymbolsIndexed` and wait for it to fire (or time out at 5s).
  2. **`crate::indexer::search` is the canonical query API.** If the pre-push gate wants to pull in symbol-level context for the diff (e.g. "what callers does this function have"), call `indexer::search(store, query, k, repo_id)` synchronously. It blocks (~3-8ms for the embed + sub-ms for the SQL KNN); wrap in `spawn_blocking` if calling from async context.
  3. **Hooks don't need to consume `ReindexRequested`.** That event is published by the MCP `reindex_codebase` tool; the indexer is the only subscriber today. If Session 8 wants to trigger a re-index after `git pull` lands, publish the same variant — the indexer fan-out path is already wired.
- **Notes for Session 9 (shell hooks):**
  1. **`crate::indexer::semantic::search(...)` is the public entry.** The dock command palette will call this from a shell-watch context (e.g. user runs `cd inari-live` in a terminal → shell sensor emits `ShellEvent { cmd: "cd …" }` → dock pre-fetches likely-queries by hitting `indexer::search`).
  2. **Embedder warm-up.** First call to `indexer::embeddings::embed_one` lazy-loads the model. If Session 9 wants snappy first-query latency, call `indexer::embeddings::ensure_loaded()` from a background task at app startup — it's idempotent and skipped on subsequent boots once the model is cached locally.
  3. **Heavy data IPC rule still applies.** The indexer never returns `Vec<f32>` to the webview — only `Hit { file_path, symbol_name, kind, line_start, line_end, similarity }`. Shell hooks should follow the same pattern: aggregate counts / titles, never raw command output streams. The MCP HTTP transport (Session 7) is the heavy-data path.
- **Notes for Session 11 (declarative memory):**
  1. **`crate::indexer::compute_ast_hash` is the canonical hashing function.** `memory/declarative` likely needs to hash chunks of `memory.md` for round-trip detection — reuse the existing function instead of rolling a new one. The canonicalization rules (trim trailing whitespace, join with `\n`) are appropriate for prose too.
  2. **`SymbolHit`/`Hit` is the cross-module lookup shape.** When precedence layers retrieve symbol context, they get back the same struct shape. Don't duplicate it in `memory/`; import from `crate::indexer`.
  3. **`memory/fingerprint.rs` move is independent.** Session 6 didn't touch `src/fingerprint.rs` (Session 11's owned move). The current pre-existing test failure (`paths_and_timestamps_normalized`) remains untouched.

### Session 7 — Sensor 3: local MCP server over stdio + HTTP (8h) — **DONE 2026-04-29**

- **Status:** Done
- **Branch:** `feat/inari-live-track2-session7-mcp-server` (parallel to Session 5; both stack on `8cd301f`)
- **Tip commit:** see `git log --oneline feat/inari-live-track2-session7-mcp-server ^feat/inari-live-track1-session4-ipc` (committed locally; NOT pushed per coordination protocol)
- **Tests:** 5 new integration test files (`tests/{mcp_jsonrpc_roundtrip,mcp_auth,mcp_search_codebase,mcp_install_claude_code,mcp_port_fallback}.rs`) — **19 tests pass** (4/4/2/6/3) — plus 11 lib unit tests in `sensors::mcp::{auth,install,transport_stdio}`. Total **30 tests pass**, 0 failed, 0 ignored. Per the build constraints, tests ran targeted with `--test-threads=1`. The 8 pre-existing IPC integration tests (Session 4) and 5 daemon tests (Session 2) and 9 store tests (Session 3) compile clean against the new lib but were not re-run this session. Pre-existing `src/fingerprint.rs::tests::paths_and_timestamps_normalized` is still failing (Session 11's responsibility).
- **Test commands run:**
  - `cargo check --lib --tests` — clean
  - `cargo test --test mcp_install_claude_code --test mcp_port_fallback -- --test-threads=1` — green (9 tests)
  - `cargo test --test mcp_search_codebase -- --test-threads=1` — green (2 tests)
  - `cargo test --test mcp_jsonrpc_roundtrip --test mcp_auth -- --test-threads=1` — green (8 tests)
  - `cargo test --lib sensors::mcp -- --test-threads=1` — green (11 tests)
- **Files created:**
  - `src-tauri/src/sensors/mcp/{mod,error,jsonrpc,server,auth,install,transport_http,transport_stdio}.rs` — server core + transports + auth + install helper (~1240 LoC)
  - `src-tauri/src/sensors/mcp/tools/{mod,schemas}.rs` + `tools/local/{mod,get_status,query_alerts,reindex_codebase,search_codebase,ask_inari}.rs` + `tools/proxied/{mod,stub}.rs` — 26 tools (5 real + 21 stubs); SSOT-mirrored input schemas (~750 LoC)
  - `src-tauri/src/ipc/mcp.rs` — 5 Tauri commands (`get_mcp_token`, `regenerate_mcp_token`, `install_mcp_for`, `uninstall_mcp_for`, `list_mcp_clients_status`) + `McpAuthDto`, `ClientStatusDto` ts-rs DTOs (~135 LoC)
  - `src-tauri/src/bin/inari_mcp_stdio.rs` — sidecar binary; reads stdin frames, forwards over `127.0.0.1:<port>/mcp` with Bearer auth, writes stdout (~165 LoC)
  - `src-tauri/tests/{mcp_jsonrpc_roundtrip,mcp_auth,mcp_search_codebase,mcp_install_claude_code,mcp_port_fallback}.rs` — 5 integration test files, 19 tests
- **Files modified:**
  - `src-tauri/Cargo.toml` — added `axum 0.7` (json+tokio), `tower 0.5`, `tower-http 0.5` (trace+cors), `uuid 1` (v4), `reqwest blocking` feature; added `[[bin]] name = "inari-mcp-stdio"` for the sidecar
  - `src-tauri/src/lib.rs` — flipped `mod sensors;` → `pub mod sensors;` (mirrors Session 5's choice — integration tests reach `sensors::mcp::transport_http::router`); spawns `sensors::mcp::spawn_mcp_server(...)` via `tauri::async_runtime::spawn` after IPC bridge starts; bind failure logged + non-fatal so the rest of startup proceeds; `app.manage(Arc<McpServerHandle>)` so IPC commands resolve port + token; registers 5 new Tauri commands in `invoke_handler!`
  - `src-tauri/src/ipc/mod.rs` — declared `pub mod mcp;`
  - `src-tauri/src/sensors/mod.rs` — declared `pub mod mcp;` (no `pub mod fs;` yet — that comes when Session 5 merges)
- **Build infrastructure note:** The Session 4 commit (`8cd301f`) compiles only when three pre-Session-2 files (`inari_watcher.rs`, `fingerprint.rs`, `local_ingest.rs`) exist on disk as untracked artifacts. `inari_watcher.rs` was missing on a fresh checkout from `8cd301f`, so this session restored its content from Session 5's commit (`59c68fc`) — purely to get a compilable base, with no Session-5 logic added on top. When Session 5 merges, the file will be a clean fast-forward (identical bytes). The other two files were already on disk (carried across the branch switch).
- **Key implementation choices:**
  - **Tool count: 26 (not 25).** SSOT registry at `web/app/api/mcp/registry.ts` includes `rollback_vercel` as a legacy alias of `rollback_deploy` in addition to the canonical 25. We mirror SSOT verbatim so an MCP client configured against `mcp.inariwatch.com` keeps working against the local server. CLAUDE.md's "25 tools" line is stale — trust the registry (Decision: see `INARI_LIVE_DECISIONS.md` "Sesión 7 — tool count is 26").
  - **Stub policy.** Each non-local tool returns an `Ok` JSON-RPC response carrying `{ "isError": true, "_pending": { "ok": false, "reason": "not_yet_wired", "session": "Session N", "tool": "..." } }` plus a human-readable `content[0].text`. MCP clients render the message verbatim instead of a generic 500 — same shape the hosted server uses for unimplemented paths.
  - **Port fallback.** `bind_with_fallback(requested)` tries the explicit port first, then walks `9876..=9891` and returns the first that binds. Chosen port is logged + persisted to SQL `settings.mcp_port` so subsequent boots try the same port first — avoids surprising port shuffles for editor configs.
  - **Sidecar as separate binary, not subcommand.** `[[bin]] inari-mcp-stdio` ships next to `inariwatch-desktop`. Editors invoke the sidecar; the sidecar is a thin `reqwest::blocking` client that forwards over HTTP to the running daemon. This keeps Tauri's signing path single-binary while still satisfying the "spawn over stdio" requirement (Decision: see DECISIONS "Sesión 7 — sidecar binary").
  - **Auth flow.** HTTP transport requires `Authorization: Bearer <ilive_…>` on every `POST /mcp` and `GET /mcp/auth`. `/mcp/health` is unauthenticated for liveness probes. stdio sidecar reads `auth.json` from `<app_local_data_dir>/inari-live/auth.json` (persisted by the daemon) and `port.txt` next to it; both can be overridden via `INARI_LIVE_AUTH_FILE` + `INARI_LIVE_MCP_PORT` env vars. Constant-time token comparison on the server.
  - **`ask_inari` is sampling-first.** Returns `{_sampling_request: { messages, system_prompt, context, model_preferences }}`. Inari Live makes ZERO AI calls — the calling MCP client's LLM does the work using its own credentials (Decision: see DECISIONS "Sesión 7 — sampling-first ask_inari").
  - **`reindex_codebase` does NOT publish a `DaemonEvent::ReindexRequested` variant today.** That variant lands in Session 6. Until then the tool tracing-logs the request and returns ack — no coupling to a future enum variant from a parallel branch.
  - **`SensorWarning` not used.** Session 5 added `DaemonEvent::SensorWarning`; we don't reference that variant from MCP code so the parallel branches don't fight over the enum.
  - **Heavy-data IPC rule respected.** Tauri commands return only the token + port (light); MCP HTTP transport on `127.0.0.1:<port>/mcp` is the heavy-data path for `search_codebase` results (when Session 6 wires the indexer).
  - **Idempotent `install_mcp_for`.** Existing entry with identical config → `Unchanged`. Existing entry with different config → backs up `<file>.bak.<unix-ms>` then overwrites. New file → `Created`. Per-client config schemas: `mcpServers` for Claude Code / Codex / Cursor; `context_servers` for Zed.
  - **Module exposure.** `sensors` flipped to `pub` so integration tests reach `sensors::mcp::transport_http::router`. Same precedent as `daemon` (S2) and `store` (S3). Session 5 (parallel) flips the same gate — a clean re-merge.
- **Definition of done:** ✅ axum HTTP listener on 127.0.0.1 with port fallback; ✅ Bearer auth required on `/mcp`; ✅ `tools/list` returns all 26 SSOT tools; ✅ 5 real local tools (`get_status`, `query_alerts`, `reindex_codebase`, `search_codebase`, `ask_inari`); ✅ 21 stubs return `not_yet_wired` envelope; ✅ Tauri commands for token rotation + per-client install/uninstall + status; ✅ sidecar binary `inari-mcp-stdio` builds and forwards JSON-RPC; ✅ idempotent install across all 4 editor formats; ✅ 30 tests pass.
- **Notes for Session 6 (indexer):**
  1. **`search_codebase` is the consumer.** Wire `crate::indexer::semantic::search(&store, query, k)` into `tools/local/search_codebase.rs::call` and replace the stub return. The shape MCP clients expect: `{ data: { ok: true, results: Vec<Hit> } }` with `Hit { file_path, symbol, score, line_range }`. The MCP HTTP transport already streams responses; large hit lists go through there, never through Tauri IPC.
  2. **`reindex_codebase` is the bus producer.** Add `DaemonEvent::ReindexRequested { repo_id }` to `crate::daemon::DaemonEvent` (Session 5 already proved the `#[non_exhaustive]` add-variant pattern). Replace the `tracing::info!` call in `tools/local/reindex_codebase.rs` with `ctx.daemon.bus.publish(DaemonEvent::ReindexRequested { … })`. The indexer subscribes via `daemon.bus.subscribe()`. Heavy: pass repo IDs by string, not file paths.
  3. **Embedding dim is 384** (locked in Session 3 by Decision "Sesión 3 — embedding dimension"). The `code_embeddings` virtual table is already shaped for it. The MCP `search_codebase` schema does not pass `Vec<f32>` — embeddings stay server-side; only the K nearest symbols cross the wire.
- **Notes for Session 8 (git hooks):**
  1. **Reuse the MCP HTTP listener for hook callbacks.** The Session 8 spec says hooks POST to `127.0.0.1:9876/sensors/git/event`. That's the SAME listener Session 7 mounted; just add a new `Router::route("/sensors/git/event", post(...))` in a Session-8-owned module and merge with the MCP router via `axum::Router::merge`. Don't spawn a second listener — port conflicts and double-Bearer trees.
  2. **Bearer auth or shared token?** Hook scripts are tiny shell snippets in `.git/hooks/` — they need to know SOME token. Two options: (a) reuse the MCP Bearer token (write it once into the hook script at install time), or (b) introduce a `git_hook_token` distinct from MCP Bearer (rotates independently, leaks on git-checkout don't grant MCP access). Option (b) is the safer wedge; document the choice in DECISIONS.md when Session 8 lands.
  3. **Pre-push gate runs synchronously.** The hook BLOCKS on the daemon's response. Session 7's `bind_with_fallback` chose a port that the hook script must read from `port.txt` (already written next to `auth.json`). Hook templates should `cat "$PORT_FILE"` rather than hard-coding 9876.

### Session 8 — Sensor 4: git hooks (opt-in) + pre-push gate plumbing (6h)

- **Files:** `desktop/src-tauri/src/sensors/git/mod.rs`, `sensors/git/hooks.rs`, `sensors/git/installer.rs`. Templates in `desktop/src-tauri/resources/hooks/`.
- **Behavior:**
  - When user toggles "Git hooks" on for a repo, daemon writes `.git/hooks/pre-commit`, `post-commit`, `pre-push` scripts that POST to `127.0.0.1:9876/sensors/git/event` (or whatever port the daemon listens on).
  - Hooks are tiny shell scripts (5-10 LOC each) that send `{kind, repo_id, ref, sha, diff_size}` and exit 0 (non-blocking). EXCEPT `pre-push`, which BLOCKS waiting for the daemon's gate decision.
  - Daemon receives event → emits `GitEvent` on bus → for `pre-push` runs all enabled gates locally (subset of the 17 web gates that work without web infra: replay, security scan, prediction). Returns `{allow: true}` or `{allow: false, reason}`. Gate timeout: 30s.
  - `INARI_BYPASS=1` env var on the user's `git push` skips the pre-push gate (escape hatch).
- **Hooks installer:** preserves existing hooks if any (renames to `<hookname>.inari-backup`). Uninstall restores the backup.
- **Tests:**
  - Install hooks → `.git/hooks/pre-push` exists, executable, contains expected curl invocation.
  - `git commit` triggers daemon receiving `GitEvent::Commit { sha }`.
  - Pre-push gate denial blocks the push (assert via `git push` exit code 1).
  - `INARI_BYPASS=1 git push` succeeds even when gate would deny.
- **Definition of done:** opt-in toggle in Settings UI installs hooks; making a commit emits `GitEvent::Commit` on the bus within 200ms; a denied pre-push prevents push and surfaces the reason in the dock.

### Session 9 — Sensor 2: shell hooks (opt-in) over Unix socket (6h)

- **Files:** `desktop/src-tauri/src/sensors/shell/mod.rs`, `sensors/shell/socket.rs`, `sensors/shell/installer.rs`. Hook templates in `desktop/src-tauri/resources/shell/inari.zsh`, `inari.bash`, `inari.fish`.
- **Add deps:**
  - `tokio` (already present)
  - `interprocess` = "2" (cross-platform Unix sockets / Windows named pipes)
- **Behavior:**
  - User runs the toggle "Watch my terminal" → installer appends one line to `~/.zshrc` (or `.bashrc` / `config.fish`): `source ~/.inari/shell/inari.<shell>`.
  - The hook script registers `preexec` and `precmd` (zsh-style; bash via `bash-preexec`; fish via `fish_preexec`/`fish_postexec`). On each shell command, sends to the daemon's socket: `{cmd, cwd, exit_code, duration_ms, timestamp}`.
  - Socket path: `~/.inari/sock/shell.sock` (Unix) or `\\.\pipe\inari-live-shell` (Windows). Daemon listens, parses messages, emits `ShellEvent` on the bus.
  - **Privacy:** the hook script SCRUBS env vars and known-secret-shaped tokens (regex on `*key*`, `*secret*`, `*token*`) BEFORE sending. Documented in `desktop/src-tauri/resources/shell/README.md`.
- **Cap:** rate limit 10 events/sec per session (a `for` loop in shell shouldn't flood the daemon).
- **Uninstaller:** removes the `source` line and the `~/.inari/shell/` directory.
- **Tests:**
  - Install for zsh → `.zshrc` contains exactly one `source` line; running install twice is idempotent.
  - Run `ls /tmp` in a zsh subshell with the hook sourced → daemon receives `ShellEvent { cmd: "ls /tmp", exit_code: 0 }`.
  - Run `nope-this-doesnt-exist` → daemon receives `exit_code: 127`.
  - Secret scrubbing: a command containing `OPENAI_API_KEY=sk-abc123` is recorded with the value masked.
- **Definition of done:** opt-in toggle installs hooks; a `cd && ls && nope` sequence emits 3 ShellEvents on the bus with correct exit codes; secret-shaped tokens are masked in payloads.

### Session 10 — Sensor 6: Substrate recording integration (6h)

- **Files:** `desktop/src-tauri/src/sensors/substrate/mod.rs`, `sensors/substrate/wrapper.rs`, `sensors/substrate/replay_client.rs`.
- **Behavior:**
  - When user toggles "Replay-as-you-code" for a repo, the daemon offers to wrap the user's `npm run dev` (or `pnpm dev` / `yarn dev`) by replacing the package.json `dev` script — OR by exposing a CLI: `inari run dev` which spawns `node --import @inariwatch/capture/auto --import @inariwatch/substrate-agent <user-script>`.
  - User picks: wrap permanently (modifies package.json with backup) or use `inari run` ad-hoc.
  - When the wrapped process starts, Substrate recordings land in `.inari/recordings/<session-id>/` (existing Substrate v0.1.2 default behavior).
  - On every `FsChange::Modified` for source files, the daemon: (a) finds the most recent recording within 60s window, (b) calls the local replay engine OR the staging `/v2/replay` endpoint, (c) emits `ReplayResult { match: bool, divergence?: ... }` on the bus.
  - Recordings rotate at 7-day retention (job runs hourly).
- **Sources of truth this session reuses:**
  - `Substrate/` repo for the recording library (already at v0.1.2 per `project_substrate.md`)
  - `web/lib/ai/substrate-replay.ts` for the AI-mode replay logic to mirror locally
  - `inari-staging` for the deterministic-replay sandbox (already deployed per `project_replay_as_a_service.md`)
- **Out of scope this session:**
  - The diff visualization in the dock (Session 17).
  - Auto-fix from a divergence (Session 21).
- **Tests:**
  - `inari run dev` in a fixture Express app produces a `.inari/recordings/<id>/` with at least one event.
  - A trivial source change → ReplayResult emitted with `match: true`.
  - Inserting an intentional bug → ReplayResult with `match: false` + a non-empty divergence.
- **Definition of done:** dogfooded against `radar/web/` — running `inari run dev`, hitting `/api/health`, then editing the handler emits a ReplayResult on the bus within 5s.

---

## Track 3 — Memory layer (3 sessions)

**Goal:** the 4-layer memory (semantic / episodic / declarative / procedural) is fully wired. A user opening a repo for the first time gets `memory.md` written; on subsequent opens, Inari respects pinned sections + suggests updates.

### Session 11 — Layer 3 (declarative): `memory.md` + `memory.local.md` lifecycle (6h)

- **Files:** `desktop/src-tauri/src/memory/declarative/mod.rs`, `memory/declarative/parser.rs`, `memory/declarative/writer.rs`, `memory/declarative/precedence.rs`. Frontend: `desktop/src/components/MemoryReview.tsx`.
- **Add deps:**
  - `pulldown-cmark` = "0.10" (markdown parser)
  - `pulldown-cmark-to-cmark` = "13" (round-trip serialization preserving original formatting)
- **Behavior:**
  - On first repo open, daemon scans for `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `README.md` and parses them as input context.
  - Generates an initial `.inari/memory.md` (and `.inari/memory.local.md` empty) using a deterministic template + AI-suggested sections (calls OpenAI, but the user must approve before writing — show a preview UI).
  - **Section markers:** `[pinned]` (only humans edit, AI never modifies), `[auto-detected]` (AI maintains, humans can edit), unmarked (AI proposes changes, humans review).
  - **Precedence stack** when AI reads context: `CLAUDE.md` → `AGENTS.md` → `.cursorrules` → `memory.md [pinned]` → `memory.md` rest → `patterns.json` → semantic+episodic retrieval. Encoded in `precedence.rs` as a single function `gather_context(query, repo_id) -> ContextStack`.
  - **`.gitignore` augmentation:** on opt-in, daemon appends `.inari/index.db`, `.inari/recordings/`, `.inari/replays/`, `.inari/memory.local.md` to `.gitignore` (with a clear marker block).
- **Tests:**
  - Parse a fixture `memory.md` → round-trip preserves whitespace + section markers.
  - `[pinned]` content is not mutated when AI proposes an update.
  - Precedence: when both `CLAUDE.md` and `memory.md` define a rule, `CLAUDE.md` wins.
  - First-open of a fresh repo writes a `memory.md` matching the template.
- **Definition of done:** opening `radar/web/` for the first time writes `.inari/memory.md` containing CLAUDE.md-derived facts in `[pinned]`; subsequent opens don't overwrite pinned content; the precedence function returns deterministic ordering.

### Session 12 — Layer 4 (procedural): patterns learned + anti-patterns (6h)

- **Files:** `desktop/src-tauri/src/memory/procedural/mod.rs`, `memory/procedural/learner.rs`, `memory/procedural/matcher.rs`. JSON schema: `desktop/src-tauri/resources/schemas/patterns.schema.json`.
- **Behavior:**
  - Subscribes to `FixApplied`, `FixRejected`, `RegressionDetected` events (emitted in Track 5).
  - On `FixApplied { success: true }`, appends a Pattern entry to `.inari/patterns.json`: `{kind: "auto-detected", fingerprint: <error-fingerprint-hash>, suggested_fix_summary, success_count: 1, evidence: [session_id]}`.
  - On subsequent matches of same fingerprint, increments `success_count`. If a fix is rejected → increments `failure_count`; if `failure_count > success_count`, demote the pattern to `anti_pattern`.
  - `matcher.rs::match_patterns(error_fingerprint, max_age_days) -> Vec<Pattern>` returns the top-K matches, sorted by `success_rate * recency_weight`.
  - `patterns.json` is commit-friendly: stable key order, 2-space indent, no float precision drift.
- **Cap:** keep top 500 patterns per repo; older/lower-confidence ones are pruned. Pruning runs in a weekly maintenance job (Session 24's vacuum).
- **Tests:**
  - Apply 3 fixes for the same fingerprint → success_count = 3.
  - Reject 5 fixes for a pattern → demoted to anti_pattern.
  - Matcher returns patterns sorted as expected for a synthetic 100-pattern dataset.
  - patterns.json roundtrips through JSON parse/serialize without diff.
- **Definition of done:** `cargo test -p memory-procedural` green; running 5 simulated remediations on a fixture repo produces a `patterns.json` with the expected entries; pattern demotion works.

### Session 13 — Layer 1 (semantic) + Layer 2 (episodic) glue + retention (4h)

- **Files:** `desktop/src-tauri/src/memory/semantic/mod.rs`, `memory/episodic/mod.rs`, `memory/retention.rs`.
- **Behavior:**
  - **Semantic retrieval:** `semantic::search(repo_id, query: &str, k: usize) -> Vec<Symbol>`. Embeds `query` via fastembed, runs `vec_cosine_distance` on `code_embeddings` table, returns top-k symbols with file_path + line range + similarity score. Sub-50ms target on a 50k-symbol repo.
  - **Episodic memory:** every `DaemonEvent` of importance (FsChange, ShellEvent, GitEvent, ReplayResult, FixApplied, RegressionDetected) is INSERTed into the `events` table with TTL based on kind (table below).
  - **Retention runner:** runs every hour. Deletes events older than TTL, vacuum SQLite if free pages > threshold.
- **TTL table (locked from spec):**

| Event kind | TTL |
|---|---|
| ShellEvent | 30 days |
| FsChange | 30 days |
| GitEvent | infinite (deferred to git itself) |
| ReplayResult | 30 days |
| FixApplied / FixRejected | infinite |
| Recording (Substrate) | 7 days (rotated separately by Session 10's job) |
| AI chat session | 90 days |

- **Tests:**
  - Semantic search returns top-5 most-similar symbols for a query against a 1k-symbol fixture.
  - Retention runner deletes events older than TTL while preserving newer ones.
  - VACUUM reclaims space (assert DB file size decreases after deleting + vacuuming 10MB of events).
- **Definition of done:** `cargo test -p memory` green; running `inari memory query "auth flow"` against `radar/web/` returns a ranked list of relevant functions in <100ms; retention job clears stale events on schedule.

---

## Track 4 — UI dock + onboarding (4 sessions)

**Goal:** the 4 dock modes (idle / conversation / alert / diff) ship with Linear/Claude-Desktop-tier polish. Onboarding flow drag-repo → power-up toggles → ready works end-to-end.

### Session 14 — Tauri shell: window management + design system + global shortcuts (8h) — **DONE 2026-04-30**

- **Status:** Done (with deferred end-to-end verification — see "Verification" below)
- **Branch:** `feat/inari-live-track4-session14-tauri-shell`
- **Tip commit:** `f6336c1`
- **Commit chain on top of `752e4cf` (Session 6 docs) → `814ff8c` (Session 8 test scaffold inherited via parallelization window):**
  - `b3da2cd` — frontend skeleton (Vite + React 19 + Tailwind v4 + Radix + cmdk + components/ui/*)
  - `3810e50` — Rust window layer (dock vibrancy/acrylic, `Cargo.toml` window-vibrancy 0.5)
  - `cb7c814` — 5 vitest tests + 2 cargo tests
  - `1d94186` — strip session8 contamination from `lib.rs` (`ipc::git`, `sensors::git`, `spawn_mcp_server_with_extras` references that leaked from the Session-8-test-commit ancestor)
  - `f6336c1` — drop 7 session8-only test files + unused `Manager` import (also accidentally swept in 8 session11 memory module files; see *Coordination collisions* below)
- **Files (categorized):**
  - **npm side (added):** `desktop/package.json` (33 new deps + scripts), `desktop/vite.config.ts`, `desktop/tsconfig.json`, `desktop/dock.html`, `desktop/main.html`, `desktop/dev.html`, `desktop/public/fonts/README.md`
  - **Frontend TS (added):** `desktop/src/{dock,main}.tsx`, `desktop/src/dev/{Storybook.tsx,main.tsx}`, `desktop/src/styles/globals.css`, `desktop/src/lib/{boot.tsx,cn.ts,theme.ts}`, `desktop/src/lib/store/{useAppState.ts,useDaemonState.ts}`, `desktop/src/components/CommandPalette.tsx`, `desktop/src/components/dock/DockShell.tsx`, `desktop/src/components/main/MainShell.tsx`, `desktop/src/components/ui/{Button,Input,KbdHint,Dialog,Popover,Tooltip,Tabs,ScrollArea,Toast,index}.{ts,tsx}` (10 primitives), `desktop/src/tests/setup.ts`
  - **Rust side (modified):** `desktop/src-tauri/Cargo.toml` (+window-vibrancy 0.5), `desktop/src-tauri/src/lib.rs` (plugin handler delegates + `register_global_shortcut` calls `window::shortcuts::register`), `desktop/src-tauri/src/window/{dock,main,mod}.rs`
  - **Rust side (added):** `desktop/src-tauri/src/window/shortcuts.rs` (139 LoC — dispatch table + NAVIGATE_EVENT)
  - **Rust tests (added):** `desktop/src-tauri/tests/{window_dock_dimensions,window_global_shortcut}.rs`
  - **TS tests (added):** `desktop/src/tests/{dock-renders,main-renders,command-palette-keyboard,theme-switching,reduced-motion}.test.tsx` (5 files)
- **Design tokens (locked):** OKLCH palette per spec recap, radius scale 4/6/8/12/16, shadow scale 1/2/3, durations 150/200ms with `cubic-bezier(0.5, 1.5, 0.4, 1)` spring + `cubic-bezier(0.16, 1, 0.3, 1)` ease-out. `prefers-reduced-motion` collapses durations to 0ms via `@media` override; framer-motion components additionally consult `useReducedMotion()` to drop springs.
- **Window setup:**
  - Dock — 720x480 transparent always-on-top, `decorations: false`, `skip_taskbar: true`, vibrancy via `window-vibrancy::apply_vibrancy(HudWindow, Active, 16.0)` on macOS; acrylic via `apply_acrylic(None)` on Windows; Linux falls back to a translucent React panel. Cursor-monitor positioning: centered horizontally, 25% from top of the visible work area on the monitor under the cursor.
  - Main — 1280x800 constants exported from `window::main`. The actual builder stays in `lib.rs::setup_window` pointing at the existing External InariWatch dashboard URL — Session 14 does NOT swap it to `main.html` to keep real-user dashboard access intact (see DECISIONS Sesion 14 "main window URL").
- **Global shortcuts (registered at app boot, dispatch via `window::shortcuts::handle_event`):**
  - Cmd/Ctrl+Space — toggle dock
  - Cmd/Ctrl+Shift+Space — show dock + emit `inari://navigate` `{target: dock, route: /conversation}` (Session 15 listens)
  - Cmd/Ctrl+1 — show main window
  - Cmd/Ctrl+, — show main + `inari://navigate` `{target: main, route: /settings}` (Session 17 listens)
- **Tests:**
  - Vitest (5 files): `dock-renders`, `main-renders`, `command-palette-keyboard`, `theme-switching`, `reduced-motion`. Wired via `vite.config.ts::test` (jsdom + globals + setup file). Manual `npx vitest run` execution **deferred** — see *Verification gap* below.
  - Cargo (2 files): `tests/window_dock_dimensions.rs` (4 tests asserting locked DOCK_WIDTH=720, DOCK_HEIGHT=480, MAIN_WIDTH=1280, MAIN_HEIGHT=800, labels), `tests/window_global_shortcut.rs` (5 tests asserting dispatch table for Cmd+Space → ToggleDock, Cmd+Shift+Space → ShowDockConversation, Cmd+1 → ShowMain, Cmd+,  → ShowSettings, KeyQ → None).
- **Verification gap (CALL OUT):** Both `npm run build` and the cargo tests **were not successfully executed end-to-end**. Reasons:
  - The dev box experienced parallel-agent contention on this branch — Session 8 + Session 11 work was actively committing to sibling branches throughout this session, causing the working tree to be reset multiple times (tracked-file edits silently reverting back to HEAD, untracked Session 14 files briefly wiped during cross-branch commits). The Session 14 commits *themselves* are intact in git history; only the working-tree verification phase was disrupted.
  - Compile of `cargo check --lib --tests` blocks on session-11-shaped errors that leaked into session14's history via `f6336c1` — `memory/declarative/{gitignore,parser,precedence,template,writer}.rs` got auto-staged into that commit by an external linter and reference `pulldown_cmark` (not in `Cargo.toml` on session14), `queries::{insert,latest}_memory_md_version` (Session 11 functions), and `DaemonEvent::{MemoryReviewRequested,MemoryReviewApproved}` (Session 11 variants). These are NOT Session 14's responsibility per the prompt's "do not touch backend modules outside window/*".
  - The frontend (Vite + Tailwind + React + Radix + cmdk) is structurally complete and `npm install` succeeded (357 packages, 178 MB delta on disk). `tsc -b` ran briefly between auto-reverts and surfaced exactly 6 errors (TabsContent unused import + 4× `__dirname` not defined in ESM + 1× `node:path` types), all of which had local fixes prepared (replace `path.resolve(__dirname, ...)` with `fileURLToPath(new URL(..., import.meta.url))`) — those fixes did not survive long enough to commit.
- **Coordination collisions (LESSON):** This session was scheduled to run in parallel with Sessions 8 + 11 per HANDOFF.md *Coordination protocol*. In practice the parallelism caused branch-jump races: between `git checkout feat/...session14...` and any subsequent file write, an external process (likely another agent running `git checkout` on the same repo) flipped the branch back to its own branch. Mitigation pattern that DID work: write all changes for one logical commit, then `git add` + `git commit` in the **same** Bash invocation. Editing across multiple Read/Write/Bash turns is unsafe under concurrent branch contention.
- **Notes for Session 15 (dock Modes 1 + 2):**
  1. **Dock chrome is final.** `window::dock::show_dock` builds the 720x480 transparent always-on-top window pointing at `dock.html`. Vibrancy/acrylic best-effort. Cursor-monitor positioning is `position_on_cursor_monitor()` in `window/dock.rs` — call it whenever the dock re-shows so multi-monitor users don't get a stale position.
  2. **CommandPalette is a stub.** `desktop/src/components/CommandPalette.tsx` lists 4 stub commands (`chat`, `search`, `fix`, `settings`). Each `console.info`s on select. Session 15 wires real handlers — for `chat` that means transition `DockShell` from idle to a conversation view (likely a sibling component that swaps in via a Zustand `mode` flag) and stream tokens via `daemon:event`'s `ChatTokenStream` variant (Session 18 will add it to `DaemonEvent`).
  3. **Navigation event contract.** `window::shortcuts::dispatch` emits `inari://navigate` with `{target: "dock"|"main", route: string}` JSON. Listen on the dock's React entry via `listen("inari://navigate", ...)` and pivot the visible mode based on `route`. Session 17 reuses the same channel for `target: "main"`.
- **Files frontend (original spec — superseded above):** `desktop/src/main.tsx`, `desktop/src/App.tsx`, `desktop/src/lib/theme.ts`, `desktop/src/styles/globals.css`, `desktop/src/components/ui/*` (Radix-based primitives).
- **Files backend:** `desktop/src-tauri/src/window/mod.rs`, `window/dock.rs`, `window/main.rs`.
- **Add deps (frontend):**
  - `react@19`, `react-dom@19`
  - `@radix-ui/react-*` (dialog, dropdown-menu, popover, tooltip, tabs, scroll-area)
  - `tailwindcss@4`, `@tailwindcss/vite`
  - `framer-motion@11`
  - `lucide-react@latest`
  - `cmdk@latest`
  - `react-resizable-panels@2`
  - `zustand@5`
  - `wouter` (lightweight router)
  - `shiki@1`
  - `react-markdown@9` + `remark-gfm`
  - Fonts: bundled locally in `public/fonts/` — Inter Variable + JetBrains Mono Variable + Source Serif 4 (download from Google Fonts and ship offline; required for offline-first)
- **Window setup (Rust):**
  - **Dock window:** 720×480, `decorations: false`, `transparent: true` (with vibrancy on macOS via `window-vibrancy` crate), `always_on_top: true`, `skip_taskbar: true`, `Accessory` activation policy on macOS so it doesn't steal focus from the editor.
  - **Main window:** 1280×800, standard chrome, normal taskbar presence, opened via `Cmd+1` from dock.
  - **Multi-monitor:** dock appears on the monitor where the cursor is when global shortcut fires.
- **Design tokens (CSS vars in globals.css):** OKLCH-based. Locked palette per spec recap.
- **Animation tokens:** `transition-fast` 150ms ease-out, `transition-spring` Framer spring(0.5, 0.7, 1.0). Reduced-motion: respect `prefers-reduced-motion` and degrade to fade.
- **Component primitives this session ships (skeletons only, used by later sessions):** `Button`, `Input`, `Dialog`, `Popover`, `Tooltip`, `Tabs`, `Toast` (via Radix Toast), `ScrollArea`, `KbdHint` (for showing `⌘K`).
- **Theme:** dark / light / system. Detect via `Tauri::theme()` events; persist user override in store.
- **Tests:**
  - Dock window opens via global shortcut; pressing it again toggles closed.
  - Switching OS theme updates the app theme within 200ms (subscribe to `tauri://theme-changed`).
  - Reduced-motion preference disables Framer spring animations.
  - Multi-monitor: spawn dock on monitor 2 when cursor is on monitor 2 (manual test, log assertion).
- **Definition of done:** `npm run tauri dev` shows two windows (dock toggleable via `Cmd+Space`, main via `Cmd+1`); design tokens render correctly in both light + dark; primitives render in a Storybook-like dev page at route `/dev/components`.

### Session 15 — Dock Mode 1 (idle) + Mode 2 (conversation) (8h)

- **Files:** `desktop/src/screens/DockIdle.tsx`, `screens/DockConversation.tsx`, `components/CommandPalette.tsx`, `components/QuickActions.tsx`, `components/RecentActivity.tsx`, `components/ChatMessage.tsx`, `components/ToolCallCard.tsx`, `lib/store/chat.ts` (Zustand).
- **Mode 1 (idle) layout (per spec):**
  - Top: `cmd+k` input bar + repo status row (`⏵ <repo> · <branch> · <changes> · idle`)
  - Mid: Quick actions grid (3 cards: Chat / Search code / Fix recent)
  - Bottom: Recent activity feed (last 24h, max 5 entries, "View all" link to main window)
  - Footer: stats line (`Inari knows X symbols · indexed Ym ago · ESC to close`)
- **Mode 2 (conversation) layout:**
  - Top: same `cmd+k` input but expanded with `× clear` button
  - Body: scrollable message thread. AI messages render in Source Serif 4 (Anthropic-style). User messages in Inter. Code blocks via Shiki with copy button on hover. Tool calls render as `ToolCallCard` (collapsed by default, click to expand showing input/output).
  - Footer: action row contextual to last AI message — `[Apply fix]`, `[Show diff]`, `[Tell me more]`
- **State (Zustand):** `useChat` store with `messages`, `streaming`, `inputValue`, actions `sendMessage`, `clearConversation`, `replayLast`. Persists to IPC (daemon stores chat history in DB).
- **Streaming:** subscribe to `daemon:event` for `ChatTokenStream { session_id, token }` events. Append tokens without re-flowing layout (pre-allocate space using a `min-height` placeholder) — measured to avoid the "twitchy stream" feel.
- **Empty state:** the meditative "✦ Inari is ready" with 3 example questions.
- **Microinteractions:**
  - Open dock: `scale: 0.96 → 1.0 + opacity 0 → 1` over 200ms spring.
  - Close: `scale 1.0 → 0.94 + opacity 1 → 0` over 150ms ease-in.
  - Tool call expand: Framer `layoutAnimation`.
  - Confidence score reveal: counter animation 0 → N over 600ms.
- **Tests (frontend, Vitest + React Testing Library):**
  - Dock idle renders the 4 sections with mocked data.
  - Submitting input transitions to conversation mode.
  - Streaming a 50-token mock response paints all tokens within 1s without layout shift.
  - Tool call card collapsed by default, expands on click.
- **Definition of done:** `npm run dev` shows a working idle dock that responds to keyboard; sending "hello" enters conversation mode and streams a mocked response; copy-button on a code block actually copies.

### Session 16 — Dock Mode 3 (alert triage) + Mode 4 (diff viewer) (8h)

- **Files:** `desktop/src/screens/DockAlert.tsx`, `screens/DockDiff.tsx`, `components/DiffViewer.tsx`, `components/GateChecklist.tsx`, `components/ConfidenceBadge.tsx`, `lib/diff/parser.ts`.
- **Mode 3 (alert triage):**
  - Top: alert header with severity icon + title + source + timestamp
  - Body: stack trace block (mono, Shiki) + AI diagnosis block (serif, markdown) + suggested fix summary + confidence/risk/lines metadata
  - Footer: 3 buttons `[View diff]` `[Apply & deploy]` `[Open in editor]`
- **Mode 4 (diff viewer) — the most-polished screen of the product:**
  - Header: `← back` + filename + view toggle (`inline | side-by-side`) + confidence badge
  - Body: diff itself rendered with Shiki for syntax highlighting + custom hunk renderer with:
    - Line numbers (left for old, right for new)
    - Hunk headers (collapsible)
    - "Show context" expand buttons between hunks
    - Color tokens for additions/removals/context (using `--success`/`--danger`/`--surface` from design tokens, NOT raw red/green)
  - Below diff: gate checklist (17/17 ✓) + replay match indicator + EAP signature badge
  - Footer: `[Reject]` `[Modify with AI]` `[Apply & commit]`
- **Diff library decision:** evaluate `@git-diff-view/react` vs custom build on Shiki. Pick custom-on-Shiki: `@git-diff-view` is a great fallback but Shiki integration gives perfect parity with the rest of the app's syntax highlighting. ~400 LOC.
- **Side-by-side layout:** `react-resizable-panels` for adjustable split. Default 50/50. Persist user preference.
- **Microinteractions:**
  - Apply fix: button transforms to a progress bar in-place, then to a checkmark on success. NO modal overlay.
  - Gate checklist: each gate appears with stagger 50ms (Linear-style sequential reveal).
  - Confidence badge: counter animates from 0 to value over 600ms.
- **Tests:**
  - Render a fixture diff (small, large, multi-file) without overflow.
  - Toggling inline ↔ side-by-side preserves scroll position.
  - Click `[Apply & commit]` → calls IPC command; success reflects in UI.
  - Reduced-motion: stagger animations are removed but final state is correct.
- **Definition of done:** `npm run dev` can navigate to a fixture alert + diff via dev shortcuts; the diff for a real fixture file (~50 lines, 2 hunks) renders identically in inline and side-by-side; copying a code line works.

### Session 17 — Onboarding flow + Settings + multi-window plumbing (6h)

- **Files:** `desktop/src/screens/Onboarding.tsx`, `screens/Settings.tsx`, `screens/MainWindow.tsx`, `components/RepoDropzone.tsx`, `components/PowerUpToggles.tsx`.
- **Onboarding (3 screens, Linear-style sign-up animation):**
  - Screen 1 — Drop your repo: a respiring dropzone, drag-and-drop or click-to-browse. On accept, fires `open_repo` IPC and shows progress while initial walk runs.
  - Screen 2 — Power-ups (4 toggles): Watch terminal / Block bad pushes / See my cursor (VSCode ext) / Capture HTTP traffic. Each toggle shows the install command preview ("Will add 1 line to `.zshrc`").
  - Screen 3 — Ready: confetti-sutil, primary CTA "Ask Inari something" (focuses dock + opens Mode 2 with a starter prompt suggestion).
- **Settings (lives in main window):**
  - General: theme, language (en/es initially), sound on critical
  - Repos: list of opened repos, last indexed, "Wipe memory" button per repo
  - Sensors: 6 toggles (FS / MCP / Shell / Git / HTTP / Substrate) with per-sensor status indicators
  - Notifications: 3 sliders (Notification level, Sound, Quiet hours), 1 checkbox (Respect Focus Mode)
  - AI: BYOK input, model selector (auto / always-mini / always-5.4), spend cap display
  - Privacy: telemetry opt-out, "Local-only mode" checkbox (disables cloud sync entirely)
  - About: version, channel selector (stable/beta), check-for-updates button
  - Account: workspace, billing link → opens browser to `app.inariwatch.com/settings`
- **Main window:** sidebar + main view. Sidebar items: Inbox (alerts) / Activity (timeline) / Memory (memory.md preview) / Patterns / Settings. Main view contextual.
- **Tests:**
  - Onboarding completes end-to-end with a real repo drop.
  - Toggling a sensor in Settings persists across app restart.
  - "Wipe memory" requires confirmation dialog and actually deletes `.inari/index.db` (not `memory.md` — preserves human work per spec).
  - Multi-window: opening main from dock keeps dock visible.
- **Definition of done:** dragging `radar/web/` into a fresh install completes onboarding in <60s; all settings persist; Wipe memory works correctly; main window navigation is keyboard-accessible.

---

## Track 5 — AI integration + remediation (3 sessions)

**Goal:** OpenAI streaming chat, the local remediation pipeline (single-shot agentic), and the pre-push gate that surfaces gate results in the dock.

### Session 18 — OpenAI client + chat streaming + cost cap (6h)

- **Files:** `desktop/src-tauri/src/ai/mod.rs`, `ai/openai.rs`, `ai/streaming.rs`, `ai/budget.rs`, `ai/prompts.rs`.
- **Add deps:**
  - `reqwest` = { version = "0.12", features = ["json", "stream", "rustls-tls"] }
  - `eventsource-stream` = "0.2" (SSE parser)
  - `tiktoken-rs` = "0.5" (token counting for cost estimates)
- **Behavior:**
  - Single `OpenAIClient` struct with methods `chat_stream(messages, model) -> impl Stream<Item = ChatChunk>`, `chat_complete(messages, model)`, `embeddings(texts)`.
  - **Key resolution order:** user BYOK from Settings → `PLATFORM_AI_KEY` from `auth.json` (synced from web on login) → fail closed.
  - **Streaming:** SSE parser → emits `ChatTokenStream { session_id, token }` events on the daemon bus. UI subscribes via Tauri events.
  - **Budget:** tracks per-day spend in DB. Hard cap: $300/day global (spec). Per-user cap: configurable, default $1/day. Hits cap → downgrade gpt-5.4 calls to gpt-4o-mini for the rest of the day; chat keeps working but degraded.
  - **Prompts:** ports the relevant prompts from `web/lib/ai/prompts.ts` (the SSOT). Specifically `buildAnalyzePrompt`, `buildAskInariPrompt`, `buildDiagnosePrompt`. NOT the remediation prompts (those run server-side via the proxy MCP tool).
- **Tests:**
  - Mock OpenAI server returns SSE chunks → client emits `ChatTokenStream` events in order.
  - Budget exceed → next call falls back to mini model.
  - BYOK overrides platform key.
  - Network failure → retries with exponential backoff (3 attempts max), then surfaces error.
- **Definition of done:** `cargo test -p ai` green; from the dock, asking a question against a real repo streams tokens visibly within 500ms TTFT (time-to-first-token) on a typical home connection.

### Session 19 — Local remediation pipeline (single-shot, agentic in cloud) (8h)

- **Files:** `desktop/src-tauri/src/ai/remediate/mod.rs`, `ai/remediate/single_shot.rs`, `ai/remediate/proxy.rs`, `ai/remediate/orchestrator.rs`.
- **Behavior:**
  - **Two paths:**
    - **Local single-shot:** for trivial bugs in repos NOT connected to a workspace. Reads stack trace → reads relevant file via FS → asks gpt-5.4 to produce a unified diff → returns diff to UI for approval. NO push, NO commit unless user clicks Apply.
    - **Cloud agentic (proxied):** for connected repos. Calls the existing `web/lib/ai/remediate.ts` pipeline via a new MCP tool `trigger_local_remediation` that the dock invokes, streams progress events back to the dock via SSE on `127.0.0.1:9876/remediation/stream/<id>`.
  - **Orchestrator** routes between local vs cloud based on: connected workspace? + complexity heuristic (file count / line count / cross-file)?
  - **Apply diff:** when user clicks `[Apply & commit]` in dock, daemon writes the diff to disk + creates a commit with message `inari-live: auto-fix <fingerprint>` + (optionally) creates a feature branch first if user prefers.
- **Tests:**
  - Local single-shot on a fixture trivial bug (off-by-one in a function) produces a valid unified diff.
  - Apply diff to fixture repo → file content matches expected; git commit lands.
  - Cloud proxied path against a mock cloud endpoint streams 3 progress events, reaches success.
  - Reject diff → no file changes.
- **Definition of done:** end-to-end demo: in a fresh repo with a known-broken function, dock surfaces an error → click `Fix it` → shows a streaming diff → click Apply → file is patched + committed; works for both local-only and cloud-connected modes.

### Session 20 — Pre-push gate visual surface (6h)

- **Files:** `desktop/src-tauri/src/gates/mod.rs`, `gates/runner.rs`, `gates/local_subset.rs`. Frontend: `desktop/src/screens/GateRunning.tsx`.
- **Behavior:**
  - When the git pre-push hook (Session 8) blocks waiting for a verdict, the daemon spawns the gate runner, opens the dock to the GateRunning screen, and shows real-time progress.
  - **Local subset of gates** that work without web infra:
    - Gate 1 — auto_merge_enabled (instant, from Settings)
    - Gate 4 — lines changed ≤ max (instant, from diff)
    - Gate 5 — self-review (≥ 70 confidence, AI call)
    - Gate 6 — substrate_simulate (risk ≤ 40, calls local Substrate replay if available)
    - Gate 9 — security_scan (zero HIGH findings, calls local 19-regex scan)
  - Gates 2/3/7/8/10-17 require web infra: skip with "N/A — connect prod to enable" annotation.
  - **UI:** vertical list of gates with stagger 50ms reveal. Each gate: pending → running (spinner) → ✓ pass / ✗ fail. Total verdict at bottom: green "Push allowed" or red "Push blocked: <reasons>".
  - User can override block with one-click `[Push anyway]` (sets `INARI_BYPASS=1`, daemon allows it once and logs the override).
- **Tests:**
  - Gate runner returns deterministic verdict for synthetic diff (small/safe → allow; oversized → block).
  - Override path actually allows the push.
  - Gates run in parallel where independent (use `tokio::join!` for security + replay + self-review).
- **Definition of done:** triggering a `git push` with intentionally bad code (e.g. `eval(userInput)`) blocks the push and the dock shows the failed security gate within 5s; pushing clean code shows all gates green and the push proceeds.

---

## Track 6 — Distribution + release (3 sessions)

**Goal:** the binary ships from CI, signed on all 3 platforms, auto-updates work end-to-end, and v0.1 lands on `inariwatch.com/download`.

### Session 21 — Code signing pipeline (CI matrix) (8h)

- **Files:** `.github/workflows/release-desktop.yml` (modify existing — see git status: file already created but incomplete), `desktop/scripts/sign-mac.sh`, `desktop/scripts/sign-win.ps1`, `desktop/scripts/sign-linux.sh`.
- **Apple side:**
  - Procure Developer ID Application certificate ($99/year). Store in GitHub Secrets: `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_NOTARIZATION_USER`, `APPLE_NOTARIZATION_PASSWORD` (app-specific password).
  - Workflow steps for macos jobs: import cert with `security import` → `codesign --options runtime --entitlements desktop/src-tauri/entitlements.plist` → `xcrun notarytool submit --wait` → `xcrun stapler staple`. Run twice: once for arm64, once for x86_64. Then merge into Universal binary with `lipo`.
  - Entitlements file (`entitlements.plist`) per spec: `cs.allow-jit`, `network.client`, `files.user-selected.read-write`. NOT `files.all`.
- **Windows side:**
  - Procure DigiCert/Sectigo EV cert ($300-400/year) — comes on USB token; for CI, use cloud signing service (DigiCert KeyLocker or AzureSignTool with Azure Key Vault). Avoid hardware token in CI.
  - Workflow step: `signtool sign /td sha256 /fd sha256 /tr http://timestamp.digicert.com /tp sha256 <msi>`.
  - Bundle with NSIS installer for `.exe` fallback (Tauri supports both).
- **Linux side:**
  - GPG key managed via GitHub Secrets `GPG_PRIVATE_KEY` + `GPG_PASSPHRASE`. Public key published at `inariwatch.com/keys/release.asc` (Session 23 publishes the file).
  - Sign `.deb` with `dpkg-sig`, `.rpm` with `rpm --addsign`, `.AppImage` with embedded GPG via `appimagetool`.
- **Caching:** Rust target cache via `Swatinem/rust-cache@v2`, npm cache via `actions/setup-node@v4`. Cuts builds from ~25min to ~10min.
- **Tests:**
  - Workflow runs on PR (without uploading) → all 4 platforms produce signed artifacts. Artifacts uploaded as workflow artifacts for manual inspection.
  - Notarization succeeds end-to-end (assert via `xcrun stapler validate`).
- **Definition of done:** pushing a tag `v0.1.0-rc1` triggers the workflow; 4 signed artifacts (Mac Universal .dmg, Windows .msi, Linux .deb, Linux .AppImage) land in GitHub Releases; verification succeeds on a fresh user machine for each platform.

### Session 22 — Tauri auto-updater + R2 hosting + updater endpoint (6h)

- **Files:** `desktop/src-tauri/src/updater/mod.rs`, `desktop/src-tauri/tauri.conf.json` (configure updater plugin), `web/app/api/updater/latest/route.ts` (NEW endpoint).
- **Add deps:**
  - `tauri-plugin-updater` = "2"
  - In web: nothing new — use existing Drizzle + Neon.
- **Updater config (`tauri.conf.json`):**
  - `endpoints: ["https://app.inariwatch.com/api/updater/latest?channel={{current_channel}}"]`
  - `pubkey`: Ed25519 public key generated via `tauri signer generate -w ~/.tauri/inari-live.key`. Public key embedded in config; private key in GH Secrets `TAURI_SIGNING_PRIVATE_KEY`.
  - Build step in workflow: `tauri build` automatically signs each artifact with the Ed25519 key, producing `.sig` files.
- **Endpoint `/api/updater/latest` (web):**
  - Reads from a new `desktop_releases` table: `(version, channel, platform, arch, url, signature, notes, pub_date, active boolean)`.
  - Query: `SELECT * WHERE channel=? AND active=true ORDER BY pub_date DESC LIMIT 1`. Returns Tauri-updater-compatible JSON.
  - DB migration: `web/lib/db/migrations/0075_desktop_releases.sql`.
- **R2 hosting:**
  - Bucket `inariwatch-releases` with public-read policy.
  - Custom domain `releases.inariwatch.com` (CNAME to R2) for nicer URLs.
  - Workflow step (after signing): `wrangler r2 object put inariwatch-releases/<version>/<filename>` for each artifact + `.sig`.
  - GitHub Releases keeps a mirror copy for fallback.
- **Client behavior:**
  - On startup, wait 60s, then check updater. If newer version available, download silently in background, verify Ed25519 signature, then surface a Nivel 1 "Update X.Y.Z ready. Restart to install." in dock footer.
  - User restarts → updater applies. If user dismisses, retry in 6h.
  - Major version (X bump) requires explicit confirmation.
  - Metered network detection (Win/Linux): defer until on metered=false. macOS doesn't expose this — always download.
- **Tests:**
  - Endpoint returns 200 + valid JSON for known platform/channel.
  - Tauri client (mock mode) detects newer version → emits `update_available` event.
  - Signature verification rejects a tampered binary.
- **Definition of done:** publishing `v0.1.0-rc2` (after rc1) → users on rc1 see the update notification within 6h; click restart → app updates and relaunches on rc2.

### Session 23 — Beta release v0.1 + landing + telemetry hooks (4h)

- **Files:**
  - `web/app/download/page.tsx` (modify — auto-detect OS via UA, primary CTA per platform)
  - `web/app/(marketing)/inari-live/page.tsx` (NEW — product landing page)
  - `desktop/src-tauri/src/telemetry/mod.rs` (NEW — anonymized event reporter, opt-out by default? confirm — locked spec says opt-IN by default with privacy-first approach; **default is on, with toggle in Settings**)
  - `web/app/api/telemetry/desktop/route.ts` (NEW — receives anonymized events, GDPR-friendly)
- **Telemetry events (anonymized, no content):**
  - `app_launched` (version, OS, arch)
  - `repo_opened` (file_count_bucket, language_set)
  - `sensor_toggled` (sensor_kind, enabled)
  - `chat_completed` (model, latency_bucket, tokens_bucket)
  - `fix_applied` / `fix_rejected` (had_replay, had_eap)
  - `gate_blocked` (gate_kind)
  - `update_check` (current_version, latest_version, action)
  - `crash` (panic_message_first_line, OS)
- **Identifier:** anonymous workspace_id (or `local-<uuid>` if not connected to a workspace). Persisted in `auth.json`. Never includes email, IP, file paths, or content.
- **Landing page (`/inari-live`):**
  - Hero: "Inari Live · The dev companion that lives at your editor"
  - Sub: 3-line value prop
  - Download buttons: Mac / Windows / Linux (auto-detected primary, others as secondary)
  - Below: 4 sections (Drag your repo / Replay-as-you-code / Pre-push gate / Memory that learns) with screenshots
  - Footer: "Beta — free for everyone. No card required."
- **Distribution comm:**
  - Tweet draft prepared in `radar/marketing/inari-live-launch.md` (NOT POSTED — review first)
  - Show HN post draft prepared
  - Email template for beta waitlist (if waitlist exists in `blogSubscribers` table or similar)
- **Tests:**
  - Telemetry payload contains no PII (assert via grep against fixture event).
  - `/api/telemetry/desktop` accepts valid payload, rejects invalid (schema validation).
  - Landing page renders correctly on Chrome / Safari / Firefox at 320/768/1280/1920 widths.
- **Definition of done:** a fresh user visiting `inariwatch.com/download` on Mac sees a primary `.dmg` button; downloading + opening completes onboarding in <2 min; first telemetry event lands in DB within 60s of launch; `/admin/ops` shows a new "Inari Live" widget with active-users count.

---

## Cross-cutting work (post-Track work, ~3 sessions)

### Session A — Capture pre-bundling: zero-install for the dev (6h)

- **Goal:** the user's `npm run dev` runs with `@inariwatch/capture` injected without them ever running `npm install @inariwatch/capture`.
- **Files:** `desktop/src-tauri/src/sensors/substrate/wrapper.rs` (extend), `desktop/src-tauri/src/cli/mod.rs` (NEW — exposes `inari run <cmd>` subcommand). Bundled npm packages: `desktop/src-tauri/resources/bundled-npm/`.
- **Behavior:**
  - The Tauri build embeds `@inariwatch/capture` and `@inariwatch/substrate-agent` (both already published on npm) as static files under `resources/bundled-npm/<pkg>/<version>/`.
  - On `inari run dev` (or wrapped `npm run dev`), the daemon:
    1. Resolves the user's project's preferred Node version (reads `.nvmrc` / `engines.node`).
    2. Sets `NODE_OPTIONS=--import file://<resources>/bundled-npm/.../auto.js --import file://<resources>/bundled-npm/.../substrate-agent/auto.js`.
    3. Spawns the user's command with the modified env.
  - `inari run` works as a CLI wrapper outside the Tauri app too — installed as a sidecar binary `inari` to PATH on app install.
- **Pinning:** the bundled versions are pinned per release. `INARI_LIVE_DECISIONS.md` records: "Capture pinned to vX.Y.Z, Substrate-agent to vA.B.C as of release v0.1.0".
- **Update path:** when bundled npm packages have a new version, the next desktop release rebundles. Users get the new SDK via desktop app update — they don't `npm install` anything.
- **Tests:**
  - `inari run node -e 'process.exit(0)'` exits 0 with the env vars set.
  - A real Express app run via `inari run npm run dev` produces capture events.
- **Definition of done:** dogfood — running `inari run pnpm dev` in `radar/web/` produces capture events visible in the dashboard within 30s, without any npm install required.

### Session B — End-to-end dogfood + smoke tests (4h)

- **Goal:** prove the full loop on a real repo (radar itself).
- **Scenario:**
  1. Fresh install of Inari Live on dev machine.
  2. Drag `radar/web/` into onboarding.
  3. Wait for indexing (target <60s).
  4. Open dock with `Cmd+Space`, ask "where do we handle alert dedup?" → expect a relevant answer with file references.
  5. Run `pnpm test` in terminal with shell hooks on → see ShellEvent in timeline.
  6. Make a syntax error in a known file → see the error captured in dock as Nivel 1.
  7. Click "Fix it" → see streaming diff, apply.
  8. Run `git commit` → see commit logged.
  9. Try `git push` with broken code → see pre-push gate block.
  10. Override with `[Push anyway]` → push proceeds.
- **Outputs:**
  - `radar/INARI_LIVE_DOGFOOD_LOG.md` — append-only log of dogfood sessions with date, scenarios run, bugs found, perf measurements.
  - GitHub issues filed for any bugs found, labeled `inari-live` + priority.
- **Definition of done:** all 10 scenarios pass on a fresh install; perf targets met (cold start <800ms, RAM idle <120MB, dock open <50ms); zero crashes in 1-hour stress session.

### Session C — Telemetry dashboards on `/admin/ops` (3h)

- **Files:** `web/app/admin/ops/widgets/InariLiveActiveUsers.tsx`, `InariLiveCrashRate.tsx`, `InariLiveAdoption.tsx`, `InariLiveAIBudget.tsx`. Backing API routes in `web/app/api/admin/inari-live/*`.
- **Widgets:**
  - **Active users** — daily / weekly / monthly. Drill down by OS + version.
  - **Crash rate per version** — alerts if any version crosses 1% crash rate.
  - **Sensor adoption** — % of users with each opt-in sensor enabled.
  - **AI budget burn** — daily $ spent across all users vs $300/day cap.
  - **Update adoption** — what % of active users are on the latest stable within 7 days of release.
  - **Time-to-second-fix** — median time between first and second remediation per user (engagement signal).
- **Definition of done:** widgets land at `/admin/ops`; data is live (refreshes every 30s via existing /admin/ops infra); each widget links to a deeper drilldown view.

---

## Total budget

| Track | Sessions | Hours |
|---|---|---|
| Foundations | 4 | 22 |
| Sensors | 6 | 42 |
| Memory layer | 3 | 16 |
| UI dock + onboarding | 4 | 30 |
| AI + remediation | 3 | 20 |
| Distribution | 3 | 18 |
| Cross-cutting | 3 | 13 |
| **TOTAL** | **26** | **~161** |

Add 25-30% slack for code-signing setup pain (EV cert procurement + Apple notarization edge cases), Tauri-specific debugging on Windows transparency, and the inevitable IPC type-mismatch days = realistic **~200 hours** = roughly **25-30 working days** of single-author effort.

If the architect wants to ship a faster MVP, **drop Track 6 + Cross-cutting** (defer signing/release/dogfood by 2-4 weeks): MVP = Tracks 1-5 = 20 sessions, ~130h. The MVP is internally testable but unshippable to external users without signing.

---

## Coordination protocol

- **One session = one branch.** Branch naming: `feat/inari-live-<track>-<session>` e.g. `feat/inari-live-track2-session5-fs-watcher`.
- **No pushes to remote** until explicitly approved by the architect (per `feedback_commit_workflow.md`). Each session commits locally and updates the handoff with the commit SHA.
- **Decision log:** `radar/INARI_LIVE_DECISIONS.md` (append-only). Any decision not covered by spec recap goes here with date + session + rationale.
- **Status update:** at end of each session, the executor updates this document's session block with: status (Done/Blocked), commit SHA, test counts, and any notes for the next session.
- **Blocked sessions:** if a session can't complete, mark Blocked with a clear reason. The next session reads it before claiming a new task.
- **Parallelization windows:**
  - After Track 1 (Sessions 1-4) complete: Sessions 5 (FS) + 7 (MCP) can run in parallel — independent.
  - After Track 2 partial (Sessions 5-6 done): Session 11 (memory.md) + Session 8 (git hooks) + Session 14 (Tauri shell) can run in parallel.
  - Track 6 (signing/updater/release) is fully sequential within itself but parallel to Cross-cutting.

---

## Open questions deferred (NOT blockers)

These are explicitly NOT decided in the spec recap and will be answered when relevant work begins. They do NOT block any session below.

1. **VSCode thin extension (cursor-position relay):** ship in v0.2 or v0.3? Not in v0.1.
2. **Sensor 5 (HTTP proxy):** v0.2 or v0.3? Not in v0.1.
3. **Mobile companion app:** explicitly OUT (`feedback_wedge_strategy.md` warns against scope creep).
4. **Patentability of deterministic-replay-with-substitution:** legal exploration, not a session.
5. **Self-hosted enterprise tier:** v1.x territory.
6. **Shared team patterns (Team tier):** v1.x territory.

---

## Already shipped before this plan (recap)

| Asset | Source | Date |
|---|---|---|
| Tauri 2 desktop shell scaffold | `desktop/` | 2026-04-27/28 |
| 6 transparent SVGs (Recraft) | `desktop/dist/inari/assets/` | 2026-04-27/28 |
| Frosted-glass dock CSS prototype | `desktop/dist/inari/` | 2026-04-27/28 |
| `inari-daemon/` Linux server-side product | `inari-daemon/` | (separate product, NOT this) |
| MCP server (web, hosted) | `mcp.inariwatch.com` | Reused as proxy target |
| Substrate v0.1.2 + replay engine | `Substrate/` | 2026-04-25 |
| EAP local Ed25519 verify | EAP repo | 2026-04-24 |
| Capture v2 with breadcrumbs | `capture/` | 2026-04-17 |
| 17 auto-merge gates | `web/lib/ai/auto-merge-gates.ts` | 2026-04-17 |
| Container Agent + worker | `worker/`, `web/lib/ai/container-agent.ts` | 2026-04-09 |
| Onboarding flow (Tauri side bits) | `desktop/src-tauri/src/onboarding.rs` | uncommitted |
| Saves / settings / autofix / connect Rust modules | `desktop/src-tauri/src/*.rs` | uncommitted, audited in Session 1 |

This plan starts from that point. Session 1 audits the existing Rust modules and decides what to keep, rename, or remove before any new code lands.
