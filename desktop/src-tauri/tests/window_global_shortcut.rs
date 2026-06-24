//! Session 14 — global shortcut dispatch table.
//!
//! Verifies the locked shortcut → action mapping without spinning up an
//! AppHandle. The actual key registration is a Tauri runtime concern;
//! `resolve()` is a pure function so the contract can be tested cheaply.

use inariwatch_desktop_lib::window::shortcuts::{resolve, ShortcutAction};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

#[cfg(target_os = "macos")]
const PRIMARY: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const PRIMARY: Modifiers = Modifiers::CONTROL;

#[test]
fn primary_space_resolves_to_toggle_dock() {
    let s = Shortcut::new(Some(PRIMARY), Code::Space);
    assert_eq!(resolve(&s), Some(ShortcutAction::ToggleDock));
}

#[test]
fn primary_shift_space_resolves_to_show_dock_conversation() {
    let s = Shortcut::new(Some(PRIMARY | Modifiers::SHIFT), Code::Space);
    assert_eq!(resolve(&s), Some(ShortcutAction::ShowDockConversation));
}

#[test]
fn primary_digit1_resolves_to_show_main() {
    let s = Shortcut::new(Some(PRIMARY), Code::Digit1);
    assert_eq!(resolve(&s), Some(ShortcutAction::ShowMain));
}

#[test]
fn primary_comma_resolves_to_show_settings() {
    let s = Shortcut::new(Some(PRIMARY), Code::Comma);
    assert_eq!(resolve(&s), Some(ShortcutAction::ShowSettings));
}

#[test]
fn unmapped_shortcut_resolves_to_none() {
    // Cmd/Ctrl+Q is not part of Inari Live's global table — must fall
    // through cleanly so the OS keeps its own binding behavior.
    let s = Shortcut::new(Some(PRIMARY), Code::KeyQ);
    assert_eq!(resolve(&s), None);
}
