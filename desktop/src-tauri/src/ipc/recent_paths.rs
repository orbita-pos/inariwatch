//! Inari Live Phase 5.2 — IPC surface for the recent-paths buffer.
//!
//! Two commands exposed to the dock UI:
//!   - `desktop_recent_paths_list(limit)` → top N rows by recency
//!   - `desktop_recent_paths_add(path)`   → touch a path with `now()`
//!
//! Implementation lives in `crate::store::recent_paths`; this module
//! is the thin Tauri shell so the storage layer stays unit-testable
//! without a Tauri runtime.

use std::sync::Arc;

use crate::store::{
    recent_paths::{list_recent_paths, touch_recent_path, RecentPath},
    Store,
};

use super::error::IpcError;

/// Return the most-recently-used paths, capped at `limit` (clamped to
/// [1, 20] by the storage layer). 0 or negative `limit` returns the
/// full buffer. Empty buffer returns an empty Vec — never errors on
/// "no rows".
#[tauri::command]
pub async fn desktop_recent_paths_list(
    limit: i64,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<Vec<RecentPath>, IpcError> {
    Ok(list_recent_paths(&store, limit)?)
}

/// Touch `path` with the current wall-clock time. Idempotent on the
/// `path` PRIMARY KEY — a second touch just updates the timestamp.
/// Eviction runs in the same transaction so the buffer never exceeds
/// the cap.
///
/// Empty `path` is rejected (storage layer returns Internal); the
/// frontend wrapper swallows the error so a bad `path` is a silent
/// no-op rather than a console-visible failure.
#[tauri::command]
pub async fn desktop_recent_paths_add(
    path: String,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<(), IpcError> {
    let now_ms: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    touch_recent_path(&store, &path, now_ms)?;
    Ok(())
}
