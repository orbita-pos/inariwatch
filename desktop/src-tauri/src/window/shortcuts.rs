//! Global shortcut registration for Inari Live (Session 14).
//!
//! The plugin is initialized in `lib.rs::run` with a single handler
//! function that fans out to per-shortcut behavior based on identity.
//!
//! Locked shortcut table (HANDOFF spec recap):
//!
//! | Shortcut                     | Action                                 |
//! | ---------------------------- | -------------------------------------- |
//! | `Cmd/Ctrl + Space`           | Toggle dock                            |
//! | `Cmd/Ctrl + Shift + Space`   | Show dock + go to conversation mode    |
//! | `Cmd/Ctrl + 1`               | Show main window                       |
//! | `Cmd/Ctrl + ,`               | Show main window + navigate to /settings |
//!
//! `Cmd/Ctrl+Shift+Space` and `Cmd/Ctrl+,` carry navigation intent the
//! frontend resolves via the Tauri event `inari://navigate`. Session 15
//! (conversation) + Session 17 (settings) listen for the payload and
//! mount the right route.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::window;

/// Routing intent emitted on `inari://navigate`. The frontend listens
/// once at boot in each window's entry point.
pub const NAVIGATE_EVENT: &str = "inari://navigate";

/// Register all locked shortcuts. Returns the count of registrations
/// that succeeded so the caller (`lib.rs::run`) can log + degrade
/// gracefully when the underlying OS rejected one (e.g. another app
/// already grabbed `Cmd+Space`).
pub fn register(app: &AppHandle) -> usize {
    let modifier = primary_modifier();
    let shift = modifier | Modifiers::SHIFT;

    let entries: &[(Shortcut, ShortcutAction)] = &[
        (Shortcut::new(Some(modifier), Code::Space), ShortcutAction::ToggleDock),
        (Shortcut::new(Some(shift), Code::Space), ShortcutAction::ShowDockConversation),
        (Shortcut::new(Some(modifier), Code::Digit1), ShortcutAction::ShowMain),
        (Shortcut::new(Some(modifier), Code::Comma), ShortcutAction::ShowSettings),
    ];

    let mut count = 0usize;
    for (shortcut, _) in entries {
        match app.global_shortcut().register(*shortcut) {
            Ok(()) => {
                count += 1;
                tracing::info!(shortcut = ?shortcut, "registered global shortcut");
            }
            Err(e) => {
                tracing::warn!(error = %e, shortcut = ?shortcut, "failed to register shortcut");
            }
        }
    }
    count
}

/// Resolve a fired shortcut into the action to run. Pure function so
/// `tests/window_global_shortcut.rs` can verify the dispatch table
/// without mocking a Tauri AppHandle.
pub fn resolve(shortcut: &Shortcut) -> Option<ShortcutAction> {
    let modifier = primary_modifier();
    let shift = modifier | Modifiers::SHIFT;

    if shortcut.matches(modifier, Code::Space) {
        return Some(ShortcutAction::ToggleDock);
    }
    if shortcut.matches(shift, Code::Space) {
        return Some(ShortcutAction::ShowDockConversation);
    }
    if shortcut.matches(modifier, Code::Digit1) {
        return Some(ShortcutAction::ShowMain);
    }
    if shortcut.matches(modifier, Code::Comma) {
        return Some(ShortcutAction::ShowSettings);
    }
    None
}

/// Run the shortcut's effect on the live `AppHandle`. Called from the
/// plugin handler in `lib.rs`.
pub fn dispatch(app: &AppHandle, action: ShortcutAction) {
    match action {
        ShortcutAction::ToggleDock => window::dock::toggle_dock(app),
        ShortcutAction::ShowDockConversation => {
            window::dock::show_dock(app);
            emit_navigate(app, "dock", "/conversation");
        }
        ShortcutAction::ShowMain => {
            window::main::show_main(app);
            emit_navigate(app, "main", "/");
        }
        ShortcutAction::ShowSettings => {
            window::main::show_main(app);
            emit_navigate(app, "main", "/settings");
        }
    }
}

/// Plugin-level handler — dispatches a fired shortcut to its action
/// when the key is pressed (we ignore key-up to avoid double-firing).
pub fn handle_event(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    if let Some(action) = resolve(shortcut) {
        dispatch(app, action);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutAction {
    ToggleDock,
    ShowDockConversation,
    ShowMain,
    ShowSettings,
}

fn primary_modifier() -> Modifiers {
    #[cfg(target_os = "macos")]
    {
        Modifiers::SUPER
    }
    #[cfg(not(target_os = "macos"))]
    {
        Modifiers::CONTROL
    }
}

fn emit_navigate(app: &AppHandle, target: &str, route: &str) {
    let payload = serde_json::json!({
        "target": target,
        "route": route,
    });
    if let Err(e) = app.emit(NAVIGATE_EVENT, payload) {
        tracing::warn!(error = %e, "failed to emit navigate event");
    }
}
