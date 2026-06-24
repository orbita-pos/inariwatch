//! Dock window — Session 14 chrome (720x480 transparent always-on-top).
//!
//! The dock is the primary surface for Inari Live. It floats over the
//! editor + terminal, never steals keyboard focus on macOS thanks to
//! the `Accessory` activation policy, and renders the React shell that
//! Vite builds at `dock.html`.
//!
//! ## Vibrancy / acrylic
//!
//! Visual chrome lives at the OS layer:
//!   * macOS — `apply_vibrancy(NSVisualEffectMaterial::HudWindow, ...)` via
//!     `window-vibrancy`. Falls back silently if the API call returns an
//!     error (older macOS versions or future API churn).
//!   * Windows — `apply_acrylic(None)`. On Windows 7 / older WebView2
//!     runtimes the call returns `Err` and we fall back to the solid
//!     `--bg` color from the React side.
//!   * Linux — no equivalent in mainline GTK; the React tree paints its
//!     own translucent panel on top of a transparent webview.
//!
//! Failure to apply vibrancy is logged at `warn` and never aborts window
//! creation. Same graceful-degradation pattern the FS sensor uses for
//! Linux inotify limits (Sesion 5).
//!
//! ## Position
//!
//! Centered horizontally on the cursor's monitor; 25% from the top of
//! the visible work area. Multi-monitor: the cursor's monitor is the
//! anchor (Linear / Raycast convention).

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const DOCK_LABEL: &str = "inari-live-dock";

// Locked spec recap (HANDOFF.md §Dock dimensions).
pub const DOCK_WIDTH: f64 = 720.0;
pub const DOCK_HEIGHT: f64 = 480.0;
const DOCK_TOP_OFFSET_RATIO: f64 = 0.25;

/// Show (or create) the dock window. Idempotent on re-show.
pub fn show_dock(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DOCK_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        position_on_cursor_monitor(&w);
        return;
    }

    let result = WebviewWindowBuilder::new(
        app,
        DOCK_LABEL,
        WebviewUrl::App("dock.html".into()),
    )
    .title("Inari Live")
    .inner_size(DOCK_WIDTH, DOCK_HEIGHT)
    .min_inner_size(DOCK_WIDTH, DOCK_HEIGHT)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .decorations(false)
    .transparent(true)
    .visible(true)
    .build();

    let window = match result {
        Ok(w) => w,
        Err(e) => {
            tracing::error!(error = %e, "failed to open Inari Live dock window");
            return;
        }
    };

    apply_chrome(&window);
    position_on_cursor_monitor(&window);
}

#[allow(dead_code)] // first caller lands in Session 15 (auto-hide on focus loss)
pub fn hide_dock(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DOCK_LABEL) {
        let _ = w.hide();
    }
}

/// Toggle visibility, creating the window on first call.
pub fn toggle_dock(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DOCK_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
            position_on_cursor_monitor(&w);
        }
    } else {
        show_dock(app);
    }
}

// Internals -------------------------------------------------------------------

fn apply_chrome(_window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(e) = apply_vibrancy(
            _window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(16.0),
        ) {
            tracing::warn!(error = %e, "vibrancy unavailable; dock falls back to opaque chrome");
        }
    }
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_acrylic;
        if let Err(e) = apply_acrylic(_window, None) {
            tracing::warn!(error = %e, "acrylic unavailable; dock falls back to opaque chrome");
        }
    }
}

fn position_on_cursor_monitor(window: &tauri::WebviewWindow) {
    let cursor = match window.cursor_position() {
        Ok(p) => p,
        Err(_) => return,
    };
    let monitor = match window.monitor_from_point(cursor.x, cursor.y) {
        Ok(Some(m)) => m,
        _ => return,
    };
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let pos = monitor.position();

    let dock_w = (DOCK_WIDTH * scale) as i32;
    let x = pos.x + (screen.width as i32 - dock_w) / 2;
    let y = pos.y + (screen.height as f64 * DOCK_TOP_OFFSET_RATIO) as i32;

    let _ = window.set_position(PhysicalPosition::new(x, y));
}
