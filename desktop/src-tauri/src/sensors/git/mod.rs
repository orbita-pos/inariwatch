//! Sensor 4 — git hooks (Session 8).
//!
//! Opt-in per repo. When enabled, four shell scripts (`pre-commit`,
//! `post-commit`, `pre-push`, `post-merge`) are written under
//! `<repo>/.git/hooks/`. The scripts POST `/sensors/git/event` to the
//! daemon's local HTTP listener (the same port the MCP server listens
//! on — Session 7 — merged via `axum::Router::merge`).
//!
//! Authentication uses a SEPARATE `git_hook_token`, NOT the MCP Bearer.
//! Rationale: a leak via `git checkout` of a colleague's branch must
//! not also grant MCP access. See `token.rs` for the storage format.
//!
//! Three event kinds are fire-and-forget; `pre_push` is synchronous and
//! receives a `{allow, reason}` verdict from the local gate runner
//! (Sesión 8 ships gates 1 + 4 with real logic; gates 5/6/9 land in
//! Session 20 — the scaffolding lives in `gate.rs`).
//!
//! Bus integration:
//!   * Every event publishes `DaemonEvent::GitEvent { kind, repo_id,
//!     ref_name, sha }` for downstream consumers (memory layer, dock UI).
//!   * `post_merge` additionally publishes `DaemonEvent::ReindexRequested`
//!     so the indexer (Sesión 6) re-walks after `git pull` lands new
//!     code.
//!
//! Lifecycle:
//!   * `spawn_git_sensor` registers the sensor in `SharedDaemonState`
//!     (inc_sensors at start, dec_sensors on shutdown) and listens for
//!     `DaemonEvent::Shutdown` on the bus. The HTTP work itself happens
//!     inside the MCP listener task — this sensor task is purely a
//!     bookkeeping/lifecycle loop.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use crate::daemon::{DaemonEvent, DaemonHandle};
use crate::store::Store;

pub mod error;
pub mod gate;
pub mod hooks;
pub mod installer;
pub mod token;

pub use error::{GitSensorError, Result};
pub use hooks::{GitHookState, GitEventPayload, ROUTE_PATH};
pub use installer::{
    HookStatus,
    InstallOutcome,
    UninstallOutcome,
    BACKUP_SUFFIX,
    HOOK_NAMES,
    INARI_MARKER,
};

pub const GIT_SENSOR_NAME: &str = "git";

/// Filename of the port-discovery file the MCP transport writes next
/// to `auth.json`. Re-exported so the IPC + installer agree.
pub const PORT_FILENAME: &str = "port.txt";

/// Resolve the on-disk parent for `git_hook_token` and `port.txt`.
/// Mirrors `sensors::mcp::resolve_state_dir`.
pub fn resolve_state_dir(app: &AppHandle) -> std::result::Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("inari-live"))
        .map_err(|e| format!("could not resolve app_local_data_dir: {e}"))
}

/// Spawn the git sensor lifecycle task. The HTTP route is mounted on
/// the MCP listener via `axum::Router::merge` BEFORE this is called —
/// this task only manages the sensor count and shutdown drain.
///
/// `daemon` is shared with the MCP server (same bus). `store` is shared
/// for gate evaluation. The task increments `sensor_count` immediately
/// and decrements when `DaemonEvent::Shutdown` is observed (or the bus
/// receiver is dropped).
pub fn spawn_git_sensor(
    daemon: Arc<DaemonHandle>,
    _store: Arc<Store>,
) -> JoinHandle<()> {
    daemon.state.inc_sensors();
    let bus_rx       = daemon.bus.subscribe();
    let state_handle = daemon.state.clone();

    tauri::async_runtime::spawn(async move {
        tracing::info!(sensor = GIT_SENSOR_NAME, "git sensor started");
        loop {
            let ev = match bus_rx.recv_async().await {
                Ok(e)  => e,
                Err(_) => break,
            };
            if matches!(ev, DaemonEvent::Shutdown) {
                tracing::info!(sensor = GIT_SENSOR_NAME, "shutdown observed");
                break;
            }
        }
        state_handle.dec_sensors();
        tracing::info!(sensor = GIT_SENSOR_NAME, "git sensor stopped");
    })
}
