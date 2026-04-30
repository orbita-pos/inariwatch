//! Main window helpers (Session 14).
//!
//! `lib.rs::setup_window` builds the `main` window pointing at the
//! production InariWatch dashboard. Session 14 leaves that wiring
//! untouched (real users on it) and adds these helpers so the dock +
//! tray + global shortcut share a single re-show entry point.
//!
//! Session 17 will swap the URL to `main.html` from the Vite output
//! and start hidden by default.

#![allow(dead_code)]

use tauri::{AppHandle, Manager};

pub const MAIN_LABEL: &str = "main";

/// Locked dimensions per Session 14 spec — exposed as constants so
/// `tests/window_dock_dimensions.rs` and a future `window_main_dimensions`
/// can assert against them.
pub const MAIN_WIDTH: f64 = 1280.0;
pub const MAIN_HEIGHT: f64 = 800.0;

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}
