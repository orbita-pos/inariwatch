use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

// Existing scaffold modules (Session 0 — to be re-homed by their owning
// sessions per ARCHITECTURE.md migration plan).
mod autofix;
mod connect;
mod desktop_auth;
mod fingerprint;
mod inari_watcher;
mod local_ingest;
mod onboarding;
mod saves;
mod settings;

// Session 2 — daemon core + window helpers. `daemon` is `pub` so the
// integration tests in `tests/` can drive the lifecycle loop directly.
pub mod daemon;
mod window;

// Empty skeletons created in Session 2; filled in by their owning sessions.
mod ai;
mod cli;
mod cloud;
mod gates;
mod indexer;
mod ipc;
mod memory;
mod sensors;
mod store;
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
            desktop_auth::desktop_auth_start,
            desktop_auth::desktop_auth_poll,
            desktop_auth::desktop_auth_status,
            autofix::desktop_autofix_start,
            onboarding::desktop_first_run_status,
            onboarding::desktop_pick_watch_dir,
            onboarding::desktop_save_watch_dir,
            settings::desktop_get_settings,
            settings::desktop_save_settings,
            settings::desktop_logout,
            settings::desktop_open_settings,
            settings::desktop_app_version,
            saves::desktop_get_saves_summary,
            connect::desktop_connect_project,
            connect::desktop_disconnect_project,
            connect::desktop_connect_status,
        ])
        .setup(|app| {
            // Tracing: rotating file appender at app_log_dir + 7-day
            // retention. Stored in State so the WorkerGuard lives as
            // long as the app (drop = lose tail-end logs).
            if let Some(guard) = init_tracing(&app.handle()) {
                app.manage(LoggingGuard(guard));
            }

            // Daemon: heartbeat every 30s, graceful shutdown drain 5s.
            // Stored as Arc<DaemonHandle> so on_window_event can clone
            // it for the close-requested signal.
            let daemon_handle = Arc::new(daemon::start_daemon());
            app.manage(daemon_handle.clone());

            setup_window(app)?;
            setup_tray(app, daemon_handle.clone())?;

            // Global shortcut: Cmd+Space (Mac) / Ctrl+Space (Win/Linux)
            // toggles the dock window. Plugin already registered on the
            // Builder; here we register the actual key combo.
            register_global_shortcut(&app.handle());

            // ConnectState carries the spawned dev-server child so we can
            // kill it on disconnect / second connect. Registered early so
            // the Tauri command handlers can `State::<Arc<…>>::get` it.
            app.manage(Arc::new(connect::ConnectState::default()));
            // Auto-open Inari Live on startup so the floating fox is the
            // ambient signal — closing it just hides; reopen via tray menu.
            open_inari_window(&app.handle().clone());
            start_alert_poller(app.handle().clone());
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
        // Read api_url from desktop config, fall back to production
        let config = read_desktop_config();
        let raw = config
            .get("api_url")
            .cloned()
            .unwrap_or_else(|| "https://app.inariwatch.com".to_string());
        WebviewUrl::External(raw.parse().expect("invalid api_url in desktop.toml"))
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
//
// Small floating fox companion. Frameless, transparent, always-on-top.
// Loads bundled assets from dist/inari/ — does not depend on the web app.

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
        .decorations(true)         // standard window frame
        .transparent(false)        // solid theme'd background
        .always_on_top(false)
        .skip_taskbar(false)       // show in taskbar — it's a real app now
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
    // Initial label reflects the default unpaused state. Toggled in the
    // menu event handler — the new label persists across re-opens of
    // the tray menu because we hold the MenuItem reference here.
    let pause_label = if inari_watcher::is_paused() { "Resume watch" } else { "Pause watch" };
    let pause     = MenuItem::with_id(app, "pause",     pause_label,            true, None::<&str>)?;
    // Session 2: daemon-level pause stub. Wired to a no-op until
    // sensors land in Sessions 5+ and observe the bus event.
    // TODO Session 5+: replace with `daemon::pause_sensors()` that
    // publishes a `DaemonEvent::SensorsPaused` and unifies with the
    // legacy "Pause watch" item above.
    let pause_sensors = MenuItem::with_id(app, "pause_sensors", "Pause sensors", true, None::<&str>)?;
    let settings  = MenuItem::with_id(app, "settings",  "Settings…",            true, None::<&str>)?;
    let sep2      = PredefinedMenuItem::separator(app)?;
    let quit      = MenuItem::with_id(app, "quit",      "Quit",                 true, None::<&str>)?;
    let menu      = Menu::with_items(
        app,
        &[&open, &inari, &dashboard, &sep1, &pause, &pause_sensors, &settings, &sep2, &quit],
    )?;
    // Hold a clone for the on_menu_event closure so it can flip the label.
    let pause_handle = pause.clone();
    let daemon_for_quit = daemon.clone();

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("InariWatch — developer monitor")
        .menu(&menu)
        .show_menu_on_left_click(false)   // left click toggles window; right click shows menu
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
                // Session 2 stub — see TODO above. The daemon bus is
                // live but no sensor subscribes to a pause event yet.
                tracing::info!("tray: 'Pause sensors' clicked (no-op stub — Session 5+)");
            }
            "settings"  => { let _ = settings::desktop_open_settings(app.clone()); }
            "quit"      => {
                // Signal the daemon to drain. We don't await join here —
                // the OS reaps the runtime on app.exit. SHUTDOWN_GRACE
                // gives in-flight sensor work a window to flush state.
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

    // Daily rotation, keep last 7 files.
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
/// `dashboard_url` from desktop.toml when set; falls back to the
/// production hostname for users who haven't connected yet.
fn open_dashboard(_app: &AppHandle) {
    let cfg = read_desktop_config();
    let base = cfg
        .get("dashboard_url")
        .cloned()
        .or_else(|| cfg.get("api_url").cloned())
        .unwrap_or_else(|| "https://app.inariwatch.com".to_string());
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

// ── Background alert poller ───────────────────────────────────────────────────
//
// Reads  ~/.config/inari/desktop.toml  (same dir as the CLI's config.toml)
// Expected keys:
//   api_url   = "https://app.inariwatch.com"   (optional, defaults to production)
//   api_token = "your-desktop-token"           (required for polling)
//
// If no token is configured the poller silently skips until one is added.

fn start_alert_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();

        let mut seen: HashSet<String> = HashSet::new();
        // Stagger the first poll by 30s so the window has time to load
        tokio::time::sleep(Duration::from_secs(30)).await;

        loop {
            poll_once(&app, &client, &mut seen).await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

async fn poll_once(
    app:    &AppHandle,
    client: &reqwest::Client,
    seen:   &mut HashSet<String>,
) {
    let config = read_desktop_config();

    let token = match config.get("api_token") {
        Some(t) if !t.is_empty() => t.clone(),
        _ => return, // no token yet — skip silently
    };

    let api_url = config
        .get("api_url")
        .cloned()
        .unwrap_or_else(|| "https://app.inariwatch.com".to_string());

    let url = format!("{}/api/desktop/alerts", api_url.trim_end_matches('/'));

    let res = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await;

    let Ok(res) = res else { return };
    if !res.status().is_success() { return; }

    let Ok(alerts) = res.json::<Vec<serde_json::Value>>().await else { return };

    // Settings UI may have disabled native notifications. Re-checked
    // every poll so the toggle takes effect without a relaunch.
    let notifications_on = settings::notifications_enabled();

    for alert in &alerts {
        let id = match alert["id"].as_str() {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };

        if seen.contains(&id) { continue; }
        seen.insert(id);

        if !notifications_on { continue; }

        let title    = alert["title"].as_str().unwrap_or("New alert").to_string();
        let severity = alert["severity"].as_str().unwrap_or("info").to_uppercase();
        let body     = alert["body"].as_str().unwrap_or("").to_string();

        let _ = app
            .notification()
            .builder()
            .title(format!("[{severity}] {title}"))
            .body(body)
            .show();
    }
}

// ── Config reader ─────────────────────────────────────────────────────────────

// SECURITY NOTE: Config file stores api_token in plaintext.
// On shared systems, ensure ~/.config/inari/desktop.toml has restricted permissions.
// URL validation: api_url is not validated — ensure it points to a trusted InariWatch instance.
fn read_desktop_config() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    // Same directory as CLI: OS config dir / inari / desktop.toml
    let Some(cfg_dir) = dirs::config_dir() else { return map };
    let path = cfg_dir.join("inari").join("desktop.toml");

    let Ok(contents) = std::fs::read_to_string(path) else { return map };

    // Parse simple key = "value" lines (subset of TOML)
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() { continue; }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim().to_string();
            let val = v.trim().trim_matches('"').to_string();
            map.insert(key, val);
        }
    }

    // Warn if api_url does not use HTTPS (except localhost for dev)
    if let Some(url) = map.get("api_url") {
        if !url.starts_with("https://") && !url.starts_with("http://localhost") {
            eprintln!("[desktop] WARNING: api_url should use HTTPS");
        }
    }

    map
}
