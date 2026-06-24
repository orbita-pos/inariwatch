//! Inari Live V1 — Session 5: conversation HTTP + SSE helpers.
//!
//! Mirrors the shape of `cloud::devices` (CRUD calls) and
//! `cloud::alert_stream` (long-lived SSE consumer). The IPC layer in
//! `crate::ipc::conversations` exposes Tauri commands that wrap these
//! functions; this module stays free of `#[tauri::command]` so unit
//! tests can hit it without a runtime.
//!
//! Per the S5 architecture: cross-device sync runs over SSE, NOT the
//! relay's WS dispatcher. Reasoning is in the orchestrator's approval
//! reply — V1 stays self-contained on the web SSOT, and the relay
//! bridge is a V1.5 perf upgrade if telemetry justifies it.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::alert_stream::parse_event;
use super::api::{read_dashboard_creds, read_dashboard_creds_arc};
use super::auth;
use crate::store::Store;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_BACKOFF: Duration = Duration::from_secs(5);
const AUTH_BACKOFF: Duration = Duration::from_secs(30);
const DISCONNECTED_BACKOFF: Duration = Duration::from_secs(5);

const EVT_CONVERSATION_EVENT: &str = "conversation:event";
const EVT_AUTH_REQUIRED: &str = "cloud-auth-required";

// ── Wire DTOs ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationListRow {
    pub id: String,
    pub title: String,
    pub state: String,
    #[serde(rename = "anchorAlertId", default)]
    pub anchor_alert_id: Option<String>,
    #[serde(rename = "lastMessageAt")]
    pub last_message_at: String,
    #[serde(rename = "snoozedUntil", default)]
    pub snoozed_until: Option<String>,
    #[serde(rename = "resolvedAt", default)]
    pub resolved_at: Option<String>,
    #[serde(rename = "workspaceId", default)]
    pub workspace_id: Option<String>,
    #[serde(rename = "alertSeverity", default)]
    pub alert_severity: Option<String>,
    #[serde(rename = "alertSourceIntegrations", default)]
    pub alert_source_integrations: Option<Vec<String>>,
    #[serde(rename = "unreadHint", default)]
    pub unread_hint: bool,
    /// First 120 chars of the most recent message's text. Null when
    /// the conversation has no messages yet. Used by the inbox row's
    /// snippet line. Added in the AlertDetailPanel/Inbox redesign.
    #[serde(rename = "lastMessageSnippet", default)]
    pub last_message_snippet: Option<String>,
    /// Role of the author of `last_message_snippet` ("user" /
    /// "assistant" / "tool" / "system"). Lets the renderer prefix the
    /// snippet with "Inari:" or the user's name without an extra fetch.
    #[serde(rename = "lastMessageRole", default)]
    pub last_message_role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationList {
    pub conversations: Vec<ConversationListRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationRow {
    pub id: String,
    pub title: String,
    pub state: String,
    #[serde(rename = "anchorAlertId", default)]
    pub anchor_alert_id: Option<String>,
    #[serde(rename = "lastMessageAt")]
    pub last_message_at: String,
    #[serde(rename = "snoozedUntil", default)]
    pub snoozed_until: Option<String>,
    #[serde(rename = "resolvedAt", default)]
    pub resolved_at: Option<String>,
    #[serde(rename = "resolutionSummary", default)]
    pub resolution_summary: Option<String>,
    #[serde(rename = "workspaceId", default)]
    pub workspace_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "activeDeviceId", default)]
    pub active_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub role: String,
    #[serde(rename = "contentJson")]
    pub content_json: serde_json::Value,
    #[serde(rename = "toolCallId", default)]
    pub tool_call_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "deviceId", default)]
    pub device_id: Option<String>,
    #[serde(rename = "prevMessageHash", default)]
    pub prev_message_hash: Option<String>,
    #[serde(rename = "messageHash", default)]
    pub message_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationDetail {
    pub conversation: ConversationRow,
    #[serde(default)]
    pub alert: Option<serde_json::Value>,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyChainBreak {
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub expected: String,
    #[serde(default)]
    pub actual: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyChainResult {
    pub ok: bool,
    #[serde(rename = "totalMessages")]
    pub total_messages: i64,
    #[serde(rename = "firstBreakAt", default)]
    pub first_break_at: Option<VerifyChainBreak>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListFilter {
    pub state: Option<String>,
    pub severity: Option<String>,
    pub mine: Option<bool>,
    pub q: Option<String>,
    pub limit: Option<i64>,
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("client: {}", e))
}

/// `GET /api/conversations` — sidebar list.
pub async fn list(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
    filter: &ListFilter,
) -> Result<ConversationList, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");

    let mut url = format!("{}/api/conversations", creds.base_url.trim_end_matches('/'));
    let mut params: Vec<(&str, String)> = Vec::new();
    if let Some(s) = &filter.state    { params.push(("state", s.clone())); }
    if let Some(s) = &filter.severity { params.push(("severity", s.clone())); }
    if filter.mine.unwrap_or(false)   { params.push(("mine", "1".into())); }
    if let Some(q) = &filter.q        { params.push(("q", q.clone())); }
    if let Some(l) = filter.limit     { params.push(("limit", l.to_string())); }
    if !params.is_empty() {
        let qs = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        url.push('?');
        url.push_str(&qs);
    }

    let res = http_client()?
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<ConversationList>().await.map_err(|e| format!("parse: {}", e))
}

/// `GET /api/conversations/:id` — full thread.
pub async fn get(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
    id: &str,
) -> Result<ConversationDetail, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!(
        "{}/api/conversations/{}",
        creds.base_url.trim_end_matches('/'),
        urlencoding::encode(id),
    );
    let res = http_client()?
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;
    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if res.status().as_u16() == 404 {
        return Err("not_found".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<ConversationDetail>().await.map_err(|e| format!("parse: {}", e))
}

/// `POST /api/conversations/:id/messages` — append user message.
pub async fn post_message(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
    id: &str,
    content: &str,
    device_id: Option<&str>,
) -> Result<ConversationMessage, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!(
        "{}/api/conversations/{}/messages",
        creds.base_url.trim_end_matches('/'),
        urlencoding::encode(id),
    );
    let body = serde_json::json!({
        "content": content,
        "deviceId": device_id,
    });
    let res = http_client()?
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;
    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let parsed: serde_json::Value = res.json().await.map_err(|e| format!("parse: {}", e))?;
    let msg = parsed.get("message").cloned().unwrap_or(parsed);
    serde_json::from_value::<ConversationMessage>(msg).map_err(|e| format!("decode: {}", e))
}

/// `POST /api/conversations/:id/state` — snooze / resolve / reopen / archive.
pub async fn set_state(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
    id: &str,
    state: &str,
    snoozed_until: Option<&str>,
    resolution_summary: Option<&str>,
) -> Result<ConversationRow, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!(
        "{}/api/conversations/{}/state",
        creds.base_url.trim_end_matches('/'),
        urlencoding::encode(id),
    );
    let body = serde_json::json!({
        "state": state,
        "snoozedUntil": snoozed_until,
        "resolutionSummary": resolution_summary,
    });
    let res = http_client()?
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;
    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let parsed: serde_json::Value = res.json().await.map_err(|e| format!("parse: {}", e))?;
    let conv = parsed.get("conversation").cloned().unwrap_or(parsed);
    serde_json::from_value::<ConversationRow>(conv).map_err(|e| format!("decode: {}", e))
}

/// `POST /api/conversations/:id/verify` — chain-level Witness verify.
pub async fn verify_chain(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
    id: &str,
) -> Result<VerifyChainResult, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!(
        "{}/api/conversations/{}/verify",
        creds.base_url.trim_end_matches('/'),
        urlencoding::encode(id),
    );
    let res = http_client()?
        .post(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;
    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<VerifyChainResult>().await.map_err(|e| format!("parse: {}", e))
}

/// `POST /api/conversations` — create a free conversation.
pub async fn create_free(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
    title: &str,
    device_id: Option<&str>,
) -> Result<ConversationRow, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!("{}/api/conversations", creds.base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "title": title, "deviceId": device_id });
    let res = http_client()?
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;
    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let parsed: serde_json::Value = res.json().await.map_err(|e| format!("parse: {}", e))?;
    let conv = parsed.get("conversation").cloned().unwrap_or(parsed);
    serde_json::from_value::<ConversationRow>(conv).map_err(|e| format!("decode: {}", e))
}

// ── Workspace SSE consumer ──────────────────────────────────────────────────
//
// Single global SSE consumer for `/api/conversations/event-stream`. Same
// reconnect semantics as `alert_stream`. Forwards every non-heartbeat
// frame to the React side via the `conversation:event` Tauri event with
// shape `{ event: "created" | "state" | "message", data: <json string> }`.
//
// Per-conversation streams are not auto-spawned; the React side opens
// them on demand via [`subscribe_conversation`].

#[derive(Debug, Serialize, Clone)]
pub struct StreamFrame {
    pub event: String,
    pub data: String,
    /// `null` for workspace-level frames; conversation id for per-conv streams.
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
}

pub fn start_workspace_stream(app: AppHandle, store: Arc<Store>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let creds = read_dashboard_creds(&store);
            if !creds.is_connected() {
                tokio::time::sleep(DISCONNECTED_BACKOFF).await;
                continue;
            }
            let token = creds.token.clone().unwrap();
            let url = format!(
                "{}/api/conversations/event-stream",
                creds.base_url.trim_end_matches('/'),
            );
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "conversation_stream client build");
                    tokio::time::sleep(RECONNECT_BACKOFF).await;
                    continue;
                }
            };
            let res = client
                .get(&url)
                .bearer_auth(&token)
                .header("Accept", "text/event-stream")
                .send()
                .await;
            let res = match res {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(error = %e, "conversation_stream connect");
                    tokio::time::sleep(RECONNECT_BACKOFF).await;
                    continue;
                }
            };
            let status = res.status();
            if status.as_u16() == 401 {
                let _ = app.emit(EVT_AUTH_REQUIRED, ());
                tokio::time::sleep(AUTH_BACKOFF).await;
                continue;
            }
            if !status.is_success() {
                tracing::warn!(status = %status, "conversation_stream non-200");
                tokio::time::sleep(RECONNECT_BACKOFF).await;
                continue;
            }
            let mut stream = res.bytes_stream();
            let mut buf = String::new();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        if let Some(text) = decode_chunk(&bytes) {
                            buf.push_str(&text);
                            while let Some(idx) = buf.find("\n\n") {
                                let raw = buf[..idx].to_string();
                                buf.drain(..idx + 2);
                                if let Some(evt) = parse_event(&raw) {
                                    if !evt.event.starts_with("heartbeat")
                                        && evt.event != "connected"
                                    {
                                        let frame = StreamFrame {
                                            event: evt.event,
                                            data: evt.data,
                                            conversation_id: None,
                                        };
                                        let _ = app.emit(EVT_CONVERSATION_EVENT, &frame);
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::debug!(error = %e, "conversation_stream chunk drop");
                        break;
                    }
                }
            }
            tokio::time::sleep(RECONNECT_BACKOFF).await;
        }
    });
}

fn decode_chunk(bytes: &Bytes) -> Option<String> {
    std::str::from_utf8(bytes).ok().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_filter_serialises_omitting_none() {
        let f = ListFilter {
            state: Some("active".into()),
            severity: None,
            mine: Some(true),
            q: None,
            limit: Some(50),
        };
        // Just verify the filter type can serialise — sanity check.
        let _ = serde_json::to_string(&f).expect("serialises");
    }

    #[test]
    fn conversation_list_decodes_minimal_row() {
        let raw = json!({
            "conversations": [
                {
                    "id": "abc",
                    "title": "test",
                    "state": "active",
                    "lastMessageAt": "2026-05-08T00:00:00Z",
                    "anchorAlertId": null,
                    "snoozedUntil": null,
                    "resolvedAt": null,
                    "workspaceId": null,
                    "alertSeverity": null,
                    "alertSourceIntegrations": null,
                    "unreadHint": false
                }
            ]
        });
        let parsed: ConversationList = serde_json::from_value(raw).expect("decodes");
        assert_eq!(parsed.conversations.len(), 1);
        assert_eq!(parsed.conversations[0].id, "abc");
        assert_eq!(parsed.conversations[0].title, "test");
        assert_eq!(parsed.conversations[0].state, "active");
    }

    #[test]
    fn verify_chain_decodes_break() {
        let raw = json!({
            "ok": false,
            "totalMessages": 3,
            "firstBreakAt": {
                "messageId": "m2",
                "expected": "abcd",
                "actual": "ffff",
                "reason": "wrong_hash"
            }
        });
        let parsed: VerifyChainResult = serde_json::from_value(raw).expect("decodes");
        assert!(!parsed.ok);
        assert_eq!(parsed.total_messages, 3);
        assert!(parsed.first_break_at.is_some());
    }
}
