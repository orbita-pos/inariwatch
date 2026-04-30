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
