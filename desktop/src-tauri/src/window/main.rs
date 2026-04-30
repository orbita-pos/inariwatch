//! Main window opener. The window itself is created in `lib.rs::setup_window`
//! during `setup`; this helper just brings it back to focus when the user
//! re-opens via tray menu.
//!
//! Session 14 will move `setup_window` here and replace the inline URL
//! resolution with a typed enum.

// Public API skeleton for Session 14 (`window::setup_window` will move
// here, plus the `show_main` / `toggle_main` helpers will replace the
// inline `show_main_window` / `toggle_main_window` in `lib.rs`).
#![allow(dead_code)]

use tauri::{AppHandle, Manager};

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}
