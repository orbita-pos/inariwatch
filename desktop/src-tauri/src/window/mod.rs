//! Window glue. Session 14 fleshes this out into the full dock + main +
//! tray + settings + shortcut surface.
//!
//! Modules:
//!   * `dock`      — 720x480 transparent vibrancy/acrylic always-on-top window
//!   * `main`      — 1280x800 main React shell window helpers
//!   * `settings`  — settings window opener (Session 17 swaps the URL)
//!   * `shortcuts` — global shortcut dispatch table (Session 14)

pub mod dock;
pub mod main;
pub mod settings;
pub mod shortcuts;
