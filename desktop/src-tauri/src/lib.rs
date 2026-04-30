use std::sync::Arc;

use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

// Pre-Session-2 modules still owned by their named sessions:
// - `fingerprint` moves to `memory/fingerprint.rs` (Session 11)
// - `inari_watcher` is split across Sessions 5/10/12; deleted end of S10
// - `local_ingest` moves to `sensors/substrate/local_ingest.rs` (Session 10)
mod fingerprint;
mod inari_watcher;
mod local_ingest;

// Session 2 — daemon core + window helpers.
pub mod daemon;
mod window;

// Session 3 — local store. `pub` for the same reason as `daemon`:
// integration tests in `tests/` exercise migrations/PRAGMAs/sqlite-vec.
pub mod store;

// Session 4 — cloud / IPC / AI cloud-proxy shells / cli runner.
pub mod cloud;
pub mod ipc;
mod ai;
mod cli;

// Empty skeletons created in Session 2; filled in by their owning sessions.
mod gates;
mod indexer;
mod memory;
pub mod sensors;
mod telemetry;
mod updater;

const INARI_WINDOW_LABEL: &str = "inari";

// ── Entry ─────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        window::dock::toggle_dock(app);
                    }
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
            // Cloud-proxied autofix (renamed from autofix.rs)
            ai::remediate::cloud_proxy::desktop_autofix_start,
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

            // Local Capture ingest server on 127.0.0.1:9111. Receives
            // events from the user's spawned dev server (Method 5
            // zero-install dev mode) and forwards them as
            // `inari:live-error` to the dock.
            local_ingest::start(app.handle().clone());
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
    #[cfg(target_os = "macos")]
    let modifier = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let modifier = Modifiers::CONTROL;

    let shortcut = Shortcut::new(Some(modifier), Code::Space);

    if let Err(e) = app.global_shortcut().register(shortcut) {
        tracing::warn!(error = %e, "failed to register global shortcut Cmd/Ctrl+Space");
    } else {
        tracing::info!("registered global shortcut Cmd/Ctrl+Space → toggle dock");
    }
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
