//! S7 — System tray (icon + menu + click handler).
//!
//! Extracted from the inline `setup_tray` that lived in `lib.rs::run`
//! before S7. The shape is unchanged for the existing items (Open
//! InariWatch, Pause watch, Settings, Quit, …) — they keep their
//! menu ids so an external Tauri test driver that asserts on the
//! menu structure stays green.
//!
//! New in S7:
//!
//! - "Quick Actions ▶" submenu with four items that route through
//!   [`crate::notifications::handle_ambient_action`] just like the OS
//!   notification action callbacks would. The submenu handles the
//!   "no chat" surface — every item is one click away from a tool
//!   call (Open in Editor) or a chat prefill (Fix / Investigate) or
//!   a deeplink (Show Audit Log).
//!
//! Layout (top→bottom, separators implicit):
//!
//! ```text
//! Open InariWatch
//! Open Inari Live
//! Open dashboard…
//! ──
//! Quick Actions ▶
//!   ├ Fix Last Alert
//!   ├ Investigate Last
//!   ├ Open Latest Stacktrace in Editor
//!   └ Show Audit Log
//! ──
//! Pause watch
//! Pause sensors
//! Settings…
//! ──
//! Quit
//! ```

pub mod handlers;
pub mod menu;

pub use handlers::{dispatch_quick_action, TrayMenuItem};
pub use menu::{build_menu, TrayMenu};

use std::sync::Arc;

use tauri::{
    menu::MenuItem,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::agent::{AuditLog, ToolRegistry};
use crate::daemon::DaemonHandle;
use crate::inari_watcher;
use crate::notifications::{
    AmbientActionDeps, LastAlertStore, PrefillPayload, EVT_CHAT_PREFILL,
};

/// Tauri event the tray emits when the user picks "Show Audit Log"
/// from the Quick Actions submenu. The dock listens for this on
/// mount and routes via `wouter` to `/audit`.
pub const EVT_TRAY_NAVIGATE: &str = "tray:navigate";

/// Install the system tray with menu + click handlers. Called once
/// from `lib.rs::run` after every dependency the tray reads
/// (`Arc<ToolRegistry>`, `Arc<AuditLog>`, `Arc<LastAlertStore>`) is
/// registered as Tauri managed state.
///
/// Failures from `MenuItem::with_id` / `TrayIconBuilder::build`
/// propagate as `tauri::Result<()>` — the boot is fail-fast on a
/// missing tray (matches the pre-S7 behaviour).
pub fn install(app: &tauri::App, daemon: Arc<DaemonHandle>) -> tauri::Result<()> {
    let app_handle = app.handle().clone();
    let paused = inari_watcher::is_paused();
    let TrayMenu { menu, pause_handle } = build_menu(app, paused)?;

    let pause_handle_for_event = pause_handle.clone();
    let daemon_for_event = daemon.clone();

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("InariWatch — developer monitor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            handle_menu_event(
                app,
                daemon_for_event.clone(),
                pause_handle_for_event.clone(),
                event.id.as_ref(),
            );
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::toggle_main_window(&app_handle);
            }
        })
        .build(app)?;

    Ok(())
}

/// Dispatch a tray menu click. Synchronous-only items (window
/// navigation, pause toggle, quit) run inline; the four Quick
/// Actions enter [`dispatch_quick_action`] on the Tauri async
/// runtime.
fn handle_menu_event(
    app: &AppHandle,
    daemon: Arc<DaemonHandle>,
    pause_handle: MenuItem<Wry>,
    event_id: &str,
) {
    let Some(item) = TrayMenuItem::from_id(event_id) else {
        tracing::debug!(event_id, "tray: unknown menu event id");
        return;
    };

    match item {
        TrayMenuItem::Open => crate::show_main_window(app),
        TrayMenuItem::Inari => crate::open_inari_window(app),
        TrayMenuItem::Dashboard => crate::open_dashboard(app),
        TrayMenuItem::Settings => {
            let _ = crate::window::settings::open(app);
        }
        TrayMenuItem::Pause => {
            let now_paused = !inari_watcher::is_paused();
            inari_watcher::set_paused(now_paused);
            let _ = pause_handle.set_text(if now_paused { "Resume watch" } else { "Pause watch" });
            let body = if now_paused {
                "File watcher paused. Saves won't trigger replays until you resume."
            } else {
                "File watcher resumed."
            };
            // Best-effort tray notification — same UX as pre-S7.
            use tauri_plugin_notification::NotificationExt;
            let _ = app
                .notification()
                .builder()
                .title("Inari Live")
                .body(body)
                .show();
        }
        TrayMenuItem::PauseSensors => {
            tracing::info!("tray: 'Pause sensors' clicked (no-op stub — Session 5+)");
        }
        TrayMenuItem::QuickShowAudit => {
            let _ = app.emit(EVT_TRAY_NAVIGATE, "/audit");
        }
        TrayMenuItem::Quit => {
            daemon.shutdown();
            app.exit(0);
        }
        TrayMenuItem::QuickFix
        | TrayMenuItem::QuickInvestigate
        | TrayMenuItem::QuickOpenStacktrace => {
            let app_for_async = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(registry_state) = app_for_async.try_state::<Arc<ToolRegistry>>() else {
                    tracing::warn!("tray: ToolRegistry not in state — skipping quick action");
                    return;
                };
                let Some(audit_state) = app_for_async.try_state::<Arc<AuditLog>>() else {
                    tracing::warn!("tray: AuditLog not in state — skipping quick action");
                    return;
                };
                let Some(last_alert_state) = app_for_async.try_state::<Arc<LastAlertStore>>()
                else {
                    tracing::warn!("tray: LastAlertStore not in state — skipping quick action");
                    return;
                };

                let registry: Arc<ToolRegistry> = registry_state.inner().clone();
                let audit: Arc<AuditLog> = audit_state.inner().clone();
                let last_alert: Arc<LastAlertStore> = last_alert_state.inner().clone();
                let app_for_emit = app_for_async.clone();
                let emit = move |payload: &PrefillPayload| -> Result<(), String> {
                    app_for_emit
                        .emit(EVT_CHAT_PREFILL, payload)
                        .map_err(|e| e.to_string())
                };
                let deps = AmbientActionDeps {
                    registry: &registry,
                    audit: &audit,
                    emit_prefill: emit,
                };

                match dispatch_quick_action(item, last_alert.as_ref(), &deps).await {
                    Some(Ok(())) => {}
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, item = ?item, "tray: quick action failed");
                    }
                    None => {
                        tracing::info!(
                            item = ?item,
                            "tray: quick action skipped (no last alert / no stacktrace)"
                        );
                    }
                }

                // Open the dock so the prefilled prompt is visible.
                if matches!(
                    item,
                    TrayMenuItem::QuickFix | TrayMenuItem::QuickInvestigate
                ) {
                    if let Some(window) = app_for_async.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
        }
    }
}
