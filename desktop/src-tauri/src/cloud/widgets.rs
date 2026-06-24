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
use tauri::AppHandle;

use super::api::{read_dashboard_creds, DashboardCreds};
use crate::store::Store;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

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
    #[serde(rename = "inariHash", default)]
    pub inari_hash:         Option<String>,
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

/// 401 sink: clear the local bearer (so the next tick doesn't re-fail
/// with the same stale token) AND emit `cloud-auth-required` so the
/// React panel can flip to "Reconnect". Errors here are non-fatal —
/// we still surface the auth error to the IPC caller.
///
/// Session 1 — bearer wipe is required for acceptance criterion 2
/// ("Revoke from web → device-side detects 401 → re-pair flow").
/// Without the wipe the next 60s alert poll re-fires the same 401.
fn signal_auth_required(app: Option<&AppHandle>, store: &Store) {
    if let Some(app) = app {
        super::auth::invalidate_with_store(app, store);
    }
}

/// Internal: POST a JSON body and decode the response. Same auth /
/// 401-sink logic as `fetch_json`.
async fn post_json<T: for<'de> Deserialize<'de>>(
    creds: &DashboardCreds,
    path:  &str,
    body:  &impl Serialize,
    app:   Option<&AppHandle>,
    store: &Store,
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
        .post(&url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    let status = res.status();
    if status.as_u16() == 401 {
        signal_auth_required(app, store);
        return Err("unauthorized".to_string());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }

    res.json::<T>().await.map_err(|e| format!("parse: {}", e))
}

/// Internal: GET the path with bearer auth and decode JSON. Returns a
/// typed error string on every failure mode the panel cares about.
async fn fetch_json<T: for<'de> Deserialize<'de>>(
    creds: &DashboardCreds,
    path:  &str,
    app:   Option<&AppHandle>,
    store: &Store,
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
        signal_auth_required(app, store);
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
    fetch_json::<Vec<AlertItem>>(&creds, "/api/desktop/alerts", app, store).await
}

pub async fn get_uptime(
    store: &Store,
    app:   Option<&AppHandle>,
) -> Result<UptimeSummary, String> {
    let creds = read_dashboard_creds(store);
    fetch_json::<UptimeSummary>(&creds, "/api/desktop/uptime", app, store).await
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
    fetch_json::<DeploySummary>(&creds, &path, app, store).await
}

pub async fn get_oncall(
    store: &Store,
    app:   Option<&AppHandle>,
) -> Result<OncallStatus, String> {
    let creds = read_dashboard_creds(store);
    fetch_json::<OncallStatus>(&creds, "/api/desktop/oncall", app, store).await
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
    fetch_json::<Vec<TrendingFix>>(&creds, &path, app, store).await
}

pub async fn get_status_summary(
    store: &Store,
    app:   Option<&AppHandle>,
) -> Result<StatusSummary, String> {
    let creds = read_dashboard_creds(store);
    fetch_json::<StatusSummary>(&creds, "/api/desktop/status-summary", app, store).await
}

/// GET /api/r/<hash>/movie — full incident movie manifest (session + error +
/// fix + preview phases). Passed through as raw JSON so the TS layer owns
/// the type; avoids duplicating a deeply-nested DTO in Rust.
pub async fn get_movie_manifest(
    store: &Store,
    app:   Option<&AppHandle>,
    hash:  &str,
) -> Result<serde_json::Value, String> {
    let creds = read_dashboard_creds(store);
    let encoded = urlencoding::encode(hash);
    let path = format!("/api/r/{}/movie", encoded);
    fetch_json::<serde_json::Value>(&creds, &path, app, store).await
}

// ── Error trends ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendDay {
    pub date:     String,
    pub severity: String,
    pub count:    i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopError {
    pub title:    String,
    pub severity: String,
    pub count:    i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrendsSummary {
    pub current:    i32,
    pub previous:   i32,
    #[serde(default)]
    pub daily:      Vec<TrendDay>,
    #[serde(rename = "topErrors", default)]
    pub top_errors: Vec<TopError>,
}

pub async fn get_trends(
    store:   &Store,
    app:     Option<&AppHandle>,
    days:    u32,
    project: Option<&str>,
) -> Result<TrendsSummary, String> {
    let creds = read_dashboard_creds(store);
    let mut path = format!("/api/desktop/trends?days={}", days.clamp(1, 30));
    if let Some(p) = project {
        if !p.is_empty() {
            path.push_str(&format!("&project={}", urlencoding::encode(p)));
        }
    }
    fetch_json::<TrendsSummary>(&creds, &path, app, store).await
}

// ── Root cause ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootCauseItem {
    pub id:           String,
    pub title:        String,
    pub severity:     String,
    pub body:         Option<String>,
    #[serde(rename = "projectName")]
    pub project_name: String,
    #[serde(rename = "aiReasoning")]
    pub ai_reasoning: Option<String>,
    #[serde(rename = "isResolved")]
    pub is_resolved:  bool,
    #[serde(rename = "createdAt")]
    pub created_at:   String,
}

pub async fn get_root_cause(
    store:    &Store,
    app:      Option<&AppHandle>,
    alert_id: Option<&str>,
    project:  Option<&str>,
) -> Result<RootCauseItem, String> {
    let creds = read_dashboard_creds(store);
    let mut params: Vec<String> = Vec::new();
    if let Some(id) = alert_id {
        params.push(format!("alert_id={}", urlencoding::encode(id)));
    }
    if let Some(p) = project {
        if !p.is_empty() {
            params.push(format!("project={}", urlencoding::encode(p)));
        }
    }
    let path = if params.is_empty() {
        "/api/desktop/root-cause".to_string()
    } else {
        format!("/api/desktop/root-cause?{}", params.join("&"))
    };
    fetch_json::<RootCauseItem>(&creds, &path, app, store).await
}

// ── Alert mutations ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationResult {
    pub ok:    bool,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Serialize)]
struct AlertActionBody<'a> {
    #[serde(rename = "alertId", skip_serializing_if = "Option::is_none")]
    alert_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project:  Option<&'a str>,
}

pub async fn ack_alert(
    store:    &Store,
    app:      Option<&AppHandle>,
    alert_id: Option<&str>,
    project:  Option<&str>,
) -> Result<MutationResult, String> {
    let creds = read_dashboard_creds(store);
    let body = AlertActionBody {
        alert_id,
        project: project.filter(|p| !p.is_empty()),
    };
    post_json::<MutationResult>(&creds, "/api/desktop/alerts/ack", &body, app, store).await
}

pub async fn silence_alert(
    store:    &Store,
    app:      Option<&AppHandle>,
    alert_id: Option<&str>,
    project:  Option<&str>,
) -> Result<MutationResult, String> {
    let creds = read_dashboard_creds(store);
    let body = AlertActionBody {
        alert_id,
        project: project.filter(|p| !p.is_empty()),
    };
    post_json::<MutationResult>(&creds, "/api/desktop/alerts/silence", &body, app, store).await
}

// ── Inari Guard `/test <path>` ────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct TestGenRequest<'a> {
    #[serde(rename = "projectId")]
    project_id: &'a str,
    #[serde(rename = "filePath")]
    file_path: &'a str,
    #[serde(rename = "fileContent")]
    file_content: String,
    delivery: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TestGenResult {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "costCents", default)]
    pub cost_cents: i64,
    #[serde(rename = "durationMs", default)]
    pub duration_ms: i64,
    #[serde(rename = "testFile", default)]
    pub test_file: Option<TestGenFile>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(rename = "prUrl", default)]
    pub pr_url: Option<String>,
    #[serde(rename = "prNumber", default)]
    pub pr_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestGenFile {
    pub path:    String,
    pub content: String,
}

/// Inari Guard — `/test <path>` widget.
///
/// Reads the file from the user's local clone (using the Fix Locally
/// `project_local_path_<projectId>` setting), POSTs to the cloud test
/// generation endpoint, and returns the result for the chat surface
/// to render.
///
/// `delivery` is one of "inline" | "pr" | "local". The desktop client
/// typically picks "local" (write the result back to disk via the same
/// local-path setting) but "pr" is also valid when the user wants the
/// branch + PR pushed by the server.
pub async fn generate_test(
    store:      &Store,
    app:        Option<&AppHandle>,
    project_id: &str,
    file_path:  &str,
    delivery:   &str,
) -> Result<TestGenResult, String> {
    // Read the project's local clone path from settings (set by the
    // Fix Locally wizard). Without it we can't read the source file.
    let key = format!("project_local_path_{}", project_id);
    let local_root = match crate::store::settings::get(store, &key) {
        Ok(Some(p)) if !p.trim().is_empty() => p,
        Ok(_) => {
            return Err(format!(
                "No local clone configured for project {}. Open the project once via Fix Locally to set the path.",
                project_id
            ));
        }
        Err(e) => return Err(format!("settings.get failed: {}", e)),
    };

    // Resolve + sanity-check the absolute path. Reject anything that
    // escapes the local root (no `..` traversal).
    let normalized = file_path.trim_start_matches(['/', '\\']);
    if normalized.contains("..") {
        return Err("file_path must not contain `..` traversal".to_string());
    }
    let abs = std::path::Path::new(&local_root).join(normalized);
    let canonical_root = std::fs::canonicalize(&local_root)
        .map_err(|e| format!("local_root not accessible: {}", e))?;
    let canonical_abs = std::fs::canonicalize(&abs)
        .map_err(|e| format!("file not found at {}: {}", abs.display(), e))?;
    if !canonical_abs.starts_with(&canonical_root) {
        return Err("resolved path escapes the local clone root".to_string());
    }

    // Read the file (cap at 200 KB matching the cloud's FILE_CONTENT_MAX)
    let file_content = std::fs::read_to_string(&canonical_abs)
        .map_err(|e| format!("read failed: {}", e))?;
    if file_content.len() > 200_000 {
        return Err(format!(
            "file too large ({} bytes, max 200000)",
            file_content.len()
        ));
    }

    let creds = read_dashboard_creds(store);
    let body = TestGenRequest {
        project_id,
        file_path: normalized,
        file_content,
        delivery,
    };
    post_json::<TestGenResult>(&creds, "/api/test-generation/start", &body, app, store).await
}

// ── Alert detail panel (`Cmd+\` sidecar) ────────────────────────────────────
//
// Three IPCs feed the Inari Live `Cmd+\` AlertDetailPanel:
//   - get_alert_detail   → header + live banner (severity/title/source/status)
//   - get_alert_timeline → unified feed (alert birth + comments + remediations
//                          + state transitions from audit_logs)
//   - resolve_alert      → quick-action "Resolve" button. Same wire shape as
//                          ack/silence (POST /api/desktop/alerts/silence with
//                          resolve=true, which the existing service handles).
//
// The widget structs mirror the JSON shape the web endpoints return —
// see `web/app/api/desktop/alert/[id]/route.ts` and `.../timeline/route.ts`.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AlertDetail {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    pub severity: String,
    #[serde(rename = "sourceIntegrations", default)]
    pub source_integrations: Vec<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(rename = "isResolved")]
    pub is_resolved: bool,
    #[serde(rename = "resolvedAt", default)]
    pub resolved_at: Option<String>,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "projectName")]
    pub project_name: String,
    #[serde(rename = "projectSlug", default)]
    pub project_slug: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastEventAt")]
    pub last_event_at: String,
}

/// Single timeline event. The `kind` field discriminates the renderer —
/// the panel maps each kind to its icon + style. See `TimelineEvent`
/// in `web/app/api/desktop/alert/[id]/timeline/route.ts` for the
/// canonical schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    pub id: String,
    pub kind: String,
    pub at: String,
    pub text: String,
    #[serde(default)]
    pub witness: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AlertTimeline {
    pub events: Vec<TimelineEvent>,
}

pub async fn get_alert_detail(
    store:    &Store,
    app:      Option<&AppHandle>,
    alert_id: &str,
) -> Result<AlertDetail, String> {
    if alert_id.is_empty() {
        return Err("alert_id required".to_string());
    }
    let creds = read_dashboard_creds(store);
    let path = format!("/api/desktop/alert/{}", urlencoding::encode(alert_id));
    fetch_json::<AlertDetail>(&creds, &path, app, store).await
}

pub async fn get_alert_timeline(
    store:    &Store,
    app:      Option<&AppHandle>,
    alert_id: &str,
) -> Result<AlertTimeline, String> {
    if alert_id.is_empty() {
        return Err("alert_id required".to_string());
    }
    let creds = read_dashboard_creds(store);
    let path = format!("/api/desktop/alert/{}/timeline", urlencoding::encode(alert_id));
    fetch_json::<AlertTimeline>(&creds, &path, app, store).await
}

/// Resolve uses the same silence-with-resolve=true wire shape the
/// existing `silence_alert` widget uses. We expose it as a separate
/// function so the UI's "Resolve" button is semantically distinct from
/// "Silence" even though they share a backend (per
/// `web/lib/services/alerts.service.ts` — silence is just resolve in
/// this codebase). Returns the same MutationResult shape.
pub async fn resolve_alert(
    store:    &Store,
    app:      Option<&AppHandle>,
    alert_id: Option<&str>,
    project:  Option<&str>,
) -> Result<MutationResult, String> {
    // Reuse silence_alert — same endpoint, same payload, same response.
    silence_alert(store, app, alert_id, project).await
}

// ── Visual Reports (Inari Eye) ───────────────────────────────────────────────
//
// 1:1 with the alert when source_integrations includes 'user_report'. The
// AlertDetailPanel checks for that source and fetches this when present.
//
// Schema mirrors VisualReportDetailResponse in
// web/app/api/desktop/visual-report/[alertId]/route.ts.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualReportEvidence {
    pub claim:  String,
    #[serde(rename = "type")]
    pub kind:   String,
    pub source: String,
    pub quote:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualReportHypothesis {
    pub hypothesis:       String,
    pub score:            i32,
    pub rejected_because: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualReportRootCause {
    pub file:         String,
    pub line:         i32,
    #[serde(rename = "function")]
    pub function_name: String,
    pub causal_chain: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualReportDiagnosis {
    pub root_cause:            VisualReportRootCause,
    pub evidence:              Vec<VisualReportEvidence>,
    #[serde(default)]
    pub hypotheses_considered: Vec<VisualReportHypothesis>,
    pub confidence:            i32,
    pub unknowns:              Vec<String>,
    pub recommended_fix_hint:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualReportDetail {
    #[serde(rename = "reportId")]
    pub report_id:      String,
    #[serde(rename = "alertId")]
    pub alert_id:       String,
    #[serde(rename = "screenshotUrl")]
    pub screenshot_url: String,
    pub description:    String,
    pub status:         String,
    #[serde(default)]
    pub confidence:     Option<i32>,
    #[serde(default)]
    pub diagnosis:      Option<VisualReportDiagnosis>,
    #[serde(rename = "modelDiagnose", default)]
    pub model_diagnose: Option<String>,
    #[serde(rename = "durationMs", default)]
    pub duration_ms:    Option<i32>,
    #[serde(rename = "costCents", default)]
    pub cost_cents:     i32,
    #[serde(default)]
    pub error:          Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at:     String,
    #[serde(rename = "updatedAt")]
    pub updated_at:     String,
}

/// Fetch the visual_report row paired with an alert. Returns Err with a
/// 404-shaped message when no visual_report exists for the alert (caller
/// should render the panel without the visual-report section in that case).
pub async fn get_visual_report(
    store:    &Store,
    app:      Option<&AppHandle>,
    alert_id: &str,
) -> Result<VisualReportDetail, String> {
    if alert_id.is_empty() {
        return Err("alert_id required".to_string());
    }
    let creds = read_dashboard_creds(store);
    let path = format!("/api/desktop/visual-report/{}", urlencoding::encode(alert_id));
    fetch_json::<VisualReportDetail>(&creds, &path, app, store).await
}
