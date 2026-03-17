use std::collections::HashSet;
use std::time::Duration;

use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;

// ── Entry ─────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            setup_window(app)?;
            setup_tray(app)?;
            start_alert_poller(app.handle().clone());
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

// ── System tray ───────────────────────────────────────────────────────────────

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open InariWatch", true, None::<&str>)?;
    let sep  = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("InariWatch — developer monitor")
        .menu(&menu)
        .show_menu_on_left_click(false)   // left click toggles window; right click shows menu
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _      => {}
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

    for alert in &alerts {
        let id = match alert["id"].as_str() {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };

        if seen.contains(&id) { continue; }
        seen.insert(id);

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

    map
}
