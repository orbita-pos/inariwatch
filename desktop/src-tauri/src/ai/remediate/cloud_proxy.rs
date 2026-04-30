// Cloud-proxied autofix bridge (RENAMED from `src/autofix.rs`).
//
// Two Tauri commands plus an SSE consumer:
//
//   1. `desktop_autofix_start` — POSTs the captured throw to
//      /api/desktop/autofix/start, then opens the SSE stream and
//      forwards each `event: ... data: ...` block to the webview as a
//      `autofix:event` Tauri event.
//
//   2. (status — TODO) quick lookup so the JS knows whether a given
//      session is already terminal.
//
// We do the SSE in Rust (not the webview) so the desktop token only
// lives in the SQL settings store + reqwest — never exposed to the JS
// side. Tauri's `app.emit` is the single channel back into the
// frontend, mirroring the pattern `inari_watcher.rs` already uses.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use tauri::{AppHandle, Emitter};

use crate::cloud::api::read_dashboard_creds;
use crate::store::Store;

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
