// Cloud-proxied remediation bridge (renamed from `cloud_proxy.rs`
// in Sesión 19; originally `src/autofix.rs` pre-Sesión-4).
//
// Sesión 4 surface (kept as-is):
//   `desktop_autofix_start` — POSTs the captured throw to
//   /api/desktop/autofix/start, then opens the SSE stream and forwards
//   each `event: ... data: ...` block to the webview as an
//   `autofix:event` Tauri event. We do the SSE in Rust (not the
//   webview) so the desktop token only lives in the SQL settings store
//   + reqwest — never exposed to the JS side.
//
// Sesión 19 addition: `run_cloud_agentic` — invoked by the
// orchestrator on the cloud path. POSTs to
// `/api/cli/remediation/trigger`, then opens
// `/api/remediation/stream/<id>` and translates each progress event
// into a `DaemonEvent::RemediationProgress` on the bus. Terminal events
// produce `RemediationCompleted`. The orchestrator persists state
// transitions in `remediation_sessions`.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use tauri::{AppHandle, Emitter};

use crate::cloud::api::read_dashboard_creds;
use crate::daemon::{DaemonEvent, DaemonHandle};
use crate::store::{queries, settings, Store};

#[derive(Deserialize)]
pub struct AutofixStartArgs {
    pub project_id:   String,
    pub recording_id: Option<String>,
    pub fingerprint:  Option<String>,
    pub throw_detail: Json,
}

#[derive(Serialize)]
struct StartBody<'a> {
    project_id:    &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    recording_id:  Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint:   Option<&'a str>,
    throw_detail:  &'a Json,
}

#[derive(Deserialize)]
struct StartResponse {
    session_id: String,
    alert_id:   String,
}

#[derive(Serialize)]
pub struct AutofixStarted {
    pub session_id: String,
    pub alert_id:   String,
}

#[tauri::command]
pub async fn desktop_autofix_start(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    args: AutofixStartArgs,
) -> Result<AutofixStarted, String> {
    let creds = read_dashboard_creds(&state);
    let token = creds
        .token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "Not connected — click Connect in Inari Live first.".to_string())?;
    let base_url = creds.base_url;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    // Step 1 — create the alert + session.
    let start_body = StartBody {
        project_id:   &args.project_id,
        recording_id: args.recording_id.as_deref(),
        fingerprint:  args.fingerprint.as_deref(),
        throw_detail: &args.throw_detail,
    };
    let start_url = format!(
        "{}/api/desktop/autofix/start",
        base_url.trim_end_matches('/'),
    );
    let res = http
        .post(&start_url)
        .bearer_auth(&token)
        .json(&start_body)
        .send()
        .await
        .map_err(|e| format!("start: {}", e))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("start returned {}: {}", status, body));
    }
    let parsed: StartResponse = res
        .json()
        .await
        .map_err(|e| format!("start parse: {}", e))?;

    // Step 2 — open the SSE stream in a detached task so we can return
    // the session_id to the frontend immediately.
    let app2 = app.clone();
    let sid = parsed.session_id.clone();
    let cfg_url = base_url.clone();
    let cfg_tok = token.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = stream_autofix(app2.clone(), &cfg_url, &cfg_tok, &sid).await {
            let _ = app2.emit(
                "autofix:event",
                serde_json::json!({
                    "session_id": sid,
                    "event":      "stream_error",
                    "data":       { "error": e },
                }),
            );
        }
    });

    Ok(AutofixStarted {
        session_id: parsed.session_id,
        alert_id:   parsed.alert_id,
    })
}

async fn stream_autofix(
    app:        AppHandle,
    base_url:   &str,
    token:      &str,
    session_id: &str,
) -> Result<(), String> {
    // SSE streams must not time out — the engine can take minutes.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20 * 60))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    let url = format!(
        "{}/api/desktop/autofix/stream/{}",
        base_url.trim_end_matches('/'),
        session_id,
    );

    let res = http
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| format!("stream: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("stream returned {}", res.status()));
    }

    let mut buf = String::new();
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("chunk: {}", e))?;
        let s = std::str::from_utf8(&chunk).map_err(|e| format!("utf8: {}", e))?;
        buf.push_str(s);

        while let Some(idx) = buf.find("\n\n") {
            let raw = buf[..idx].to_string();
            buf.drain(..(idx + 2));

            let (event, data) = parse_sse_block(&raw);
            if event.is_empty() && data.is_empty() {
                continue;
            }
            let parsed_data: Json = serde_json::from_str(&data).unwrap_or(Json::Null);
            let _ = app.emit(
                "autofix:event",
                serde_json::json!({
                    "session_id": session_id,
                    "event":      event,
                    "data":       parsed_data,
                }),
            );

            if event == "done" {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn parse_sse_block(raw: &str) -> (String, String) {
    let mut event = String::new();
    let mut data  = String::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            event = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() { data.push('\n'); }
            data.push_str(rest.trim_start());
        }
    }
    (event, data)
}

// ─────────────────────────────────────────────────────────────────────
// Sesión 19 — cloud agentic path (separate from Sesión 4's `autofix`)
// ─────────────────────────────────────────────────────────────────────

/// Default cloud base URL. Tests + future "self-hosted" users override
/// via the `cloud_base_url` setting.
const DEFAULT_CLOUD_BASE: &str = "https://app.inariwatch.com";

/// Settings KV key for the API token used on the cloud agentic path.
/// Distinct from `dashboard_token` (which is the device-flow auth from
/// Sesión 4) so a future "Connect this repo to a different workspace"
/// flow can plumb a per-repo token without breaking existing auth.
const SETTINGS_KEY_API_TOKEN:    &str = "cloud_api_token";
const SETTINGS_KEY_CLOUD_BASE:   &str = "cloud_base_url";

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("no cloud credentials — connect Inari Live to a workspace first")]
    NoCloudCredentials,
    #[error("HTTP: {0}")]
    Http(#[from] reqwest::Error),
    #[error("cloud returned {status}: {body}")]
    CloudApi { status: u16, body: String },
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    #[error("store: {0}")]
    Store(#[from] crate::store::StoreError),
}

/// Inputs the orchestrator hands the cloud path. The session id is
/// reused as the dock-side row key; the cloud endpoint may issue its
/// own server session id which we treat as opaque (logged but not
/// otherwise used).
#[derive(Debug, Clone)]
pub struct CloudInput {
    pub session_id:        String,
    pub repo_id:           String,
    pub error_message:     String,
    pub stack_trace:       Option<String>,
    pub error_fingerprint: Option<String>,
}

#[derive(Serialize)]
struct CloudTriggerBody<'a> {
    repo_id:                  &'a str,
    error_message:            &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stack_trace:              Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_fingerprint:        Option<&'a str>,
    /// Lets the cloud correlate its row with our local session id when
    /// a future post-completion lookup needs it.
    desktop_session_id:       &'a str,
}

#[derive(Deserialize)]
struct CloudTriggerResponse {
    /// Cloud-issued session id. Logged for support only.
    #[serde(default)]
    session_id: String,
}

/// Run the cloud agentic remediation. Returns when the SSE stream ends
/// (the orchestrator's spawned task drives this). Emits
/// `RemediationProgress` per event + a single `RemediationCompleted`
/// on terminal `done` / `error`.
///
/// Network IO uses a long-timeout client because the agentic loop on
/// the cloud side can take several minutes — same posture as the
/// Sesión 4 `desktop_autofix_start` SSE consumer.
pub async fn run_cloud_agentic(
    store:  &Arc<Store>,
    daemon: &Arc<DaemonHandle>,
    input:  CloudInput,
) -> Result<(), ProxyError> {
    let token = settings::get(store, SETTINGS_KEY_API_TOKEN)?
        .filter(|t| !t.trim().is_empty())
        .ok_or(ProxyError::NoCloudCredentials)?;
    let base = settings::get(store, SETTINGS_KEY_CLOUD_BASE)?
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLOUD_BASE.to_string());

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(ProxyError::Http)?;

    let trigger_url = format!("{}/api/cli/remediation/trigger", base.trim_end_matches('/'));
    let body = CloudTriggerBody {
        repo_id:           &input.repo_id,
        error_message:     &input.error_message,
        stack_trace:       input.stack_trace.as_deref(),
        error_fingerprint: input.error_fingerprint.as_deref(),
        desktop_session_id: &input.session_id,
    };
    let resp = http
        .post(&trigger_url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body   = resp.text().await.unwrap_or_default();
        return Err(ProxyError::CloudApi { status, body });
    }
    let parsed: CloudTriggerResponse = resp
        .json()
        .await
        .map_err(|e| ProxyError::InvalidResponse(e.to_string()))?;
    let server_id = if parsed.session_id.is_empty() {
        input.session_id.clone()
    } else {
        parsed.session_id
    };

    // Open the SSE stream. The endpoint is the same `<base>/api/remediation/stream/<id>`
    // shape the web app uses for in-app remediations.
    let stream_url = format!(
        "{}/api/remediation/stream/{}",
        base.trim_end_matches('/'),
        server_id,
    );
    let stream_http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20 * 60))
        .build()
        .map_err(ProxyError::Http)?;
    let res = stream_http
        .get(&stream_url)
        .bearer_auth(&token)
        .header("Accept", "text/event-stream")
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(ProxyError::CloudApi {
            status: res.status().as_u16(),
            body:   format!("stream open: {}", res.status()),
        });
    }

    let mut buf = String::new();
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;

    let mut completed = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let s = match std::str::from_utf8(&chunk) {
            Ok(s)  => s,
            Err(_) => continue,
        };
        buf.push_str(s);

        while let Some(idx) = buf.find("\n\n") {
            let raw = buf[..idx].to_string();
            buf.drain(..(idx + 2));

            let (event, data) = parse_sse_block(&raw);
            if event.is_empty() && data.is_empty() {
                continue;
            }
            handle_cloud_event(store, daemon, &input.session_id, &event, &data, &mut completed)?;
            if completed {
                return Ok(());
            }
        }
    }

    if !completed {
        // Stream ended without a terminal event — treat as failure so
        // the row doesn't sit forever in `pending`.
        let _ = queries::update_remediation_session(
            store,
            &input.session_id,
            &queries::RemediationUpdate {
                state:           Some(queries::RemediationState::Failed),
                completed_at_ms: Some(now_ms()),
                ..Default::default()
            },
        );
        daemon.bus.publish(DaemonEvent::RemediationCompleted {
            session_id: input.session_id.clone(),
            success:    false,
            summary:    "Cloud stream ended without a terminal event".to_string(),
        });
    }
    Ok(())
}

fn handle_cloud_event(
    store:      &Arc<Store>,
    daemon:     &Arc<DaemonHandle>,
    session_id: &str,
    event:      &str,
    data:       &str,
    completed:  &mut bool,
) -> Result<(), ProxyError> {
    let parsed: Json = serde_json::from_str(data).unwrap_or(Json::Null);
    match event {
        // Terminal: cloud created a PR + the agentic loop succeeded.
        "completed" | "done" | "success" => {
            let pr_url = parsed.get("pr_url").and_then(|v| v.as_str());
            let commit = parsed.get("commit_sha").and_then(|v| v.as_str());
            queries::update_remediation_session(
                store,
                session_id,
                &queries::RemediationUpdate {
                    state:           Some(queries::RemediationState::Applied),
                    pr_url,
                    commit_sha:      commit,
                    completed_at_ms: Some(now_ms()),
                    ..Default::default()
                },
            )?;
            let summary = match pr_url {
                Some(u) => format!("PR opened: {u}"),
                None    => "Cloud remediation succeeded".to_string(),
            };
            daemon.bus.publish(DaemonEvent::RemediationCompleted {
                session_id: session_id.to_string(),
                success:    true,
                summary,
            });
            *completed = true;
        }
        "error" | "failed" => {
            let reason = parsed.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
            queries::update_remediation_session(
                store,
                session_id,
                &queries::RemediationUpdate {
                    state:           Some(queries::RemediationState::Failed),
                    completed_at_ms: Some(now_ms()),
                    ..Default::default()
                },
            )?;
            daemon.bus.publish(DaemonEvent::RemediationCompleted {
                session_id: session_id.to_string(),
                success:    false,
                summary:    format!("Cloud error: {reason}"),
            });
            *completed = true;
        }
        // Non-terminal progress signal. Prefer the inner `stage`
        // field when present (e.g. `{"stage":"clone","message":"…"}`)
        // since the SSE event name is often just `progress` for the
        // whole sequence; the more specific stage lives in the body.
        _ => {
            let stage = parsed
                .get("stage")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if event.is_empty() { "progress".to_string() } else { event.to_string() }
                });
            let message = parsed
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or(data)
                .chars()
                .take(200)
                .collect::<String>();
            daemon.bus.publish(DaemonEvent::RemediationProgress {
                session_id: session_id.to_string(),
                stage,
                message,
            });
        }
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_block_extracts_event_and_data() {
        let (event, data) = parse_sse_block("event: progress\ndata: {\"stage\":\"clone\"}");
        assert_eq!(event, "progress");
        assert_eq!(data, "{\"stage\":\"clone\"}");
    }

    #[test]
    fn parse_sse_block_handles_multi_line_data() {
        let (event, data) = parse_sse_block("event: x\ndata: line1\ndata: line2");
        assert_eq!(event, "x");
        assert_eq!(data, "line1\nline2");
    }
}
