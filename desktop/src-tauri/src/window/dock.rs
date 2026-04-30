//! Dock window — Session 2 placeholder.
//!
//! Behaviour now: a 720×480 webview labeled `inari-live-dock` rendering
//! a one-line "Inari Live — placeholder" page from the bundled
//! `dist/inari-live-dock/index.html`. This gets the global shortcut +
//! tray "Open Inari Live" wired end-to-end so Sessions 3-13 can dogfood
//! the daemon while the real React shell ships in Session 14.
//!
//! Session 14 replaces this with the transparent vibrancy chrome,
//! always-on-top + macOS Accessory activation policy, and the React+Vite
//! frontend. The label `inari-live-dock` is the canonical name; the
//! existing `inari` window (the vanilla-HTML visual prototype) remains
//! reachable through the old code path until Session 14 retires it.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DOCK_LABEL: &str = "inari-live-dock";

pub fn show_dock(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DOCK_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let result = WebviewWindowBuilder::new(
        app,
        DOCK_LABEL,
        WebviewUrl::App("inari-live-dock/index.html".into()),
    )
    .title("Inari Live")
    .inner_size(720.0, 480.0)
    .min_inner_size(480.0, 320.0)
    .resizable(true)
    .visible(true)
    .build();

    if let Err(e) = result {
        tracing::error!(error = %e, "failed to open Inari Live dock window");
    }
}

#[allow(dead_code)] // first caller lands in Session 14 (auto-hide on focus loss)
pub fn hide_dock(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DOCK_LABEL) {
        let _ = w.hide();
    }
}

pub fn toggle_dock(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DOCK_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    } else {
        show_dock(app);
    }
}
