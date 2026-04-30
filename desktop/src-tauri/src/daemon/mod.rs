//! Daemon core: event bus + lifecycle + shared state.
//!
//! This module is the ambient, tray-resident process that owns all
//! cross-sensor coordination. Sensors (Sessions 5-10) publish events to
//! [`bus::EventBus`]; the lifecycle task (this module) emits a
//! `Heartbeat` every 30s and handles graceful shutdown drain.
//!
//! Event taxonomy starts intentionally tiny (`Heartbeat` + `Shutdown`).
//! Sensors append their own variants in their own session — the
//! `non_exhaustive` attribute means downstream `match` arms must keep a
//! `_ =>` fallback so future variants don't break the build.

pub mod bus;
pub mod lifecycle;
pub mod state;

use serde::{Deserialize, Serialize};

/// Cross-sensor event broadcast on [`bus::EventBus`].
///
/// Initial variants are minimal by design — each sensor session adds its
/// own variant when it lands. `#[non_exhaustive]` forces consumers to
/// handle the unknown-variant case so adding events is non-breaking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum DaemonEvent {
    /// Liveness signal emitted every 30s by the lifecycle task.
    Heartbeat { uptime_secs: u64 },
    /// Cooperative shutdown signal. Sensors drain remaining work and exit.
    Shutdown,
}

pub use bus::EventBus;
pub use lifecycle::{start_daemon, DaemonHandle};
pub use state::{DaemonStatus, SharedDaemonState};
