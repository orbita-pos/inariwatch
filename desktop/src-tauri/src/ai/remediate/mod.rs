//! Remediation pipeline.
//!
//! - [`cloud_proxy`] — Session 4 (RENAMED from `src/autofix.rs`).
//!   Cloud-proxied autofix bridge: starts a session against the
//!   web app + streams SSE progress back to the dock.
//!
//! Session 19 adds `single_shot` (local diff generation for unconnected
//! repos) and `orchestrator` (router between local and cloud paths).

pub mod cloud_proxy;
