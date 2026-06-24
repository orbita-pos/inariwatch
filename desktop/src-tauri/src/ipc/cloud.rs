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
    self, AlertDetail, AlertItem, AlertTimeline, DeploySummary, MutationResult, OncallStatus,
    RootCauseItem, StatusSummary, TestGenResult, TrendingFix, TrendsSummary, UptimeSummary,
    VisualReportDetail,
};
use serde_json::Value;
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

#[tauri::command]
pub async fn cloud_get_movie_manifest(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    hash:  String,
) -> Result<Value, String> {
    widgets::get_movie_manifest(&state, Some(&app), &hash).await
}

#[tauri::command]
pub async fn cloud_get_trends(
    app:     AppHandle,
    state:   tauri::State<'_, Arc<Store>>,
    days:    Option<u32>,
    project: Option<String>,
) -> Result<TrendsSummary, String> {
    widgets::get_trends(&state, Some(&app), days.unwrap_or(7).min(30), project.as_deref()).await
}

#[tauri::command]
pub async fn cloud_get_root_cause(
    app:      AppHandle,
    state:    tauri::State<'_, Arc<Store>>,
    alert_id: Option<String>,
    project:  Option<String>,
) -> Result<RootCauseItem, String> {
    widgets::get_root_cause(&state, Some(&app), alert_id.as_deref(), project.as_deref()).await
}

#[tauri::command]
pub async fn cloud_ack_alert(
    app:      AppHandle,
    state:    tauri::State<'_, Arc<Store>>,
    alert_id: Option<String>,
    project:  Option<String>,
) -> Result<MutationResult, String> {
    widgets::ack_alert(&state, Some(&app), alert_id.as_deref(), project.as_deref()).await
}

#[tauri::command]
pub async fn cloud_silence_alert(
    app:      AppHandle,
    state:    tauri::State<'_, Arc<Store>>,
    alert_id: Option<String>,
    project:  Option<String>,
) -> Result<MutationResult, String> {
    widgets::silence_alert(&state, Some(&app), alert_id.as_deref(), project.as_deref()).await
}

/// Inari Guard — `/test <path>` slash command.
///
/// Reads the local file at `project_local_path_<project_id>/<file_path>`,
/// POSTs to the cloud `/api/test-generation/start` endpoint, and returns
/// the result. The frontend slash handler in `slash-dispatch.ts` calls
/// this and renders the outcome as an assistant chat note.
///
/// `delivery` is the same enum the cloud accepts: "inline" | "pr" | "local".
#[tauri::command]
pub async fn cloud_generate_test(
    app:        AppHandle,
    state:      tauri::State<'_, Arc<Store>>,
    project_id: String,
    file_path:  String,
    delivery:   Option<String>,
) -> Result<TestGenResult, String> {
    let d = delivery.unwrap_or_else(|| "inline".to_string());
    widgets::generate_test(&state, Some(&app), &project_id, &file_path, &d).await
}

// ── Alert detail panel (`Cmd+\` sidecar) ────────────────────────────────────

#[tauri::command]
pub async fn cloud_get_alert_detail(
    app:      AppHandle,
    state:    tauri::State<'_, Arc<Store>>,
    alert_id: String,
) -> Result<AlertDetail, String> {
    widgets::get_alert_detail(&state, Some(&app), &alert_id).await
}

#[tauri::command]
pub async fn cloud_get_alert_timeline(
    app:      AppHandle,
    state:    tauri::State<'_, Arc<Store>>,
    alert_id: String,
) -> Result<AlertTimeline, String> {
    widgets::get_alert_timeline(&state, Some(&app), &alert_id).await
}

#[tauri::command]
pub async fn cloud_resolve_alert(
    app:      AppHandle,
    state:    tauri::State<'_, Arc<Store>>,
    alert_id: Option<String>,
    project:  Option<String>,
) -> Result<MutationResult, String> {
    widgets::resolve_alert(&state, Some(&app), alert_id.as_deref(), project.as_deref()).await
}

// ── Visual report detail (paired with an alert that has source='user_report') ─

#[tauri::command]
pub async fn cloud_get_visual_report(
    app:      AppHandle,
    state:    tauri::State<'_, Arc<Store>>,
    alert_id: String,
) -> Result<VisualReportDetail, String> {
    widgets::get_visual_report(&state, Some(&app), &alert_id).await
}
