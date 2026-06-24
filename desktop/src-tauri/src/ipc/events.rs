//! Bus-event → Tauri-event bridge.
//!
//! Two channels:
//! - `daemon:event` — 1:1 forward of every [`crate::daemon::DaemonEvent`]
//!   (post-`Shutdown` the bridge stops).
//! - `daemon:status_changed` — debounced [`DaemonStatusDto`] diff. Emits
//!   at most once per [`STATUS_DEBOUNCE_INTERVAL`]; suppresses identical
//!   payloads.
//!
//! Both bridges are spawned by [`start`]; cancellable when `Shutdown`
//! arrives on the bus.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::daemon::{DaemonEvent, DaemonHandle};

use super::commands::{snapshot_to_dto, DaemonStatusDto};

/// Maximum cadence for `daemon:status_changed`. Heartbeats fire every
/// 30s, so even a 1s debounce just suppresses no-op redundancy when
/// nothing else moves.
pub const STATUS_DEBOUNCE_INTERVAL: Duration = Duration::from_secs(1);

/// Spawn both event bridges. Owns its own subscriptions to the bus —
/// the caller does not need to wire anything else.
pub fn start(app: AppHandle, daemon: Arc<DaemonHandle>) {
    spawn_daemon_event_bridge(app.clone(), daemon.clone());
    spawn_status_changed_bridge(app, daemon);
}

fn spawn_daemon_event_bridge(app: AppHandle, daemon: Arc<DaemonHandle>) {
    let rx = daemon.bus.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv_async().await {
                Ok(event) => {
                    let _ = app.emit("daemon:event", &event);
                    if matches!(event, DaemonEvent::Shutdown) {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
}

fn spawn_status_changed_bridge(app: AppHandle, daemon: Arc<DaemonHandle>) {
    let rx = daemon.bus.subscribe();
    let last: Arc<Mutex<Option<DaemonStatusDto>>> = Arc::new(Mutex::new(None));

    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv_async().await {
                Ok(event) => {
                    if matches!(event, DaemonEvent::Shutdown) {
                        return;
                    }
                    let snap = snapshot_to_dto(&daemon.state.snapshot());
                    let mut guard = last.lock().await;
                    if !should_emit(guard.as_ref(), &snap) {
                        continue;
                    }
                    *guard = Some(snap.clone());
                    drop(guard);
                    let _ = app.emit("daemon:status_changed", &snap);
                    // Sleep so we never emit faster than the debounce
                    // interval even if the bus delivers a burst.
                    tokio::time::sleep(STATUS_DEBOUNCE_INTERVAL).await;
                }
                Err(_) => return,
            }
        }
    });
}

/// Decide whether a fresh snapshot should be emitted, given the
/// previously-emitted one. Pure function — extracted from the bridge
/// so the integration test can drive it without an AppHandle.
///
/// Emit on first observation OR whenever any field differs from the
/// last emitted payload. PartialEq on `DaemonStatusDto` covers
/// `uptime_secs` / `sensor_count` / `repo_count` / `version` /
/// `started_at`.
pub fn should_emit(last: Option<&DaemonStatusDto>, current: &DaemonStatusDto) -> bool {
    match last {
        None      => true,
        Some(prev) => prev != current,
    }
}
