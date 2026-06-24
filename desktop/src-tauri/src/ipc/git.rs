//! Tauri command shells for the git hook installer + status (Session 8).
//!
//! Light, typed payloads only — heavy data (full diff bodies, gate
//! verdict timelines) goes through the MCP HTTP transport. Per
//! `ARCHITECTURE.md` § *Heavy-data IPC rule*.
//!
//! Settings UI flow:
//!   * `git_hooks_status(repo_id)` → boolean + array of installed hook
//!     names. UI renders "Hooks installed (4/4)" or "Hooks not yet
//!     installed".
//!   * `install_git_hooks(repo_id)` → writes the four `.git/hooks/*`
//!     scripts; returns the InstallOutcome. UI shows a toast.
//!   * `uninstall_git_hooks(repo_id)` → removes the four scripts +
//!     restores any `.inari-backup`s. UI shows a toast.
//!   * `get_git_hook_token()` → returns the raw token. UI's Settings
//!     screen shows it under "Advanced — git hook token" so the user
//!     can copy it (rare, only needed if they're hand-writing hooks).

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::sensors::git::{installer, token, PORT_FILENAME};
use crate::store::{queries, Store};

use super::error::IpcError;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct GitHookInstallDto {
    pub installed:    Vec<String>,
    pub backed_up:    Vec<String>,
    pub already_ours: Vec<String>,
    pub hook_dir:     String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct GitHookUninstallDto {
    pub removed:  Vec<String>,
    pub restored: Vec<String>,
    pub absent:   Vec<String>,
    pub hook_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct GitHookStatusDto {
    pub repo_id:    String,
    pub installed:  bool,
    pub hook_files: Vec<String>,
    pub hook_dir:   String,
    pub port:       u16,
}

#[tauri::command]
pub fn install_git_hooks(
    app:     AppHandle,
    store:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<GitHookInstallDto, IpcError> {
    let repo_root = repo_root_for(&store, &repo_id)?;
    let state_dir = state_dir(&app)?;
    let token = token::ensure_token(&state_dir).map_err(IpcError::from)?;
    let port_file = state_dir.join(PORT_FILENAME);
    let outcome = installer::install_for(&repo_root, &port_file, &token, &repo_id)
        .map_err(IpcError::from)?;
    Ok(GitHookInstallDto {
        installed:    outcome.installed,
        backed_up:    outcome.backed_up,
        already_ours: outcome.already_ours,
        hook_dir:     outcome.hook_dir,
    })
}

#[tauri::command]
pub fn uninstall_git_hooks(
    store:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<GitHookUninstallDto, IpcError> {
    let repo_root = repo_root_for(&store, &repo_id)?;
    let outcome = installer::uninstall_for(&repo_root).map_err(IpcError::from)?;
    Ok(GitHookUninstallDto {
        removed:  outcome.removed,
        restored: outcome.restored,
        absent:   outcome.absent,
        hook_dir: outcome.hook_dir,
    })
}

#[tauri::command]
pub fn git_hooks_status(
    app:     AppHandle,
    store:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<GitHookStatusDto, IpcError> {
    let repo_root = repo_root_for(&store, &repo_id)?;
    let state_dir = state_dir(&app)?;
    let port = std::fs::read_to_string(state_dir.join(PORT_FILENAME))
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or(0);
    let snap = installer::status_for(&repo_id, &repo_root).map_err(IpcError::from)?;
    Ok(GitHookStatusDto {
        repo_id:    snap.repo_id,
        installed:  snap.installed,
        hook_files: snap.hook_files,
        hook_dir:   snap.hook_dir,
        port,
    })
}

#[tauri::command]
pub fn get_git_hook_token(app: AppHandle) -> Result<String, IpcError> {
    let state_dir = state_dir(&app)?;
    token::ensure_token(&state_dir).map_err(IpcError::from)
}

fn repo_root_for(store: &Arc<Store>, repo_id: &str) -> Result<PathBuf, IpcError> {
    match queries::find_repo_path_by_id(store, repo_id) {
        Ok(Some(p)) => Ok(PathBuf::from(p)),
        Ok(None)    => Err(IpcError::RepoNotFound { id: repo_id.to_string() }),
        Err(e)      => Err(IpcError::from(e)),
    }
}

fn state_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("inari-live"))
        .map_err(|e| IpcError::internal(format!("could not resolve app_local_data_dir: {e}")))
}
