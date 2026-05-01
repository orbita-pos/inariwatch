use std::sync::Arc;

use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_notification::NotificationExt;

// Pre-Session-2 modules still owned by their named sessions:
// - `fingerprint` HAS MOVED to `memory/fingerprint.rs` (Session 11). Kept
//   exposed at `crate::fingerprint` via the re-export below so legacy
//   call-sites in `inari_watcher.rs` keep resolving until Session 10 splits
//   that file. Once the split lands, drop the re-export and move callers.
// - `inari_watcher` is split across Sessions 5/10/12; deleted end of S10.
// - `local_ingest` HAS MOVED to `sensors/substrate/local_ingest.rs`
//   (Session 10). Its previous `start()` boot-up call from this file is
//   removed; the new home owns its own spawn site.
mod inari_watcher;

// Session 2 — daemon core + window helpers.
pub mod daemon;
// `pub` so the Session 14 integration tests in `tests/window_*` can
// reach `crate::window::dock::*` / `window::main::*` /
// `window::shortcuts::{resolve, ShortcutAction}`. Same precedent as
// `daemon` (S2), `store` (S3), `sensors` (S5/S7), `indexer` (S6).
pub mod window;

// Session 3 — local store. `pub` for the same reason as `daemon`:
// integration tests in `tests/` exercise migrations/PRAGMAs/sqlite-vec.
pub mod store;

// Session 4 — cloud / IPC / AI cloud-proxy shells / cli runner.
pub mod cloud;
pub mod ipc;
// `pub` so Sesión 18 integration tests in `tests/openai_*`,
// `tests/budget_*`, and `tests/prompts_parity` can reach
// `crate::ai::{openai, budget, prompts}`. Same precedent as `daemon`,
// `store`, `sensors`, `indexer`, `cli`.
pub mod ai;
// `pub` so integration tests in `tests/substrate_*` can reach
// `crate::cli::run::{prepare_inari_run, ...}` for Sesión 10. Same
// precedent as `daemon` (S2), `store` (S3), `sensors` (S5/S7/S10).
pub mod cli;

// Sesión 20 — local-subset gate runner (Gates 5, 6, 9). `pub` so the
// integration tests in `tests/gate_runner_*` and `tests/pre_push_*`
// can reach `crate::gates::{run_local_subset, GateRunInput, ...}`.
pub mod gates;
// `pub` so integration tests in `tests/indexer_*` can reach
// `crate::indexer::{parser, semantic, Lang, ...}`. Same precedent as
// `daemon` (S2), `store` (S3), `sensors` (S5/S7).
pub mod indexer;
// `pub` so integration tests in `tests/memory_md_*` (Session 11) can
// reach `crate::memory::declarative::{ensure_memory_md, ...}`. Same
// precedent as `daemon` (S2), `store` (S3), `indexer` (S6),
// `sensors` (S5/S7).
pub mod memory;
// `pub` so integration tests in `tests/fs_*` and `tests/mcp_*` can drive
// the FS sensor actor and mount the MCP axum router. Same precedent as
// `daemon` (Sesión 2) and `store` (Sesión 3).
pub mod sensors;
mod telemetry;
mod updater;

// Re-export of the relocated fingerprint module so the literal path
// `crate::fingerprint::*` keeps resolving for `inari_watcher.rs` (out of
// scope for Session 11's edits). Drop after Session 10 splits the watcher.
pub use memory::fingerprint;

const INARI_WINDOW_LABEL: &str = "inari";

// ── Entry ─────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        // .plugin(tauri_plugin_updater::Builder::new().build()) // disabled for dogfood — needs plugins.updater config
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Session 14 — fan out fired shortcuts via window::shortcuts::handle_event.
                .with_handler(|app, shortcut, event| {
                    window::shortcuts::handle_event(app, shortcut, event.state());
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            // Session 4 — IPC core
            ipc::commands::daemon_status,
            ipc::commands::list_repos,
            ipc::commands::open_repo,
            ipc::commands::close_repo,
            ipc::commands::get_logs,
            // Auth (renamed from desktop_auth.rs)
            ipc::auth::desktop_auth_start,
            ipc::auth::desktop_auth_poll,
            ipc::auth::desktop_auth_status,
            // Onboarding (renamed from onboarding.rs)
            ipc::onboarding::desktop_first_run_status,
            ipc::onboarding::desktop_pick_watch_dir,
            ipc::onboarding::desktop_save_watch_dir,
            // Settings (renamed from settings.rs)
            ipc::settings::desktop_get_settings,
            ipc::settings::desktop_save_settings,
            ipc::settings::desktop_logout,
            ipc::settings::desktop_open_settings,
            ipc::settings::desktop_app_version,
            // Saves (renamed from saves.rs)
            ipc::saves::desktop_get_saves_summary,
            // Connect (renamed from connect.rs)
            ipc::connect::desktop_connect_project,
            ipc::connect::desktop_disconnect_project,
            ipc::connect::desktop_connect_status,
            // Cloud-proxied autofix (Sesión 4 — renamed from autofix.rs;
            // module renamed cloud_proxy → proxy in Sesión 19)
            ai::remediate::proxy::desktop_autofix_start,
            // Session 7 — local MCP server controls
            ipc::mcp::get_mcp_token,
            ipc::mcp::regenerate_mcp_token,
            ipc::mcp::install_mcp_for,
            ipc::mcp::uninstall_mcp_for,
            ipc::mcp::list_mcp_clients_status,
            // Session 11 — declarative memory (memory.md lifecycle)
            ipc::memory::read_memory_md,
            ipc::memory::propose_memory_md_update,
            ipc::memory::commit_memory_md,
            ipc::memory::get_context_stack,
            ipc::memory::wipe_memory,
            // Session 8 — git hook installer + status
            ipc::git::install_git_hooks,
            ipc::git::uninstall_git_hooks,
            ipc::git::git_hooks_status,
            ipc::git::get_git_hook_token,
            // Sesión 17 — settings (general / notifications / ai / privacy / about / repos)
            ipc::settings::get_general_settings,
            ipc::settings::set_general_settings,
            ipc::settings::get_notifications_settings,
            ipc::settings::set_notifications_settings,
            ipc::settings::get_ai_settings,
            ipc::settings::set_ai_settings,
            ipc::settings::get_privacy_settings,
            ipc::settings::set_privacy_settings,
            ipc::settings::get_about_info,
            ipc::settings::set_release_channel,
            ipc::settings::check_for_updates,
            ipc::settings::get_repos_list,
            ipc::settings::wipe_repo_memory,
            // Sesión 17 — onboarding flow
            ipc::onboarding::onboarding_open_repo,
            ipc::onboarding::onboarding_progress,
            ipc::onboarding::complete_onboarding,
            ipc::onboarding::is_onboarded,
            // Sesión 17 — window navigation
            ipc::window::open_main_window,
            ipc::window::hide_dock,
            ipc::window::navigate,
            // Sesión 18 — chat streaming
            ipc::chat::start_chat_stream,
            // Sesión 19 — local remediation pipeline
            ipc::remediation::start_remediation,
            ipc::remediation::apply_remediation,
            ipc::remediation::reject_remediation,
            ipc::remediation::get_remediation_session_cmd,
            // Sesión 20 — pre-push gate runner UI surface
            ipc::gates::get_recent_gate_runs,
            ipc::gates::request_bypass,
            // Sesión 17 — sensor toggles + power-up stubs
            ipc::sensors::get_sensors_state,
            ipc::sensors::set_sensor_enabled,
            ipc::sensors::shell_hooks_status,
            ipc::sensors::install_shell_hooks,
            ipc::sensors::uninstall_shell_hooks,
            ipc::sensors::get_replay_enabled,
            ipc::sensors::set_replay_enabled,
            ipc::sensors::install_vscode_extension,
            ipc::sensors::configure_http_proxy,
        ])
        .setup(|app| {
            // Tracing: rotating file appender at app_log_dir + 7-day
            // retention. Stored in State so the WorkerGuard lives as
            // long as the app (drop = lose tail-end logs).
            if let Some(guard) = init_tracing(&app.handle()) {
                app.manage(LoggingGuard(guard));
            }

            // Session 3 — local SQLite store. Migrations run synchronously
            // here (fail-fast). Session 4 — `store::install` also runs the
            // one-shot legacy TOML → SQL settings migration so the
            // SQL-backed command surface sees existing user data on first
            // post-Session-4 boot.
            let store = match store::install(&app.handle()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "store init failed");
                    return Err(Box::new(e) as Box<dyn std::error::Error>);
                }
            };

            // Daemon: heartbeat every 30s, graceful shutdown drain 5s.
            let daemon_handle = Arc::new(daemon::start_daemon());
            app.manage(daemon_handle.clone());

            // Session 4 — wire the Bus → Tauri-event bridges. `daemon:event`
            // forwards every bus event 1:1; `daemon:status_changed` is
            // debounced to a 1s cadence with PartialEq dedup.
            ipc::events::start(app.handle().clone(), daemon_handle.clone());

            // Session 5 — Sensor 1 (FS watcher). The actor increments
            // `sensor_count` on spawn and decrements on Shutdown drain.
            // The handle is kept in tauri State so `open_repo` /
            // `close_repo` IPC commands attach/detach watchers per repo.
            let fs_sensor = sensors::fs::spawn_fs_sensor(
                daemon_handle.bus.clone(),
                daemon_handle.state.clone(),
            );
            app.manage(fs_sensor);

            // Session 7 — local MCP server (axum + JSON-RPC 2.0 on
            // 127.0.0.1:9876 with port fallback). Spawned async so the
            // Bearer token + chosen port are ready before the dock asks
            // the user "wire into your editor?". Bind failure is a soft
            // error: we log + continue without MCP (rather than blocking
            // the rest of startup) so the app still launches even on an
            // aggressively-firewalled box.
            //
            // Session 8 — git sensor mounts `/sensors/git/event` on the
            // same listener via `axum::Router::merge`. Token is loaded
            // from `<state_dir>/git_hook_token` (separate from the MCP
            // Bearer per the Session-8 token-separation decision).
            {
                let app_handle   = app.handle().clone();
                let daemon_clone = daemon_handle.clone();
                let store_clone  = store.clone();
                tauri::async_runtime::spawn(async move {
                    let git_router = match sensors::git::resolve_state_dir(&app_handle) {
                        Ok(state_dir) => match sensors::git::token::ensure_token(&state_dir) {
                            Ok(token) => {
                                // Sesión 20 — wire an OpenAI client into the
                                // hook state so Gate 5 (self-review) can run
                                // when the user has a key configured. Falls
                                // back to None silently when there's no key,
                                // making Gate 5 surface as `deferred`
                                // (push proceeds — the user can configure
                                // a key from Settings).
                                let openai = ai::openai::OpenAIClient::from_store(&store_clone).ok();
                                let hook_state = sensors::git::hooks::GitHookState {
                                    daemon: daemon_clone.clone(),
                                    store:  store_clone.clone(),
                                    token,
                                    openai,
                                };
                                Some(sensors::git::hooks::router(hook_state))
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "git_hook_token init failed");
                                None
                            }
                        },
                        Err(e) => {
                            tracing::warn!(error = %e, "git sensor state dir resolution failed");
                            None
                        }
                    };
                    let extras: Vec<axum::Router> = git_router.into_iter().collect();

                    match sensors::mcp::spawn_mcp_server_with_extras(
                        &app_handle,
                        daemon_clone.clone(),
                        store_clone.clone(),
                        extras,
                    ).await {
                        Ok(handle) => {
                            tracing::info!(
                                port = handle.port,
                                "MCP server ready"
                            );
                            app_handle.manage(std::sync::Arc::new(handle));
                            // Session 8 — bookkeeping task for the git
                            // sensor. The HTTP work runs on the MCP
                            // listener; this task only owns inc/dec
                            // sensor count + shutdown drain.
                            let _git_handle = sensors::git::spawn_git_sensor(
                                daemon_clone,
                                store_clone,
                            );
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "MCP server failed to start");
                        }
                    }
                });
            }

            // Session 6 — indexer. Subscribes to the daemon bus and
            // bootstraps embeddings on `RepoIndexed`, re-indexes on
            // `FsChange`, full re-walk on `ReindexRequested`. The
            // fastembed model cache lives under the same
            // `<app_local_data_dir>/inari-live/` tree the store + auth
            // files live under, so a clean uninstall removes it.
            if let Ok(local_dir) = app.path().app_local_data_dir() {
                indexer::set_cache_dir(local_dir.join("inari-live").join("models"));
            }
            let _indexer_handle = indexer::spawn_indexer(
                daemon_handle.clone(),
                store.clone(),
            );

            // Session 11 — declarative memory watcher. Subscribes to the
            // daemon bus for `RepoIndexed` (writes initial template) and
            // `MemoryReviewApproved` (records merge versions). The
            // returned handle is intentionally dropped here — the
            // watcher thread keeps itself alive via a channel
            // subscription and exits on `DaemonEvent::Shutdown`.
            let _memory_watcher = memory::declarative::spawn_memory_watcher(
                daemon_handle.clone(),
                store.clone(),
            );

            // Sesión 13 — episodic memory persister + retention runner.
            // The persister subscribes to the bus and writes the
            // persistable subset of `DaemonEvent` to the `events`
            // table; the retention runner ticks once an hour and drops
            // rows past their per-kind TTL (fs_change/shell_event/...
            // = 30 days; git_event = infinite). Both handles are
            // dropped here on purpose — the persister exits on
            // `Shutdown`, the retention runner exits when the runtime
            // is torn down at process exit. Retention's startup tick
            // is suppressed so first-launch boot doesn't pay an extra
            // DB write before any rows have aged out.
            let _episodic_persister = memory::episodic::spawn_event_persister(
                daemon_handle.clone(),
                store.clone(),
            );
            let _retention_runner = memory::retention::spawn_retention_runner(
                store.clone(),
            );

            // Sesión 12 — procedural learner. Subscribes to
            // `RemediationCompleted` + `FixRejected`, joins through
            // `remediation_sessions` for `(repo_id, fingerprint)`, and
            // updates `<repo_root>/.inari/patterns.json`. Emits
            // `PatternLearned` / `PatternDemoted` for the audit
            // trail. Spawned AFTER the episodic persister so the
            // `PatternLearned` / `PatternDemoted` events the learner
            // emits are picked up by the persister (subscribers see
            // events published AFTER subscription, so out-of-order
            // spawns risk dropped audit rows).
            let _pattern_learner = memory::procedural::spawn_pattern_learner(
                daemon_handle.clone(),
                store.clone(),
            );

            // Session 9 — Sensor 2 (shell hooks). Opens the per-platform
            // local socket (`~/.inari/sock/shell.sock` on Unix,
            // `\\.\pipe\inari-live-shell` on Windows). The listener is
            // harmless when no hooks are installed — no clients connect
            // and the bus gets no `ShellEvent`s. Bind failure (no
            // `$HOME`, permission denied, stale socket the
            // `try_overwrite` couldn't reclaim) logs at `warn` and
            // decrements `sensor_count`; rest of startup proceeds.
            let _shell_handle = sensors::shell::spawn(
                daemon_handle.clone(),
                store.clone(),
            );

            // Session 10 — Sensor 6 (Substrate replay correlation).
            // Subscribes to `FsChange::Modified` and asks the resolved
            // backend (local binary preferred, remote `/v2/replay`
            // fallback) whether the change preserves the recorded
            // behaviour of the most-recent `.inari/recordings/<id>/`.
            // The actor runs INERT when no backend is reachable — the
            // bus subscription stays alive (so `sensor_count` reports
            // honestly) but never publishes a `ReplayResult`. Per-repo
            // opt-in via the `replay_enabled` flag (migration 0004,
            // default OFF) means this sensor is silent for every repo
            // already in the user's store on upgrade. Track 2 closer.
            let _substrate_handle = sensors::substrate::spawn(
                daemon_handle.clone(),
                store.clone(),
            );

            setup_window(app)?;
            setup_tray(app, daemon_handle.clone())?;

            // Global shortcut: Cmd+Space (Mac) / Ctrl+Space (Win/Linux)
            // toggles the dock window.
            register_global_shortcut(&app.handle());

            // ConnectState carries the spawned dev-server child so we can
            // kill it on disconnect / second connect.
            app.manage(Arc::new(cli::run::ConnectState::default()));

            // Auto-open Inari Live on startup so the floating fox is the
            // ambient signal — closing it just hides; reopen via tray menu.
            open_inari_window(&app.handle().clone());

            // Background alert poller (extracted to cloud/alert_poller.rs).
            cloud::alert_poller::start(app.handle().clone(), store.clone());

            // FS watcher + replay dispatcher. Session 5/10 owns the rewrite.
            inari_watcher::start(app.handle().clone());

            // Local Capture ingest server (was `local_ingest::start`)
            // moves to `sensors/substrate/local_ingest.rs` (Session 10).
            // No spawn site here until that owner ships.
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray instead of closing
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error running InariWatch");
}

// ── Window ────────────────────────────────────────────────────────────────────

fn setup_window(app: &tauri::App) -> tauri::Result<()> {
    let url = if cfg!(debug_assertions) {
        WebviewUrl::External("http://localhost:3000".parse().unwrap())
    } else {
        // Read api_url from the SQL settings store, fall back to production.
        let store = app.state::<Arc<store::Store>>();
        let raw = store::settings::get(&store, "api_url")
            .ok()
            .flatten()
            .unwrap_or_else(|| cloud::api::DEFAULT_API_URL.to_string());
        WebviewUrl::External(raw.parse().expect("invalid api_url in settings"))
    };

    WebviewWindowBuilder::new(app, "main", url)
        .title("InariWatch")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .visible(true)
        .build()?;

    Ok(())
}

// ── Inari Live window ─────────────────────────────────────────────────────────

fn open_inari_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(INARI_WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let result = WebviewWindowBuilder::new(
        app,
        INARI_WINDOW_LABEL,
        WebviewUrl::App("inari/index.html".into()),
    )
        .title("Inari Live")
        .inner_size(480.0, 640.0)
        .min_inner_size(420.0, 560.0)
        .max_inner_size(720.0, 960.0)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .resizable(true)
        .visible(true)
        .build();

    if let Err(e) = result {
        eprintln!("[inari-live] failed to open window: {}", e);
    }
}

// ── System tray ───────────────────────────────────────────────────────────────

fn setup_tray(app: &tauri::App, daemon: Arc<daemon::DaemonHandle>) -> tauri::Result<()> {
    let open      = MenuItem::with_id(app, "open",      "Open InariWatch",      true, None::<&str>)?;
    let inari     = MenuItem::with_id(app, "inari",     "Open Inari Live",      true, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Open dashboard…",      true, None::<&str>)?;
    let sep1      = PredefinedMenuItem::separator(app)?;
    let pause_label = if inari_watcher::is_paused() { "Resume watch" } else { "Pause watch" };
    let pause     = MenuItem::with_id(app, "pause",     pause_label,            true, None::<&str>)?;
    let pause_sensors = MenuItem::with_id(app, "pause_sensors", "Pause sensors", true, None::<&str>)?;
    let settings  = MenuItem::with_id(app, "settings",  "Settings…",            true, None::<&str>)?;
    let sep2      = PredefinedMenuItem::separator(app)?;
    let quit      = MenuItem::with_id(app, "quit",      "Quit",                 true, None::<&str>)?;
    let menu      = Menu::with_items(
        app,
        &[&open, &inari, &dashboard, &sep1, &pause, &pause_sensors, &settings, &sep2, &quit],
    )?;
    let pause_handle = pause.clone();
    let daemon_for_quit = daemon.clone();

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("InariWatch — developer monitor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open"      => show_main_window(app),
            "inari"     => open_inari_window(app),
            "dashboard" => open_dashboard(app),
            "pause"     => {
                let now_paused = !inari_watcher::is_paused();
                inari_watcher::set_paused(now_paused);
                let _ = pause_handle
                    .set_text(if now_paused { "Resume watch" } else { "Pause watch" });
                let body = if now_paused {
                    "File watcher paused. Saves won't trigger replays until you resume."
                } else {
                    "File watcher resumed."
                };
                let _ = app
                    .notification()
                    .builder()
                    .title("Inari Live")
                    .body(body)
                    .show();
            }
            "pause_sensors" => {
                tracing::info!("tray: 'Pause sensors' clicked (no-op stub — Session 5+)");
            }
            "settings"  => { let _ = window::settings::open(app); }
            "quit"      => {
                daemon_for_quit.shutdown();
                app.exit(0);
            }
            _           => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button:       MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// ── Tracing init ──────────────────────────────────────────────────────────────

/// RAII guard so the non-blocking writer keeps flushing while the app
/// is alive. Held in tauri State — dropped only at process exit.
#[allow(dead_code)]
struct LoggingGuard(tracing_appender::non_blocking::WorkerGuard);

fn init_tracing(app: &AppHandle) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let log_dir = match app.path().app_log_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[inari-live] could not resolve app_log_dir: {e}");
            return None;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("[inari-live] could not create log dir {}: {e}", log_dir.display());
        return None;
    }

    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("inari-live")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&log_dir)
        .ok()?;

    let (non_blocking, guard) = tracing_appender::non_blocking(appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_env("INARI_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .try_init();

    tracing::info!(
        log_dir = %log_dir.display(),
        "tracing initialized"
    );

    Some(guard)
}

// ── Global shortcut ───────────────────────────────────────────────────────────

fn register_global_shortcut(app: &AppHandle) {
    // Session 14 — dispatch table lives in window::shortcuts::register.
    let count = window::shortcuts::register(app);
    tracing::info!(count, "registered global shortcuts");
}

#[allow(dead_code)]
fn _silence_unused_shortcut_state() {
    // Keep ShortcutState in scope for the plugin handler.
    let _ = ShortcutState::Pressed;
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Open the user's InariWatch dashboard in their default browser. Reads
/// `dashboard_url` from the SQL settings store; falls back to production
/// for users who haven't connected yet.
fn open_dashboard(app: &AppHandle) {
    let store = app.state::<Arc<store::Store>>();
    let base = store::settings::get(&store, "dashboard_url")
        .ok()
        .flatten()
        .or_else(|| store::settings::get(&store, "api_url").ok().flatten())
        .unwrap_or_else(|| cloud::api::DEFAULT_API_URL.to_string());
    let url = format!("{}/dashboard", base.trim_end_matches('/'));
    let _ = open_in_browser(&url);
}

fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no opener"))
}
