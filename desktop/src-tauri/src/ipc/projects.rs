//! Inari Live V1 — Tauri-command shell for the projects list.
//!
//! Thin pass-through to `crate::cloud::projects`. Keeps the IPC layer
//! free of `reqwest`. Add / Resume actions live entirely in React land
//! (deeplink to web dashboard via `open_url`), so this module exposes
//! only one command.

use std::sync::Arc;

use tauri::AppHandle;

use crate::cloud::projects::{self, ProjectList};
use crate::store::Store;

#[tauri::command]
pub async fn cloud_projects_list(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
) -> Result<ProjectList, String> {
    let store = state.inner().clone();
    projects::list(Some(&app), &store).await
}
