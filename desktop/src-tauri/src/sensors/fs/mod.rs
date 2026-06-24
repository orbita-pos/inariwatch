//! Sensor 1 — recursive filesystem watcher with `.gitignore`-aware
//! initial walk.
//!
//! Public surface: [`spawn_fs_sensor`] returns a [`FsSensorHandle`]
//! whose `attach` / `detach` are called by the IPC `open_repo` /
//! `close_repo` commands. The actor publishes `RepoIndexed`,
//! `FsChange`, and `SensorWarning` events on the daemon bus; the
//! existing `daemon:event` Tauri bridge forwards every variant to the
//! webview, so no extra wiring is needed on the IPC side.

pub mod debouncer;
pub mod error;
pub mod kind;
pub mod walker;
pub mod watcher;

pub use error::FsSensorError;
pub use kind::FsChangeKind;
pub use walker::{walk_repo, WalkResult, MAX_FILES_HARD_CAP};
pub use watcher::{spawn_fs_sensor, FsSensorHandle, SENSOR_NAME};
