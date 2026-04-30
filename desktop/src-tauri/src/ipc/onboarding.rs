//! First-run onboarding helpers (RENAMED from `src/onboarding.rs`).
//!
//! Three Tauri commands the overlay uses to drive the legacy 1-step
//! onboarding flow:
//!
//!   - `desktop_first_run_status` — { has_token, has_watch_dir, watch_dir? }
//!   - `desktop_pick_watch_dir`   — opens the native folder picker
//!   - `desktop_save_watch_dir`   — persists `watch_dir` in the SQL
//!     settings store
//!
//! Session 17 ships the multi-step React onboarding and stops calling
//! these. The file is then deleted at end of Session 17 per the
//! ARCHITECTURE.md migration plan.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::store::{settings, Store};

#[derive(Serialize)]
pub struct FirstRunStatus {
    pub has_token:     bool,
    pub has_watch_dir: bool,
    pub watch_dir:     Option<String>,
}

#[tauri::command]
pub fn desktop_first_run_status(
    state: tauri::State<'_, Arc<Store>>,
) -> FirstRunStatus {
    let has_token = settings::get(&state, "dashboard_token")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let watch_dir = settings::get(&state, "watch_dir")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty());
    FirstRunStatus {
        has_token,
        has_watch_dir: watch_dir.is_some(),
        watch_dir,
    }
}

/// Open a native folder picker. Returns Some(path) on selection,
/// None when the user cancels.
#[tauri::command]
pub async fn desktop_pick_watch_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    let tx = std::sync::Mutex::new(Some(tx));

    app.dialog()
        .file()
        .set_title("Pick the project Inari should watch")
        .pick_folder(move |selected| {
            if let Some(sender) = tx.lock().ok().and_then(|mut s| s.take()) {
                let _ = sender.send(selected.map(|p| p.into_path().unwrap_or_default()));
            }
        });

    match rx.await {
        Ok(Some(p)) => Ok(Some(p.display().to_string())),
        Ok(None)    => Ok(None),
        Err(e)      => Err(format!("dialog: {}", e)),
    }
}

/// Persist `watch_dir` in the SQL settings store.
#[tauri::command]
pub fn desktop_save_watch_dir(
    state: tauri::State<'_, Arc<Store>>,
    path:  String,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    if !Path::new(trimmed).is_dir() {
        return Err(format!("not a directory: {}", trimmed));
    }
    settings::set(&state, "watch_dir", trimmed)
        .map_err(|e| format!("save: {}", e))?;
    Ok(())
}
