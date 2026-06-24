//! Per-project local path IPC.
//!
//! Inari Live "Fix Locally" — stores the on-disk clone path for each
//! cloud project so the chat agent can read local files and write fixes
//! directly to disk (no GitHub PR).
//!
//! Storage: `settings` KV with key `project_local_path_{project_id}`.
//! Reuses the same `store::settings::{get,set}` helpers as every other
//! setting so no migration is needed.

use std::path::Path;
use std::sync::Arc;

use crate::store::{settings, Store};

use super::error::IpcError;

/// Persist the local clone path for a project.
///
/// Validates the path exists and is a directory. Pass an empty string
/// to clear a previously configured path.
#[tauri::command]
pub fn project_set_local_path(
    state:      tauri::State<'_, Arc<Store>>,
    project_id: String,
    path:       String,
) -> Result<(), IpcError> {
    let pid = project_id.trim();
    if pid.is_empty() {
        return Err(IpcError::invalid_path("", "project_id is empty"));
    }
    let trimmed = path.trim();
    // Empty string = clear the setting (settings::set treats "" as delete).
    if !trimmed.is_empty() && !Path::new(trimmed).is_dir() {
        return Err(IpcError::invalid_path(trimmed, "not a directory"));
    }
    let key = format!("project_local_path_{}", pid);
    settings::set(&state, &key, trimmed).map_err(IpcError::from)
}

/// Read the local clone path for a project.
///
/// Returns `Some(path)` when set, `None` if the user hasn't configured one.
#[tauri::command]
pub fn project_get_local_path(
    state:      tauri::State<'_, Arc<Store>>,
    project_id: String,
) -> Result<Option<String>, IpcError> {
    let pid = project_id.trim();
    if pid.is_empty() {
        return Ok(None);
    }
    let key = format!("project_local_path_{}", pid);
    settings::get(&state, &key).map_err(IpcError::from)
}
