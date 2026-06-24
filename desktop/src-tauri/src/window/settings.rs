//! Settings window opener (PORTED from `src/settings.rs::desktop_open_settings`).
//!
//! Session 14 will replace the vanilla `inari/settings.html` shell with
//! the Vite/React build. Until then this stub keeps the legacy chrome
//! reachable so dogfood doesn't regress.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const SETTINGS_WINDOW_LABEL: &str = "inari-settings";

/// Show the settings window, creating it if needed.
pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("inari/settings.html".into()),
    )
    .title("Inari Live — Settings")
    .inner_size(480.0, 620.0)
    .min_inner_size(420.0, 520.0)
    .resizable(true)
    .visible(true)
    .build()
    .map(|_| ())
    .map_err(|e| format!("open settings: {}", e))
}
