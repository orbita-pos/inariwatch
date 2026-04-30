//! Errors surfaced by the FS sensor.
//!
//! Most failures degrade gracefully — the actor logs and continues so
//! one bad repo doesn't take the sensor down. Errors here are returned
//! by the `attach`/`detach` API so callers (IPC commands) can surface
//! them as `IpcError` to the dock when appropriate.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum FsSensorError {
    /// Attempted to attach a path that doesn't exist or isn't a
    /// directory. Caught at the IPC layer first; this variant exists
    /// for the case where the directory disappears between the IPC
    /// validation and the actor processing the command.
    #[error("path is not a directory: {0}")]
    NotADirectory(PathBuf),

    /// `notify`/`notify-debouncer-mini` rejected the watch request.
    /// On Linux this is typically ENOSPC (raise
    /// `fs.inotify.max_user_watches`) or EMFILE (raise
    /// `RLIMIT_NOFILE`). The wrapper logs a `SensorWarning` event in
    /// these cases before bubbling the error.
    #[error("watcher failed to attach: {0}")]
    Watcher(#[from] notify::Error),

    /// The actor's command channel is closed — the sensor has shut
    /// down. Callers should treat this as a graceful "no longer
    /// available" rather than a fatal error.
    #[error("fs sensor shut down")]
    Shutdown,
}
