//! v0.3 Phase A — read-only cloud-dashboard widget fetchers.
//!
//! Mirrors the 6 IPC commands in `crate::ipc::cloud`. Each function
//! issues an authenticated GET against `/api/desktop/<widget>` using
//! the dashboard creds from the SQL settings store. On HTTP 401 we
//! emit the `cloud-auth-required` Tauri event (consumed by the
//! frontend panel to flip back to the "Reconnect" empty state) so
//! revoked tokens surface within one polling tick instead of waiting
//! for the next user click.
//!
//! All payloads are typed Rust structs with `Serialize` so the IPC
//! bridge produces stable JSON shapes.
//!
//! Heavy-data IPC rule (per `ipc/mod.rs`): every list capped at 32
//! items. The web side already enforces these caps too; the
//! deserializer here just trusts what it gets.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::api::{read_dashboard_creds, DashboardCreds};
use crate::store::Store;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Tauri event emitted whenever a widget call comes back with HTTP 401.
/// The frontend listens on this and flips the panel into the "Reconnect"
/// empty state.
const EVT_AUTH_REQUIRED: &str = "cloud-auth-required";

// ─────────────────────────────────────────────────────────────────────
// DTOs — mirror the JSON returned by `web/app/api/desktop/*`.
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertItem {
    pub id:                 String,
    pub title:              String,
    pub body:               Option<String>,
    pub severity:           String,
    #[serde(rename = "aiReasoning", default)]
    pub ai_reasoning:       Option<String>,
    #[serde(rename = "sourceIntegrations", default)]
    pub source_integrations: Vec<String>,
    #[serde(rename = "projectName", default)]
    pub project_name:       String,
    #[serde(default)]
    pub fingerprint:        Option<String>,
    #[serde(rename = "isRead", default)]
    pub is_read:            bool,
    #[serde(rename = "isResolved", default)]
    pub is_resolved:        bool,
    #[serde(rename = "createdAt")]
    pub created_at:         String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UptimeMonitorRow {
    pub id:                  String,
    pub name:                Option<String>,
    pub url:                 String,
    #[serde(rename = "isDown")]
    pub is_down:             bool,
    #[serde(rename = "consecutiveFailures")]
    pub consecutive_failures: i32,
    #[serde(rename = "lastCheckedAt")]
    pub last_checked_at:     Option<String>,
    #[serde(rename = "lastResponseTimeMs")]
    pub last_response_time_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UptimeSummary {
    #[serde(default)]
    pub monitors:        Vec<UptimeMonitorRow>,
    #[serde(rename = "downCount", default)]
    pub down_count:      i32,
    #[serde(default)]
    pub total:           i32,
    #[serde(rename = "avgResponseMs", default)]
    pub avg_response_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRow {
    pub id:           String,
    #[serde(rename = "projectName")]
    pub project_name: String,
    pub title:        String,
    pub severity:     String,
    pub state:        String,
    #[serde(rename = "createdAt")]
    pub created_at:   String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeploySummary {
    #[serde(default)]
    pub deploys:      Vec<DeployRow>,
    #[serde(rename = "failedCount", default)]
    pub failed_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OncallUser {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub name:    Option<String>,
    pub email:   Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OncallScheduleRow {
    #[serde(rename = "projectId")]
    pub project_id:    String,
    #[serde(rename = "projectName")]
    pub project_name:  String,
    #[serde(rename = "scheduleName")]
    pub schedule_name: String,
    pub timezone:      String,
    pub primary:       Option<OncallUser>,
    pub secondary:     Option<OncallUser>,
    #[serde(rename = "hasActiveOverride", default)]
    pub has_active_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OncallStatus {
    #[serde(default)]
    pub schedules:        Vec<OncallScheduleRow>,
    #[serde(rename = "totalAssignments", default)]
    pub total_assignments: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendingFix {
    pub id:           String,
    #[serde(rename = "patternId")]
    pub pattern_id:   String,
    #[serde(rename = "patternTitle")]
    pub pattern_title: String,
    #[serde(rename = "fixApproach")]
    pub fix_approach: String,
    #[serde(rename = "fixDescription")]
    pub fix_description: String,
    #[serde(rename = "successCount")]
    pub success_count: i32,
    #[serde(rename = "failureCount")]
    pub failure_count: i32,
    #[serde(rename = "successRate")]
    pub success_rate:  i32,
    #[serde(rename = "totalApplications")]
    pub total_applications: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatusSummary {
    pub state:               String,
    #[serde(rename = "alertsCritical24h", default)]
    pub alerts_critical_24h: i32,
    #[serde(rename = "alertsWarning24h", default)]
    pub alerts_warning_24h:  i32,
    #[serde(rename = "monitorsDown", default)]
    pub monitors_down:       i32,
    #[serde(rename = "monitorsTotal", default)]
    pub monitors_total:      i32,
    #[serde(rename = "projectCount", default)]
    pub project_count:       i32,
    #[serde(rename = "lastAlertAt", default)]
    pub last_alert_at:       Option<String>,
}

// ─────────────────────────────────────────────────────────────────────
// Fetchers
// ─────────────────────────────────────────────────────────────────────

/// Build a one-shot HTTP client. The widget loop only fires on user
/// action / 30 s timer, so a fresh client per call is fine — keeps the
/// timeout authoritative without leaking connections.
pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .expect("reqwest client builds with default config")
}

/// 401 sink: emit `cloud-auth-required` so the React panel can flip to
/// "Reconnect". Errors here are non-fatal (no listener attached yet,
/// app handle dropped, etc.) — we still surface the auth error to the
/// IPC caller.
fn signal_auth_required(app: Option<&AppHandle>) {
    if let Some(app) = app {
        let _ = app.emit(EVT_AUTH_REQUIRED, ());
    }
}

/// Internal: GET the path with bearer auth and decode JSON. Returns a
/// typed error string on every failure mode the panel cares about.
async fn fetch_json<T: for<'de> Deserialize<'de>>(
    creds: &DashboardCreds,
    path:  &str,
    app:   Option<&AppHandle>,
) -> Result<T, String> {
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().unwrap();
    let url = format!(
        "{}{}",
        creds.base_url.trim_end_matches('/'),
        path,
    );

    let res = http_client()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    let status = res.status();
    if status.as_u16() == 401 {
        signal_auth_required(app);
        return Err("unauthorized".to_string());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }

    res.json::<T>().await.map_err(|e| format!("parse: {}", e))
}

// Public surface — one fn per widget. `app` is optional so unit tests
// can call these without a Tauri AppHandle.

pub async fn get_alerts(
    store: &Store,
    app:   Option<&AppHandle>,
    limit: u32,
) -> Result<Vec<AlertItem>, String> {
    let creds = read_dashboard_creds(store);
    // The existing /api/desktop/alerts endpoint ignores the limit query
    // param (returns up to 20 unread). We keep `limit` in the IPC sig
    // for forward compat — Phase B will widen the endpoint.
    let _ = limit;
    fetch_json::<Vec<AlertItem>>(&creds, "/api/desktop/alerts", app).await
}

pub async fn get_uptime(
    store: &Store,
    app:   Option<&AppHandle>,
) -> Result<UptimeSummary, String> {
    let creds = read_dashboard_creds(store);
    fetch_json::<UptimeSummary>(&creds, "/api/desktop/uptime", app).await
}

pub async fn get_deploys(
    store: &Store,
    app:   Option<&AppHandle>,
    limit: u32,
) -> Result<DeploySummary, String> {
    let creds = read_dashboard_creds(store);
    let path = format!(
        "/api/desktop/deploys?limit={}",
        limit.clamp(1, 32),
    );
    fetch_json::<DeploySummary>(&creds, &path, app).await
}

pub async fn get_oncall(
    store: &Store,
    app:   Option<&AppHandle>,
) -> Result<OncallStatus, String> {
    let creds = read_dashboard_creds(store);
    fetch_json::<OncallStatus>(&creds, "/api/desktop/oncall", app).await
}

pub async fn get_community_trending(
    store: &Store,
    app:   Option<&AppHandle>,
    limit: u32,
) -> Result<Vec<TrendingFix>, String> {
    let creds = read_dashboard_creds(store);
    let path = format!(
        "/api/desktop/community/trending?limit={}",
        limit.clamp(1, 32),
    );
    fetch_json::<Vec<TrendingFix>>(&creds, &path, app).await
}

pub async fn get_status_summary(
    store: &Store,
    app:   Option<&AppHandle>,
) -> Result<StatusSummary, String> {
    let creds = read_dashboard_creds(store);
    fetch_json::<StatusSummary>(&creds, "/api/desktop/status-summary", app).await
}
