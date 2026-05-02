//! v0.3 Phase A — Tauri-command shells for the read-only cloud-dashboard
//! widget fetchers. Implementation lives in [`crate::cloud::widgets`];
//! this module is just the `#[tauri::command]` surface the React panel
//! invokes.
//!
//! Heavy-data IPC rule (per `ipc/mod.rs`): every command caps its
//! response at 32 items. The widget service on the web side enforces
//! the same cap.

use std::sync::Arc;

use tauri::AppHandle;

use crate::cloud::widgets::{
    self, AlertItem, DeploySummary, OncallStatus, StatusSummary, TrendingFix,
    UptimeSummary,
};
use crate::store::Store;

#[tauri::command]
pub async fn cloud_get_alerts(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    limit: Option<u32>,
) -> Result<Vec<AlertItem>, String> {
    widgets::get_alerts(&state, Some(&app), limit.unwrap_or(20).min(32)).await
}

#[tauri::command]
pub async fn cloud_get_uptime(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
) -> Result<UptimeSummary, String> {
    widgets::get_uptime(&state, Some(&app)).await
}

#[tauri::command]
pub async fn cloud_get_deploys(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    limit: Option<u32>,
) -> Result<DeploySummary, String> {
    widgets::get_deploys(&state, Some(&app), limit.unwrap_or(8).min(32)).await
}

#[tauri::command]
pub async fn cloud_get_oncall(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
) -> Result<OncallStatus, String> {
    widgets::get_oncall(&state, Some(&app)).await
}

#[tauri::command]
pub async fn cloud_get_community_trending(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    limit: Option<u32>,
) -> Result<Vec<TrendingFix>, String> {
    widgets::get_community_trending(&state, Some(&app), limit.unwrap_or(8).min(32)).await
}

#[tauri::command]
pub async fn cloud_get_status_summary(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
) -> Result<StatusSummary, String> {
    widgets::get_status_summary(&state, Some(&app)).await
}
