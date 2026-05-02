//! Cross-cutting cloud-API concerns. Peer of `daemon/`, `sensors/`, etc.
//!
//! - [`api`]          — shared `reqwest::Client` + dashboard-cred reader
//!                      pulling from the SQL-backed settings store.
//! - [`auth`]         — device-flow IMPL (RENAMED from desktop_auth.rs).
//! - [`saves`]        — `/api/desktop/saves` summary fetch.
//! - [`alert_poller`] — 60s polling of `/api/desktop/alerts` extracted
//!                      from `lib.rs::start_alert_poller`.
//! - [`widgets`]      — v0.3 Phase A read-only widget fetchers (uptime,
//!                      deploys, on-call, community trending, status
//!                      summary). Surfaces the cloud-dashboard panel
//!                      next to Inari Live's main view.
//! - [`alert_stream`] — v0.3 Phase A SSE client wrapping
//!                      `/api/alerts/stream`. Forwards events as Tauri
//!                      `cloud-alerts-update` so the panel refreshes
//!                      without a polling loop of its own.
//!
//! Tauri-command shells live in `crate::ipc::*`. This module is pure
//! cloud business logic, free of any Tauri command annotations.

pub mod alert_poller;
pub mod alert_stream;
pub mod api;
pub mod auth;
pub mod saves;
pub mod widgets;
