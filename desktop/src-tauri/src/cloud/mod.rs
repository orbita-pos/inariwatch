//! Cross-cutting cloud-API concerns. Peer of `daemon/`, `sensors/`, etc.
//!
//! - [`api`]          — shared `reqwest::Client` + dashboard-cred reader
//!                      pulling from the SQL-backed settings store.
//! - [`auth`]         — device-flow IMPL (RENAMED from desktop_auth.rs).
//! - [`saves`]        — `/api/desktop/saves` summary fetch.
//! - [`alert_poller`] — 60s polling of `/api/desktop/alerts` extracted
//!                      from `lib.rs::start_alert_poller`.
//!
//! Tauri-command shells live in `crate::ipc::*`. This module is pure
//! cloud business logic, free of any Tauri command annotations.

pub mod alert_poller;
pub mod api;
pub mod auth;
pub mod saves;
