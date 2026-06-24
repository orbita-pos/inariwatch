//! Window IPC commands (Sesión 17).
//!
//! These are the canonical entry points the dock + main React surfaces
//! use to navigate between webviews. The webview labels themselves are
//! locked by Sesión 14 (`inari-live-dock` / `main`); the new wrinkle in
//! Sesión 17 is that the React tree gates on `tauri::WebviewWindow::label`
//! to mount the right shell, so simply showing/hiding the window plus
//! emitting a navigate intent is enough — no new top-level windows.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

use crate::window;

use super::error::IpcError;

/// Navigate the requested webview surface to `route`. The frontend
/// listens to `inari://navigate` per Sesión 14 and pivots its visible
/// route based on `target` + the current webview label.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct NavigatePayload {
    pub target: String,
    pub route:  String,
}

/// Show / focus the main window. `route` is optional — when present, the
/// shortcut-style `inari://navigate` event fires so the React layer
/// changes its route without an additional round-trip.
#[tauri::command]
pub fn open_main_window(
    app:   AppHandle,
    tab:   Option<String>,
) -> Result<(), IpcError> {
    window::main::show_main(&app);
    let route = tab.unwrap_or_else(|| "/".to_string());
    let payload = NavigatePayload {
        target: "main".to_string(),
        route,
    };
    if let Err(e) = app.emit(window::shortcuts::NAVIGATE_EVENT, payload) {
        tracing::warn!(error = %e, "failed to emit inari://navigate (main)");
    }
    Ok(())
}

/// Hide the dock window without unmounting it. Survives — re-show via
/// global shortcut or `open_main_window` round-trip.
#[tauri::command]
pub fn hide_dock(app: AppHandle) -> Result<(), IpcError> {
    if let Some(w) = app.get_webview_window(window::dock::DOCK_LABEL) {
        let _ = w.hide();
    }
    Ok(())
}

/// Generic navigate emit. Useful when the caller is already on the right
/// window (e.g. dock → dock route flip) and wants to avoid the
/// show-window side-effect of `open_main_window`.
#[tauri::command]
pub fn navigate(
    app:    AppHandle,
    target: String,
    route:  String,
) -> Result<(), IpcError> {
    if !matches!(target.as_str(), "dock" | "main" | "onboarding") {
        return Err(IpcError::Internal {
            message: format!("unknown navigate target '{}'", target),
        });
    }
    let payload = NavigatePayload { target, route };
    if let Err(e) = app.emit(window::shortcuts::NAVIGATE_EVENT, payload) {
        tracing::warn!(error = %e, "failed to emit inari://navigate");
    }
    Ok(())
}
