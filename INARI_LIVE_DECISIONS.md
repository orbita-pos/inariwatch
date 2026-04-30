# Inari Live — Decision Log

Append-only. Each decision is dated, attributed to a session, and captures *what* was decided and *why* — so a future session can re-read the context without paging back through the master plan.

If a decision conflicts with a fixed constraint in `INARI_LIVE_HANDOFF.md` § *Spec recap*, the fixed constraint wins; the decision must be revised. Decisions that **clarify** spec ambiguities (without contradicting them) are valid.

Format:
```
## YYYY-MM-DD — Sesión N
Decision: <what>
Reason:   <why>
Impact:   <what code / sessions / sequencing this changes>
```

---

## 2026-04-29 — Sesión 1
Decision: Introduce `src-tauri/src/cloud/` as a peer module of `daemon/`, `sensors/`, `memory/`, `ai/`, `ipc/`, `store/`, `window/`, `gates/`, `updater/`, `telemetry/`, `cli/`.
Reason:   The existing scaffold has 4 files (`desktop_auth.rs`, `lib.rs::start_alert_poller`, `saves.rs`, plus future workspace-metadata fetchers) that do cross-cutting cloud-API work and don't fit any spec-named module cleanly. Forcing them under `ipc/` conflates HTTP-to-cloud with IPC-to-webview; nesting them under `daemon/` hides them from independent testing.
Impact:   Sessions 4 and beyond own the moves into `cloud/`. `ARCHITECTURE.md` § *Module split* documents the canonical layout. No spec-recap constraint is violated. Sessions 18-23 (`ai/`, `gates/`, `updater/`, `telemetry/`) are unaffected.

## 2026-04-29 — Sesión 1
Decision: `src/inari_watcher.rs` is split across three modules at end of Session 10, not preserved as a single file.
Reason:   It mixes three concerns (FS watching / `/v2/replay` dispatching / community-pattern lookup) that map cleanly to three separate target modules (`sensors/fs/`, `sensors/substrate/`, `memory/procedural/`). Keeping it as one module would mean `sensors/substrate/` imports from `memory/`, violating the dependency direction.
Reason 2: Session 5 rebuilds the FS sensor with `notify-debouncer-mini` + `ignore` walker — the existing `notify` watch loop is the reference implementation but not the long-term home.
Impact:   Sessions 5, 10, 12 each port their slice. Session 5 does NOT delete `inari_watcher.rs` — Session 10 does, after parity tests confirm the replay path still works.

## 2026-04-29 — Sesión 1
Decision: `src/autofix.rs` is renamed to `ai/remediate/cloud_proxy.rs` (no rewrite) at end of Session 19.
Reason:   The existing autofix bridge IS the "cloud agentic proxied" path Session 19's spec describes. Reusing it verbatim avoids duplicate code.
Impact:   Session 19 implements `single_shot.rs` and `orchestrator.rs` net-new; `cloud_proxy.rs` is a `git mv` + import update. Saves ~6 hours of Session 19 work.

## 2026-04-29 — Sesión 1
Decision: `src/connect.rs` is the prototype for Session A's `inari run <cmd>`. Session 10's substrate wrapper extends it (adds `--import @inariwatch/substrate-agent/auto`).
Reason:   Both flows share identical resolution: bundled npm package → `--import file://` URL → spawn user's dev server. Session A and Session 10 cannot live as independent implementations without duplicating ~250 lines of platform-specific spawning logic.
Impact:   Session 10 implements `sensors/substrate/wrapper.rs` calling into a shared spawner. Session A implements `cli/run.rs` using the same spawner. The spawner lives at `cli/run.rs::spawn_with_imports()` and is imported by both.

## 2026-04-29 — Sesión 1
Decision: `desktop/dist/inari/` (vanilla HTML/JS shell) is preserved as the active Tauri webview source until Session 14, then deleted.
Reason:   It works. Killing it before Session 14 lands the React+Vite shell breaks dogfood. The transition is a single `tauri.conf.json::build.frontendDist` swap + delete the HTML files.
Impact:   Sessions 2-13 keep running against the vanilla shell. The 6 fox SVGs in `dist/inari/assets/` survive the transition (preserved Recraft IP, sunk cost).

## 2026-04-29 — Sesión 1
Decision: A new `dock` window (720×480 transparent + vibrancy + Accessory policy) is created in Session 14, **distinct** from the existing `inari` window (480×640 standard chrome + taskbar). The existing `inari` window is removed from `capabilities/default.json` at end of Session 14.
Reason:   The two windows have incompatible specs. Reconfiguring `inari` to match the dock spec would break the current vanilla shell that depends on the standard-chrome geometry.
Impact:   Session 14's `window/dock.rs` creates the new label `dock`. Session 14 also updates `capabilities/default.json` to drop `inari` from the windows array (`["main", "dock", "inari-settings"]` if onboarding stays separate, or `["main", "dock", "settings"]` after Session 17).

## 2026-04-29 — Sesión 1
Decision: `src/fingerprint.rs` moves to `src/memory/fingerprint.rs` rather than staying as a top-level module.
Reason:   Session 12's procedural matcher is the primary call-site post-Session-10 (which deletes `inari_watcher.rs`). `memory/fingerprint.rs` keeps the call-graph local (`memory::procedural` calling `memory::fingerprint`).
Impact:   Session 11 does the move (since it touches `memory/` first). All imports change from `crate::fingerprint::compute_error_fingerprint` to `crate::memory::fingerprint::compute_error_fingerprint`. Wire-format must remain byte-identical to `web/lib/ai/fingerprint.ts` and `cli/src/mcp/fingerprint.rs` — a regression test asserts this.

## 2026-04-29 — Sesión 1
Decision: Each session owns the **destination move** of its existing-file refactor. No pre-emptive moves in Session 2.
Reason:   Sessions can run in parallel after Track 1 completes. If Session 2 pre-emptively moves files, parallel Sessions 5 + 7 + 11 would all start with stale paths. By having each session land its move at the end, conflict surface is minimized.
Impact:   Session 2 is allowed to create *empty* module skeletons (`pub mod cloud;`, `pub mod sensors;`, etc.) so future sessions just fill them in. No content moves yet.

## 2026-04-29 — Sesión 1
Decision: Heavy-data IPC rule is locked here: never serialize `Vec<f32>` embeddings, full ASTs, or > 10k-entry lists, or > 100KB diffs through `tauri::invoke`/`tauri::emit`. Heavy data goes via the local MCP HTTP transport on `127.0.0.1:9876` (Session 7).
Reason:   Tauri IPC serializes through a single JSON channel; large payloads block the webview thread and inflate memory in dev. Spec recap performance budget (<120MB RAM idle) cannot survive a single 384-dim × 50k-symbol vector dump.
Impact:   Every PR is reviewed against this rule. Exceptions require an `INARI_LIVE_DECISIONS.md` entry. Frontend uses MCP HTTP for codebase search, AST traversal, large-diff fetching.

## 2026-04-29 — Sesión 1
Decision: Drop `src/onboarding.rs`'s frontend usage at end of Session 17, but leave the Tauri commands reachable until then.
Reason:   Session 17 ships a multi-step onboarding (drag-repo → power-ups → ready). The current 1-step "pick a folder" onboarding is functional and unblocks dogfood through Sessions 2-16. Removing it pre-Session-17 would force Sessions 2-16 to ship without any onboarding flow at all.
Impact:   `ipc/onboarding.rs` (renamed in Session 4) ships unchanged. Session 17 deletes the file at end of session after the React-side replacement is verified.

## 2026-04-29 — Sesión 2
Decision: Event bus uses `Arc<Mutex<VecDeque<DaemonEvent>>>` per subscriber + `flume::Sender<()>` notifier — NOT raw `flume` mpmc and NOT `tokio::sync::broadcast`.
Reason:   The spec said "flume-based broadcast channel". flume's mpmc primitive is *not* a broadcast — Receiver clones COMPETE for events, so each subscriber would only see a subset. tokio::sync::broadcast has the right semantics but couples sensors to a tokio runtime and complicates non-async sensor receive paths. The hand-rolled VecDeque + flume notifier gives true broadcast (each subscriber owns its queue), drop-oldest at the producer in O(1), and sync/async/timeout receive support without a tokio dependency.
Impact:   `daemon/bus.rs` is the canonical implementation. Sensors that need async receive call `Receiver::recv_async`; sync sensors call `Receiver::recv`/`recv_timeout`. Spec-compliant in semantics; flume is still in the dep tree (used for the notifier and as the spec-named primitive).

## 2026-04-29 — Sesión 2
Decision: `daemon` is the only Session-2 module declared `pub` in `lib.rs`. `cloud`, `sensors`, `memory`, `ai`, `ipc`, `store`, `gates`, `updater`, `telemetry`, `cli`, `indexer`, `window` stay private (default).
Reason:   Integration tests in `tests/` link against the `inariwatch_desktop_lib` crate and need to reach `daemon::lifecycle::run` to drive it under `#[tokio::test(start_paused = true)]`. Going through the production `start_daemon()` spawn path would couple to a tokio runtime separate from the test's. No other Session-2 module has callers outside the binary yet.
Impact:   When future sessions add tests that need to reach into other modules, flip the `mod foo;` to `pub mod foo;` at the same time. Session 3 will likely flip `store` to `pub`.

## 2026-04-29 — Sesión 2
Decision: Tray menu kept backward-compatible — existing 6 items preserved, new `Pause sensors` item ADDED as a stub.
Reason:   Session 2 spec listed a simplified 4-item menu (`Open Inari Live` / `Pause sensors` / `Settings…` / `Quit`). The existing scaffold ships 6 items (`Open InariWatch` / `Open Inari Live` / `Open dashboard…` / `Pause watch` / `Settings…` / `Quit`) with working dogfood behaviors (alert-poller toggle via `Pause watch`, dashboard quick-open). Per global feedback `feedback_no_breaking_changes`, removing items mid-flight would regress dogfood. Adding `Pause sensors` between `Pause watch` and `Settings` lets Session 5+ migrate the legacy `Pause watch` into the daemon-aware bus pause without a window where neither works.
Impact:   `lib.rs::setup_tray` ships 7 items (the 6 legacy + 1 new). Session 5+ unifies — at that point `Pause watch` is removed and `Pause sensors` becomes the single source of truth.

## 2026-04-29 — Sesión 2
Decision: `inari-live-dock` window label is the canonical Session-2-onwards dock identifier. Existing `inari` label retained for the visual prototype.
Reason:   The existing `inari` window (480×640, decorations on, taskbar visible — Session-0 visual prototype) has different chrome than the spec-locked dock (720×480, transparent + vibrancy, Accessory policy). Reusing the label would force Session 2 to either break the prototype or ship a misconfigured dock. New label avoids both.
Impact:   `capabilities/default.json` includes both `inari` and `inari-live-dock`. Session 14 retires `inari` (per `ARCHITECTURE.md` decision 6) and the React+Vite shell ships against `inari-live-dock`. Cmd/Ctrl+Space toggles the new label, not the prototype.

## 2026-04-29 — Sesión 3
Decision: Hand-rolled migration runner (`src/store/migrations.rs`, ~80 LoC) instead of refinery.
Reason:   Three migrations + no rollback story does not justify the dep cost. refinery 0.8 + rusqlite 0.31 also pulls feature-gating gymnastics around its async-postgres transitive defaults; hand-rolling is faster to audit, ships zero new transitive deps, and the SQL is `include_str!`-baked into the binary for byte-stability across builds.
Impact:   `MIGRATIONS: &[Migration]` is the canonical list; appending a new entry is the only supported way to extend the schema. Each migration runs in its own transaction; partial failure leaves the DB at the previous version. `schema_versions(version,name,applied_at)` is the only "framework-style" table — Sessions 5/11/12/13 each add their own `MIGRATIONS` entry.

## 2026-04-29 — Sesión 3
Decision: Embedding dimension is **384** (MiniLM-L6-v2), not 1024.
Reason:   HANDOFF.md's Session 3 spec body said `FLOAT[1024]` but Session 6's spec body locks the embedding model as MiniLM-L6-v2, which emits 384-dim vectors (`fastembed-rs` ships it as the default). Shipping a 1024-dim virtual table would force a destructive migration the moment Session 6 lands. 384 today matches the model that's coming.
Impact:   Migration `0002_embeddings.sql` declares `code_embeddings(symbol_id INTEGER PRIMARY KEY, embedding FLOAT[384])`. The `tests/store_sqlite_vec_loaded.rs` test inserts unit 384-vectors and asserts cosine distance. If Session 6 swaps to a different model later, that's a new migration that drops + re-creates the virtual table — same workflow either way.

## 2026-04-29 — Sesión 3
Decision: sqlite-vec is loaded via `rusqlite::ffi::sqlite3_auto_extension` registered exactly once at process start (`std::sync::Once` in `src/store/pool.rs`), NOT via per-acquire `Connection::load_extension` calls.
Reason:   This is the upstream sqlite-vec crate's documented pattern — the global auto-extension is invoked by SQLite on every newly-opened connection (including those produced inside r2d2_sqlite's `SqliteConnectionManager`), so all pooled connections get vec0 loaded with zero per-acquire FFI cost. Per-connection `load_extension` requires toggling `enable_load_extension` on each acquire and is strictly more work for the same effect. The `Once` keeps repeated `Store::open_at` calls (e.g. across tests in the same process) safe.
Impact:   `r2d2::CustomizeConnection::on_acquire` is responsible only for connection-local PRAGMAs (`foreign_keys`, `temp_store`, `busy_timeout`, `mmap_size`, plus a defensive `journal_mode=WAL` query). Tests `store_sqlite_vec_loaded` and `store_pool_connections` exercise both paths.

## 2026-04-29 — Sesión 3
Decision: Settings TOML→SQL cutover DEFERRED to Session 4. `dirs` crate stays in `Cargo.toml` for now.
Reason:   Six other pre-Session-2 files use `dirs::config_dir()` (`autofix.rs`, `connect.rs`, `desktop_auth.rs`, `inari_watcher.rs`, `local_ingest.rs`, `saves.rs`, plus `onboarding.rs` and the alert poller in `lib.rs`). Session 1's `ARCHITECTURE.md` marks them intocable until their owning sessions (Sessions 4, 10, 17, 19). Migrating only `settings.rs` to SQL while leaving 6 other `dirs` callers behind would force Session 3 to either: (a) remove `dirs` and break those 6 files, or (b) migrate them all in this session and exceed scope. Session 4 owns the `cloud/auth.rs` + `cloud/saves.rs` + `cloud/alert_poller.rs` + `ipc/{onboarding,settings}.rs` renames per ARCHITECTURE.md — that's the natural boundary to land the path-resolver migration AND drop `dirs` AND cut settings over to SQL in one coherent change.
Impact:   `src/store/migrations/0001_initial.sql` defines the `settings(key, value, updated_at)` table NOW (so Session 4 doesn't need a new migration to land the cutover). `store::queries::*` exposes `find_repo_by_path`, `upsert_repo`, `insert_event` as initial helpers. `dirs = "5"` stays in `Cargo.toml`. Session 4's prep checklist: read TOML once on first SQL-mode boot → upsert keys → rename file to `desktop.toml.migrated` (never delete user data). Session 4 also un-`#[ignore]`'s `tests/store_path_resolution.rs::resolve_db_path_via_tauri_apphandle` once a Tauri test harness exists.

## 2026-04-29 — Sesión 3
Decision: `pub mod store;` (mirroring `pub mod daemon;` from Session 2). Other Session-2 module skeletons (`cloud`, `sensors`, `memory`, `ai`, `ipc`, `gates`, `updater`, `telemetry`, `cli`, `indexer`, `window`) stay private until they need integration tests.
Reason:   Five integration test files in `tests/store_*.rs` need to reach `Store::open_at`, `migrations::applied_count`, and `pool::POOL_SIZE` directly. The Session-2 precedent (`pub mod daemon;`) and decision log both establish that flipping a module to `pub` at the same time tests are added is the canonical path.
Impact:   Sessions 5+ flip their owning module to `pub` when they add integration tests. `inariwatch_desktop_lib::store::*` is now part of the integration-test surface; future schema additions append migrations rather than touching shipped ones.

## 2026-04-29 — Sesión 4
Decision: Legacy TOML→SQL settings migration is **non-destructive** — the TOML file is NOT renamed to `.migrated`. Idempotency tracked by a marker row (`__legacy_toml_migrated_at`) in the `settings` table.
Reason:   The Session-4 spec body said "rename TOML → .migrated" but `inari_watcher.rs` is locked (Session 5/10/12 owns it) and STILL reads the legacy TOML directly via `dirs::config_dir()`. Renaming the file would silently make the watcher go dormant on the next boot — a regression of the live dogfood path. Per global feedback `feedback_no_breaking_changes`, every change must be backward-compatible. A SQL marker row gives identical idempotency without touching files the watcher depends on.
Impact:   `store::legacy_settings_migration::migrate_at` upserts each TOML key into `settings(key, value, updated_at)`, stores the full file as a `legacy_settings` JSON blob, and writes the marker row. Re-runs return `MigrationOutcome::AlreadyMigrated`. When Session 5 rewrites the watcher, it reads from SQL settings and the legacy TOML can be retired at that point.

## 2026-04-29 — Sesión 4
Decision: `dirs` crate STAYS in `Cargo.toml` after Session 4. Two callers remain: `inari_watcher.rs` (locked — Session 5/10 owns) and `store/legacy_settings_migration.rs` (deliberate — must read the legacy `~/.config/inari/desktop.toml` path).
Reason:   Session 4 migrated the 6 callers it owned (`autofix.rs`, `connect.rs`, `desktop_auth.rs`, `onboarding.rs`, `saves.rs`, `settings.rs`, plus `lib.rs::read_desktop_config` + `start_alert_poller`) off `dirs` and onto either `tauri::AppHandle::path()` or the SQL settings store. Removing the `dirs` crate would break the two remaining callers. Per Session 1's "no pre-emptive moves" principle, `inari_watcher.rs` belongs to Session 5/10 — Session 4 is not allowed to touch it.
Impact:   Session 5 (FS watcher) drops `dirs` from `Cargo.toml` after rewriting the watcher to subscribe to settings via SQL. Until then, `cargo tree | grep dirs` shows it as a direct dep with two callers. The `cloud::api::read_dashboard_creds` helper exists so future callers don't reinstate `dirs` via copy-paste.

## 2026-04-29 — Sesión 4
Decision: `IpcError` is a typed enum with 8 variants (`Migration`, `Connection`, `ExtensionLoad`, `Io`, `Query`, `InvalidPath`, `RepoNotFound`, `Internal`) — NOT a stringly-typed error.
Reason:   The Session-4 spec called for "discriminate the 5 most actionable variants of `StoreError`". An enum with `#[serde(tag = "kind")]` lets the dock pattern-match in TS via the auto-generated tagged union and surface variant-specific UX (e.g. "DB is from a newer build — please update" only on `Migration`). Going through `String` would force the frontend to regex-parse error messages.
Impact:   `From<StoreError> for IpcError` discriminates the 5 spec-listed variants and collapses `PathResolution` into `Internal`. ts-rs generates `desktop/src/lib/types/IpcError.ts` as a tagged union; the frontend wrapper exposes `isIpcError(err)` as a type guard.

## 2026-04-29 — Sesión 4
Decision: Pick `ts-rs = "8"` over hand-rolled or `serde-reflection`. ts-rs's auto-generated `export_bindings_*` lib tests refresh the `.ts` files on every `cargo test --lib`.
Reason:   Track 5 will end with ~30 DTOs. Hand-rolling would diverge silently the first time a Rust struct gains a field. ts-rs piggybacks on existing `#[derive(Serialize)]` annotations with one extra `#[derive(TS)]` and `#[ts(export)]`; output lands in the directory the frontend imports from. ts-rs v8 emits one `export_bindings_<type>` test per `#[ts(export)]` annotation, so no manual entry-point test is needed — the bindings stay in sync with zero contributor friction.
Impact:   The four Session-4 DTOs (`DaemonStatusDto`, `RepoDto`, `LogEntryDto`, `IpcError`) land at `desktop/src/lib/types/*.ts`. Generated files are committed alongside the Rust source. CI can rely on `cargo test --lib` to fail if a contributor forgets to commit a regenerated binding.

## 2026-04-29 — Sesión 4
Decision: `started_at` ISO is computed once via `OnceLock` in `snapshot_to_dto`, then cached for the rest of the process lifetime.
Reason:   Without caching, `started_at = now() - uptime_secs` drifts whenever wall-clock advances faster than the heartbeat-driven `uptime_secs` — between heartbeats the difference would slide by up to 30 s. The PartialEq dedup in `daemon:status_changed` would then fire spuriously on every bus event.
Impact:   First call to `snapshot_to_dto` captures `now() - uptime` at that instant; subsequent calls return the cached value. Stable `started_at` makes the debouncer's PartialEq actually suppress duplicates.

## 2026-04-29 — Sesión 4
Decision: `cloud/api.rs` exposes `DEFAULT_API_URL = "https://app.inariwatch.com"` and `read_dashboard_creds(store)` as the single source of truth for cloud-API base URL + token.
Reason:   The pre-Session-4 scaffold had **four** copies of the same TOML-parsing helper (`desktop_auth.rs::read_desktop_toml`, `saves.rs::read_dashboard_creds`, `autofix.rs::read_dashboard_cfg`, `lib.rs::read_desktop_config`). Each parsed `desktop.toml` with slightly different defaults and field handling. After moving everything to SQL, the same risk applied: 4 modules each calling `settings::get` for the same keys. Centralizing in one place stops drift before it starts.
Impact:   `cloud/auth.rs`, `cloud/saves.rs`, `cloud/alert_poller.rs`, and `ai/remediate/cloud_proxy.rs` all consume `read_dashboard_creds`. Future sessions adding cloud features import from here too.

## 2026-04-29 — Sesión 5
Decision: `dirs` crate fully removed from `desktop/src-tauri/Cargo.toml` direct deps.
Reason:   Session 4 left two callers (`inari_watcher.rs::read_config`, `store/legacy_settings_migration.rs::legacy_toml_path`) blocking the removal. Session 5 migrates `inari_watcher::read_config` to read every key from the SQL `settings` table (the legacy TOML data is already mirrored there by Session 4's one-shot migration), and switches `legacy_toml_path` to Tauri's `PathResolver::config_dir()` — byte-equivalent to `dirs::config_dir()` on every supported platform, so any pre-Session-4 user file at `<config_dir>/inari/desktop.toml` is still picked up.
Impact:   `cargo tree -i dirs` shows the crate only as a transitive dep through Tauri internals (acceptable per Session 5 spec). Future modules that need OS standard directories must use `app.path().*` from Tauri's `PathResolver`, never re-add `dirs`.

## 2026-04-29 — Sesión 5
Decision: Use `notify-debouncer-mini = "0.4"` (NOT `-full`) with a 200ms window and **no** explicit tick rate.
Reason:   The 0.4 API is `new_debouncer(timeout, handler)` — there is no third `tick_rate` argument (the prompt's draft code mentioned one; the public crate doesn't expose it). YEAR1 work measured `mini` having lower lock contention than `-full` on monorepo workloads where tens of thousands of paths churn per second; `-full`'s per-path event buffering also surfaces rename pairs we don't need in v0.1. The 200ms window collapses VS Code / JetBrains save bursts (which fire create / modify / temp-file dance in <50ms) into a single delivery without delaying interactive feedback.
Impact:   `super::debouncer::DEBOUNCE_WINDOW = Duration::from_millis(200)` is the canonical constant. The `DebounceEventResult` is `Result<Vec<DebouncedEvent>, notify::Error>` — single error, not Vec — handled accordingly. Upgrading to debouncer-full later would require adapting the error path (it returns `Vec<notify::Error>`) and considering whether to surface rename pairs.

## 2026-04-29 — Sesión 5
Decision: `FsChangeKind` lives in `crate::daemon` (re-exported from `sensors::fs::kind`); the FS sensor depends on daemon, not the reverse.
Reason:   The IPC bridge (`ipc::events`) and future indexer (Session 6) need to pattern-match on `FsChangeKind` without crossing into sensor internals. Putting the canonical home at the daemon layer keeps the cross-sensor dependency direction one-way (sensors → daemon, never the reverse). `sensors/fs/kind.rs` is a thin re-export so callers reading the sensor module structure can still find the type locally.
Impact:   `crate::daemon::DaemonEvent::FsChange { kind: FsChangeKind }` and `crate::sensors::fs::kind::FsChangeKind` resolve to the same type. Sessions 6 (indexer) and 12 (procedural memory) consume from `daemon::FsChangeKind`. Variants: `Created` / `Modified` / `Deleted` / `Renamed { from: PathBuf }`. Today the watcher only emits `Modified` / `Deleted` (debouncer-mini's coarse `Any` events get classified by stat-checking the path post-debounce — `Created` is indistinguishable from `Modified` without tracking the previous file set, which is the indexer's job in Session 6); `Renamed` is reserved for a debouncer-full upgrade or platform-specific event paths.

## 2026-04-29 — Sesión 5
Decision: `DaemonEvent::FsChange { kind: FsChangeKind }` is serialized with `#[serde(rename = "change")]` on the `kind` field — the JSON wire field is `"change"`, not `"kind"`.
Reason:   `DaemonEvent` is internally tagged on `"kind"` (`#[serde(tag = "kind")]`). serde rejects a variant field of the same name as the discriminator. The Session 5 prompt explicitly requires the Rust field name `kind` (matching `FsChangeKind`'s natural name), so we keep the Rust API and rename only the wire field. No frontend code consumes `DaemonEvent::FsChange` yet (Session 14 builds the React shell), so the JSON shape is internal-only at this point.
Impact:   On the wire: `{"kind": "fs_change", "repo_id": "...", "path": "...", "change": {"kind": "modified"}}`. In Rust: `DaemonEvent::FsChange { repo_id, path, kind }` matches normally. The `daemon:event` Tauri channel delivers this shape to the webview; Session 14's frontend wrapper will pattern-match on `kind == "fs_change"` then read the inner `change` object.

## 2026-04-29 — Sesión 5
Decision: FS sensor actor runs on a dedicated `std::thread`, not under `tauri::async_runtime`. Cooperative shutdown via `cmd_rx.recv_timeout(150ms)` + bus-drain check for `DaemonEvent::Shutdown`.
Reason:   The actor's job is tiny (Attach / Detach / Shutdown). An async runtime would add an external dependency (tokio coloring) for no payoff: notify-debouncer-mini already runs its own thread internally for kernel event delivery. A 150ms tick gives shutdown latency well inside the daemon's 5s grace window with negligible CPU. Sync also makes the actor trivially testable — integration tests instantiate `EventBus` + `SharedDaemonState` directly and drive the handle without any runtime lifecycle.
Impact:   `FsSensorHandle` is `Clone` and lives in `tauri::State`; `attach`/`detach` calls from Tauri commands send through a `flume::Sender`. Dropping every clone closes the channel → actor sees `Disconnected` → exits. Production also exits on `DaemonEvent::Shutdown` from the bus. Both paths decrement `sensor_count` once.

## 2026-04-29 — Sesión 5
Decision: Initial walk runs on a `rayon::spawn` worker, not the actor thread. `MAX_FILES_HARD_CAP = 50_000` truncates pathological walks.
Reason:   The actor must stay responsive to Attach/Detach commands; a 5_000-file repo's walk is fast (~150ms) but nothing prevents a user from pointing the sensor at `~/` (tens of millions of files). Capping at 50_000 is generous for any realistic repo and keeps the perf budget (<120MB RAM idle) safe even when the indexer (Session 6) holds an embedding for every walked file. Truncation surfaces as a `SensorWarning` so the dock can prompt for a `.gitignore` rule.
Impact:   `walker::walk_repo` returns `WalkResult { file_count, duration_ms, truncated }`. The actor publishes `RepoIndexed` even on truncation (with `file_count == 50_000`) so the dock shows progress instead of hanging. Session 6's indexer must respect the same cap for memory safety.

## 2026-04-29 — Sesión 7
Decision: The local MCP server exposes **26 tools, not 25**. CLAUDE.md says "25 tools" but the SSOT registry at `web/app/api/mcp/registry.ts` includes `rollback_vercel` as a legacy alias of `rollback_deploy`, bringing the canonical count to 26.
Reason:   Mirroring SSOT verbatim is the only way an MCP client configured against `mcp.inariwatch.com` keeps working against the local server without per-client modifications. Dropping the legacy alias on the local side would silently break clients that pin `rollback_vercel`. The cost (one extra stub) is negligible.
Impact:   `tools::registry()` enumerates 26. Tests assert `tools/list.length == 26` (`tests/mcp_jsonrpc_roundtrip.rs::tools_list_returns_full_registry`). When CLAUDE.md is next refreshed, update the line to "26 tools (25 canonical + 1 legacy alias)" — or accept the drift and trust the registry.

## 2026-04-29 — Sesión 7
Decision: Stub policy — every cloud-proxied tool returns an `Ok` JSON-RPC response with `{ "isError": true, "_pending": { "ok": false, "reason": "not_yet_wired", "session": "Session N", "tool": "..." } }` plus a human-readable `content[0].text`. No JSON-RPC error code is returned today.
Reason:   MCP clients (Claude Code, Codex, Cursor, Zed) render `content[0].text` directly to the user. A JSON-RPC error code surfaces as a generic failure ("Tool call failed") with no actionable hint. By embedding the explanation in `content`, the client shows "trigger_fix is not yet wired in the local MCP server. This tool will be implemented in Session 19. For now, use the hosted server at mcp.inariwatch.com..." — which is exactly the message the user needs.
Impact:   `proxied::stub::Stub` implements `Tool::call` to return the structured envelope. Sessions 18-19 (cloud proxy) replace each stub with a real implementation by swapping the `Box::new(Stub { ... })` entries in `tools::registry()` for fresh structs. The `_pending` payload is namespaced (underscore prefix) so it doesn't collide with future MCP-protocol fields.

## 2026-04-29 — Sesión 7
Decision: Port fallback policy — try the explicitly-requested port first, then walk `9876..=9891` (DEFAULT_PORT + 16). Persist the chosen port to SQL `settings.mcp_port` and write it to `<app_local_data_dir>/inari-live/port.txt` for the sidecar to consume.
Reason:   Hard-coded 9876 collides with the user's other localhost services (Vite, Next.js dev, Docker port-forwards). Random ephemeral ports surprise editor configs every boot. The compromise: a small fallback range that's stable across boots (we always retry the previously-chosen port first) but accommodates conflicts. 16 ports is generous — most installs land on 9876.
Impact:   `bind_with_fallback(requested) -> (TcpListener, port)` is the canonical resolver, used by both the production listener (`spawn_mcp_server`) and the integration test (`tests/mcp_port_fallback.rs`). Sidecar `inari-mcp-stdio` reads `port.txt` (or the `INARI_LIVE_MCP_PORT` env var) so it tracks the daemon's chosen port automatically. Editor configs bind to `inari-mcp-stdio` (the sidecar) — they never see the port directly.

## 2026-04-29 — Sesión 7
Decision: stdio is implemented as a **separate sidecar binary** (`[[bin]] inari-mcp-stdio`), not as a `--mcp-stdio` subcommand of the main binary or as an in-process listener.
Reason:   The Session 7 spec listed both options ("spawned as child process" + "sidecar binary inari-mcp-stdio"). Two factors decide: (1) Tauri's signing path is per-binary, but the bundle ships both binaries together — a separate sidecar binary keeps the parent process small and avoids stdio contention with Tauri's own logging; (2) when an editor spawns the sidecar, we don't want the user's daemon process to fork — the sidecar should be a tiny, single-purpose client that forwards JSON-RPC over HTTP. Subcommand-style would force the daemon to multiplex stdio handling with the rest of its work.
Impact:   `Cargo.toml` declares `[[bin]] inari-mcp-stdio` at `src/bin/inari_mcp_stdio.rs`. The bundle ships both binaries; install snippets reference the sidecar path. The sidecar is ~165 LoC, depends only on `reqwest::blocking` + `serde_json`. Open question deferred from Session 1 (`ARCHITECTURE.md` § *Open questions deferred* item 1) is now resolved.

## 2026-04-29 — Sesión 7
Decision: `ask_inari` is **sampling-first** — Inari Live makes ZERO AI calls. The tool returns `{ "_sampling_request": { "messages", "system_prompt", "context", "model_preferences" } }` and the calling MCP client's LLM does the work.
Reason:   The hosted server's `ask_inari` is sampling-first for the same reason: MCP clients already have an LLM (Claude Code uses Anthropic, Cursor uses Anthropic / OpenAI / etc.) and an API budget. Forcing the server to make its own AI call duplicates spend, fragments the conversation history, and defeats the purpose of MCP's sampling protocol. Inari Live local mirrors hosted-server semantics so a developer asks "Why did this build break?" and gets the same UX whether they're prod-connected or local-only.
Impact:   `tools/local/ask_inari.rs` wraps daemon snapshot + the question into a sampling envelope. `sampling/createMessage` (the client's reply) is acknowledged today; Session 18 will optionally persist results to local memory. The `model_preferences` block hints `intelligencePriority: 0.6, speedPriority: 0.4` — clients that respect these will route to a Sonnet-class model rather than Haiku. NO `OpenAI` / `OPENAI_API_KEY` access from this tool ever.

## 2026-04-29 — Sesión 7
Decision: `inari_watcher.rs` content was restored from Session 5's commit (`59c68fc`) onto the Session 7 branch — purely as build infrastructure, with no Session 5 logic added on top.
Reason:   The Session 4 commit (`8cd301f`) is the Session 7 base per the prompt ("Stack on top of 8cd301f"). However, that commit's `lib.rs` references `mod inari_watcher;` while the file itself is *not* tracked at that commit (it was an untracked artifact from Session 0/pre-Session-1 that survived on disk). On a fresh checkout from `8cd301f`, the file is missing and the build fails. Session 5 was the first to commit `inari_watcher.rs`. We pull that exact content (byte-identical) so the build works. When Session 5 merges first, this becomes a clean fast-forward; when Session 7 merges first, Session 5's later refactor of the file lands as a normal commit on top.
Impact:   `inari_watcher.rs` is added to `git` on this branch. The content is identical to Session 5's version. Session 7 does NOT modify the file beyond the restore. The `feedback_no_breaking_changes` rule is upheld (no behavioural change). Documented here so future archaeologists understand the commit history.

## 2026-04-29 — Sesiones 5 + 7 (merge into integration branch)
Decision: During the S5+S7 merge, the duplicated direct `dirs = "5"` Cargo.toml entry from Sesión 7 was dropped (kept only as a transitive dep through Tauri internals). Sesión 7's `reqwest` `blocking` feature was preserved because `inari-mcp-stdio` uses `reqwest::blocking::Client`. The `axum` Cargo.lock entry for `inariwatch-desktop` was preserved.
Reason:   `dirs` was removed in Sesión 5 (above) on purpose; nothing under `desktop/src-tauri/` actually imports `dirs::*` (only docstrings reference it historically). Re-introducing the direct dep would silently undo Sesión 5 with no caller. The reqwest feature is real (`bin/inari_mcp_stdio.rs:50,77`) so it has to stay.
Impact:   `cargo tree -i dirs` continues to show `dirs` only as a transitive dependency through Tauri internals. Sidecar binary continues to compile because reqwest's `blocking` is enabled.

## 2026-04-29 — Sesión 6
Decision: Indexer **re-walks** the repo on `RepoIndexed` / `ReindexRequested` instead of consuming a path list from the FS sensor. The `WalkResult.paths` field added in `sensors/fs/walker.rs` is informational (and used by tests), not the bootstrap source.
Reason:   Option 1 (path-cache shared between FS sensor and indexer) couples two sensors that otherwise live behind a clean bus boundary. The FS sensor would need to know about the indexer's cache, or a third "PathCache" registry would need installing in `lib.rs` and wired into `spawn_fs_sensor`. Option 2 (re-walk in indexer) pays the IO twice but keeps each sensor self-contained — the indexer builds its own walker via the same `ignore::WalkBuilder` config. A 5k-file repo walks in ~150ms on the dev box, so the doubled cost is marginal next to the parse + embed phases.
Impact:   `crate::sensors::fs::watcher::walk_for_indexer(path)` is a `#[doc(hidden)]` re-export the indexer calls. `sensors/fs/walker.rs` gained one field (`paths: Vec<PathBuf>`) on `WalkResult` so future consumers (or richer tests) can read the walked set without re-walking. The two destructure patterns inside `watcher.rs` were updated to use `..` (no logic change).

## 2026-04-29 — Sesión 6
Decision: fastembed v4 model bundle is **deferred to Session 21** (release pipeline). v0.1 ships without an `.onnx` resource bundled — `fastembed::TextEmbedding::try_new` lazy-downloads the model on first call and caches under `<app_local_data_dir>/inari-live/models/`.
Reason:   Bundling a ~25MB ONNX file in the Tauri resources dir adds release-pipeline plumbing (signing, deltas) that isn't ready until Session 21+. Lazy-download keeps the v0.1 binary <60MB (the spec recap performance budget). Trade-off: first launch on an offline box leaves the indexer in "degraded mode" (symbols persist without embeddings; semantic search returns no hits). When network returns, a manual `reindex_codebase` re-embeds everything.
Impact:   `crate::indexer::embeddings::ensure_loaded` returns `IndexerError::ModelLoad` when offline; the indexer surfaces a `SensorWarning` so the dock can prompt the user. Symbols still flow into `code_symbols` (the parse path is offline-clean). When fastembed succeeds on a later attempt, the next `ReindexRequested` repopulates `code_embeddings`. Session 21 owns the resource-bundle work; the cache_dir indirection in `embeddings.rs` is the only knob it needs to flip.

## 2026-04-29 — Sesión 6
Decision: AST hash is `sha256(canonicalized_source_text)` where canonicalization trims trailing whitespace per line and joins with `\n`. Used as the "skip re-embed" oracle in `batcher::index_one_file`.
Reason:   The most common edit on save is "I added/removed a trailing space" or "the editor switched my line endings". Re-embedding on every save would mean a 64-symbol fastembed batch per keystroke for active files — completely defeats the perf budget. Canonicalizing whitespace before hashing makes pure-formatting saves a no-op for the embedder while keeping any real content change a guaranteed re-embed (the trim only removes trailing whitespace; internal spaces / indentation differences still hash differently).
Impact:   `crate::indexer::compute_ast_hash` is the canonical implementation. Tests in `tests/indexer_ast_hash_stable.rs` lock the contract: same source → same hash; CRLF↔LF → same hash; trailing whitespace → same hash; different bodies → different hash. A future Track 3 enrichment that wants hash-based change detection must use this function (don't roll a new one).

## 2026-04-29 — Sesión 6
Decision: fastembed `TextEmbedding` is a process-wide singleton (`OnceLock<Mutex<TextEmbedding>>`), inference is serialized by the mutex, and every call point goes through `tokio::task::spawn_blocking`.
Reason:   `TextEmbedding` is not `Sync` (ONNX session state). Spawning a fresh model per call burns ~1-3s on every embed (model load is the slow part). The singleton amortizes; the mutex serializes the few concurrent callers we have today (the indexer's bootstrap is single-threaded; semantic-search queries are rare). When concurrent throughput becomes a bottleneck (Session 13?), upgrade to a small worker pool of pre-loaded `TextEmbedding`s — the API stays the same, only `embed_batch` swaps its synchronization primitive.
Impact:   `crate::indexer::embeddings::ensure_loaded` is the explicit warm path; `embed_batch` / `embed_one` are the user-facing surface. Cache directory is overrideable via `set_cache_dir`; `lib.rs::setup` points it at `<app_local_data_dir>/inari-live/models/` so a clean uninstall removes the model.

## 2026-04-29 — Sesión 6
Decision: Batch policy: flush at 64 symbols OR after the bootstrap walk finishes. The `BATCH_FLUSH_WINDOW = 100ms` constant exists for the future incremental path but isn't wired today (incremental updates flush immediately because they're already small).
Reason:   64 matches `embeddings::MAX_BATCH_SIZE` and is the empirical sweet spot fastembed targets. Larger batches don't help because the model's per-call overhead is dominated by tokenization. Smaller batches under-utilize the rayon pool fastembed uses internally. The 100ms time-flush window reserves the ability to coalesce bursts later without forcing a callsite change.
Impact:   `crate::indexer::batcher::PendingBatch` flushes inline when it hits 64. The window constant is documented but unused; CI (and human reviewers) shouldn't flag it as dead until the window-driven flusher lands. Session 13 (memory layer glue) is the natural place to add it.

## 2026-04-29 — Sesión 6 (build infrastructure)
Decision: Session 6 reports MSVC toolchain mismatch as a Session-8-blocker rather than downgrading fastembed in this session.
Reason:   `cargo check --lib --tests` is clean — the indexer code is correct. The blocker is environmental: `ort 2.0.0-rc.9` (fastembed v4's native dep) emits modern STL intrinsics (`__std_min_element_*`, `__std_max_element_*`, `__std_find_trivial_*`, etc.) that older MSVC C++ runtimes lack. 24 LNK2019/LNK2001 unresolved externals at link time. Downgrading fastembed to the v3 line works around this but requires API-churn in `embeddings.rs` (different `TextEmbedding::try_new` shape) — and would silently lock us out of v4-only model upgrades. Updating MSVC (the OTHER fix) is a one-time host setup that benefits every future Rust build. Per the prompt's "report blocker concreto antes de continuar" guidance, the right move was to ship the code with the recommended path documented and let the next session pick the unblock strategy.
Impact:   Session 8's first action is one of: (a) install VS 2022 17.5+ "Desktop development with C++" workload + re-run deferred tests, or (b) pin `fastembed = "3"` and rewrite `embeddings.rs::ensure_loaded` against the v3 API. Path (a) is recommended. The HANDOFF block for Session 6 enumerates the deferred test list so Session 8 can run them as a precondition before its own work.

## 2026-04-30 — Sesión 8
Decision: The git-hook callback channel uses a SEPARATE `git_hook_token` (`gh_<uuid hex>`, 35 chars) — NOT the MCP Bearer (`ilive_…`).
Reason:   A leak via `git checkout` of a colleague's branch (which embeds the token in `.git/hooks/*` scripts) must NOT also grant MCP-tool access. Two tokens = two blast radii. Rotating `git_hook_token` invalidates hooks across all opted-in repos in one shot without touching editor agents (Claude Code / Codex / Cursor / Zed) that hold the MCP Bearer.
Impact:   `desktop/src-tauri/src/sensors/git/token.rs` owns the lifecycle; persisted at `<state_dir>/git_hook_token` with mode 0600 on Unix. `sensors/mcp/auth.rs` (`AuthState`/`McpAuth`) is untouched. Two separate verify functions (`hooks::verify_bearer` for the hook token; `transport_http::verify_bearer` for `auth.validate(...)`).

## 2026-04-30 — Sesión 8
Decision: Pre-push hook is **fail-OPEN** on daemon unreachable / 30s timeout — `exit 0` so the push proceeds.
Reason:   A stopped daemon (laptop sleep, dock killed, port shifted) must not strand the user mid-push. The cost of a missed gate run on a single push is much smaller than the cost of "Inari Live broke my git push" complaints. Real-world shape mirrors how `husky`/`lefthook` handle daemon-mode failures.
Impact:   `resources/hooks/pre-push.sh` checks `HTTP_STATUS == "000"` (curl exit on connection failure) and exits 0 silently. Only an explicit `{"allow": false}` from a reachable daemon blocks the push. `INARI_BYPASS=1` remains the documented manual override.

## 2026-04-30 — Sesión 8
Decision: Local pre-push gate runner ships a SUBSET of the 17 web gates this session — Gate 1 (`auto_merge_enabled`) and Gate 4 (`lines_changed ≤ max`) are real; Gates 5 / 6 / 9 are scaffolded but return `deferred` verdicts.
Reason:   Gate 1 is a SQL settings read; Gate 4 is one integer comparison from the hook payload (`diff_size`). Gate 5 needs the AI self-review (S19), Gate 6 needs Substrate replay (S10), Gate 9 needs the regex security scanner (S20). Wiring them today would either ship dead code or partial behaviour. Returning structured `deferred` verdicts gives Session 20 a clean attach point.
Impact:   `sensors/git/gate.rs::GateVerdict { name, passed, deferred, reason }` carries a `deferred: bool` flag for advisory-style UI rendering. Gate 5/6/9 implementations are one-function swaps in `gate.rs::evaluate` — see HANDOFF block "Notes for Session 20".

## 2026-04-30 — Sesión 8
Decision: A pre-existing user hook at `.git/hooks/<name>` is moved to `.git/hooks/<name>.inari-backup` (single fixed suffix) — never timestamped, never deleted.
Reason:   Only ONE backup ever lives next to a hook. If the user re-installs Inari Live, we recognise our own marker line `# Inari Live — ` and overwrite without backup; if they install AGAIN over a backup that already exists, we keep the existing backup (the user's pre-Inari content) and just refresh the live hook. Uninstall restores the backup. Shell scripts cannot be merged like JSON, so a fixed suffix avoids `<hook>.inari-backup-1`/`-2`/`-3` debris.
Impact:   `installer.rs::BACKUP_SUFFIX = "inari-backup"`. `INARI_MARKER` is the heuristic for "this hook is ours" — present only inside templates we generate. User hooks without the marker are safe.

## 2026-04-30 — Sesión 8
Decision: The git sensor uses `axum::Router::merge` to mount `/sensors/git/event` onto Sesión 7's listener — NOT a second listener on a different port.
Reason:   Two listeners means port-fallback logic duplicated, two Bearer-tree behaviours to teach the user, two firewall holes to punch on Windows Defender. `Router::merge` is the supported axum path to share a listener across modules.
Impact:   `transport_http::serve_with_extras(state, requested, extras: Vec<Router>)` is the new entry point; the existing `serve` delegates with `extras = vec![]` so the Sesión 7 contract is unchanged. `spawn_mcp_server_with_extras` does the same upstream. `lib.rs::setup` builds the git router synchronously (token + state dir resolution is fast) and passes it as the only extra.

## 2026-05-01 — Sesión 11-finish
Decision: `MemoryKind` is a `daemon`-level enum with three variants (`Initial`, `Append`, `Replace`), and the `kind` field of `DaemonEvent::MemoryReviewRequested` uses `#[serde(rename = "review_kind")]` on the wire.
Reason:   The architect prompt specified `{ Append, Replace }` but the existing memory watcher emits an "initial" case for the first-write of `memory.md` that doesn't fit either bucket — modeling it as `Append` would erase the distinction the dock UI needs (initial seed vs. ongoing edit). Adding `Initial` keeps the spec-suggested vocabulary while honestly describing the watcher's behaviour. The serde rename mirrors the workaround `FsChange::kind`/`change` already established (Sesión 5) — `DaemonEvent` is internally-tagged on `"kind"`, so a variant field of the same name is rejected at compile time.
Impact:   `daemon/mod.rs` exposes `MemoryKind` at crate root via the existing `pub use` block; the JSON wire shape is `{"kind":"memory_review_requested","repo_id":"...","review_kind":"initial"}`. Locked in `memory_md_review_event_emitted.rs` so a future serde refactor can't silently break the dock.

## 2026-05-01 — Sesión 11-finish
Decision: `src/fingerprint.rs` is relocated to `src/memory/fingerprint.rs` and re-exposed at `crate::fingerprint` via `pub use memory::fingerprint;` in `lib.rs` (NOT moved with import-site updates).
Reason:   The original orphan `mod fingerprint;` in `lib.rs` referenced a file that was never present on this branch (build was broken at `e7fa1a0`). The Sesión 1 plan calls for the move into `memory/`, and `inari_watcher.rs` (out of scope for this session per the executor prompt's allowed-files list) still uses `crate::fingerprint::compute_error_fingerprint`. Re-exporting under the legacy crate-root name keeps that consumer building until Sesión 10 splits the watcher, with zero algorithm change.
Impact:   `memory/fingerprint.rs` is the canonical home; `crate::fingerprint::*` is a temporary alias. Drop the re-export at the end of Sesión 10 along with the `mod inari_watcher;` line, after the watcher is split into `sensors/fs/` + `sensors/substrate/` + `memory/procedural/`. Algorithm verified byte-equivalent with `cli/src/mcp/fingerprint.rs` and `web/lib/ai/fingerprint.ts` (tests in `memory/fingerprint.rs::tests`).

## 2026-05-01 — Sesión 11-finish
Decision: `wipe_memory` deletes only the SQL audit trail (`memory_md_versions`); the on-disk `memory.md` is preserved.
Reason:   Per the dock spec ("Wipe memory") — humans authored the markdown content, so the wipe affordance must not nuke their work. The audit trail is Inari's internal history; if the user wants to start over, they can delete `.inari/memory.md` themselves with their editor.
Impact:   `queries::wipe_memory_md_versions` returns the row count actually removed. The IPC `wipe_memory` command is a thin pass-through. Locked in `memory_md_wipe_clears_table.rs::wipe_does_not_touch_memory_md_on_disk`.

## 2026-05-01 — Sesión 8-tests-finish
Decision: Stop after the first test-run link failure rather than iterate the remaining six tests; do NOT make `fastembed`/indexer feature-gated to dodge the link step.
Reason:   The blocker is environmental, not a code defect — `cargo check --lib` and `cargo check --lib --tests` are both clean. Every integration test under `desktop/src-tauri/tests/git_hook*.rs` and `git_hooks_*.rs` links the same `inariwatch_desktop_lib.dll`, which transitively pulls `ort 2.0.0-rc.9`. With Visual Studio 2019 as the only installed MSVC, the linker fails on 24 LNK2019/LNK2001 unresolved externals (`__std_max_element_*`, `__std_find_trivial_*`, `__std_DOUBLE_POW5_*`, `_General_precision_tables_2<*>`) — symbols introduced in VS 2022 17.5+ MSVC STL. Running the other six tests would burn build minutes producing the identical failure. Adding a `cfg(not(test))` / feature gate to exclude `fastembed` from the test build was rejected because (a) it would silently change the binary the prod build links against, and (b) the indexer integration tests (Sesión 6) need the lib intact too — feature-gating just relocates the same wall.
Impact:   The 7 integration tests are validated as compile-clean (`cargo check --lib --tests`, 34s) but are recorded as **un-executed** until VS 2022 Build Tools ≥ 17.5 is installed on the host. This matches the recommendation Sesión 6 already made (`INARI_LIVE_DECISIONS.md:234-236`). Resume command set is documented in the HANDOFF "Tests run 2026-05-01" block. The baseline fix (`c5c206a`) lands either way because S8's lib otherwise won't `cargo check`.
