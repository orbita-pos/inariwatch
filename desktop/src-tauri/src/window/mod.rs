//! Window glue. Skeleton for Session 14 (full dock + main + settings + tray).
//! This session ships:
//!   * `dock::{show, hide, toggle}` — placeholder transparent webview
//!   * `main::show_main` — re-show the existing 1280×820 main window
//! Real dock chrome (vibrancy, Accessory policy, 720×480 transparent)
//! lands in Session 14 along with the React+Vite shell.

pub mod dock;
pub mod main;
pub mod settings;
