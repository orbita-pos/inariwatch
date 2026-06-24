//! Inari Live V1 — Session 5: Tauri-command shells for conversations.
//!
//! Thin pass-throughs to `crate::cloud::conversations`. The IPC layer
//! keeps the no-`reqwest` rule by delegating networking to the cloud
//! module. The React side calls these via the existing
//! `cloud-ipc.ts` style invoke pattern.
//!
//! Per-conversation SSE subscriptions are NOT auto-spawned — the React
//! side calls [`cloud_conversations_subscribe`] when the user opens a
//! thread, and [`cloud_conversations_unsubscribe`] (or implicitly, by
//! navigating away) tears it down.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::cloud::alert_stream::parse_event;
use crate::cloud::api::read_dashboard_creds;
use crate::cloud::conversations::{
    self, ConversationDetail, ConversationList, ConversationMessage, ConversationRow,
    ListFilter, StreamFrame, VerifyChainResult,
};
use crate::store::Store;

const RECONNECT_BACKOFF: Duration = Duration::from_secs(5);
const AUTH_BACKOFF: Duration = Duration::from_secs(30);
const EVT_CONVERSATION_EVENT: &str = "conversation:event";
const EVT_AUTH_REQUIRED: &str = "cloud-auth-required";

/// Map of conversationId → JoinHandle for an active per-conversation
/// SSE subscription. Held in `tauri::State` so the IPC layer can spawn
/// + cancel without leaking tasks. We store JoinHandle (not AbortHandle)
/// because Tauri's `async_runtime::JoinHandle` exposes `abort()` directly
/// without going through tokio's `task::AbortHandle`.
#[derive(Default)]
pub struct ConversationSubscriptions {
    inner: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl ConversationSubscriptions {
    pub fn new() -> Self {
        Self::default()
    }
}

// Per-conversation SSE consumer emits frames using `cloud::conversations::StreamFrame`
// directly so the JS event listener can be a single switch on `event`. The
// distinction from workspace frames is that `conversation_id` is set rather
// than null.

#[tauri::command]
pub async fn cloud_conversations_list(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    filter: Option<ListFilter>,
) -> Result<ConversationList, String> {
    let store = state.inner().clone();
    let f = filter.unwrap_or_default();
    conversations::list(Some(&app), &store, &f).await
}

#[tauri::command]
pub async fn cloud_conversations_get(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    id: String,
) -> Result<ConversationDetail, String> {
    let store = state.inner().clone();
    conversations::get(Some(&app), &store, &id).await
}

#[tauri::command]
pub async fn cloud_conversations_post_message(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    id: String,
    content: String,
    device_id: Option<String>,
) -> Result<ConversationMessage, String> {
    let store = state.inner().clone();
    conversations::post_message(Some(&app), &store, &id, &content, device_id.as_deref()).await
}

#[tauri::command]
pub async fn cloud_conversations_set_state(
    app: AppHandle,
    state_handle: tauri::State<'_, Arc<Store>>,
    id: String,
    state: String,
    snoozed_until: Option<String>,
    resolution_summary: Option<String>,
) -> Result<ConversationRow, String> {
    let store = state_handle.inner().clone();
    conversations::set_state(
        Some(&app),
        &store,
        &id,
        &state,
        snoozed_until.as_deref(),
        resolution_summary.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn cloud_conversations_verify_chain(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    id: String,
) -> Result<VerifyChainResult, String> {
    let store = state.inner().clone();
    conversations::verify_chain(Some(&app), &store, &id).await
}

#[tauri::command]
pub async fn cloud_conversations_create_free(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    title: String,
    device_id: Option<String>,
) -> Result<ConversationRow, String> {
    let store = state.inner().clone();
    conversations::create_free(Some(&app), &store, &title, device_id.as_deref()).await
}

/// Open a per-conversation SSE subscription. Idempotent — calling
/// twice for the same id keeps the existing task and returns Ok.
/// Tear down with [`cloud_conversations_unsubscribe`].
#[tauri::command]
pub async fn cloud_conversations_subscribe(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    subs: tauri::State<'_, Arc<ConversationSubscriptions>>,
    id: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    let mut guard = subs.inner.lock().await;
    if guard.contains_key(&id) {
        return Ok(());
    }

    let conv_id = id.clone();
    let handle_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        run_conversation_stream(handle_app, store, conv_id).await;
    });
    guard.insert(id, task);
    Ok(())
}

#[tauri::command]
pub async fn cloud_conversations_unsubscribe(
    subs: tauri::State<'_, Arc<ConversationSubscriptions>>,
    id: String,
) -> Result<(), String> {
    let mut guard = subs.inner.lock().await;
    if let Some(handle) = guard.remove(&id) {
        handle.abort();
    }
    Ok(())
}

/// Per-conversation SSE consumer. Same reconnect semantics as the
/// workspace stream. Forwards every non-heartbeat frame as a
/// `conversation:event` Tauri event tagged with the conversation id.
async fn run_conversation_stream(app: AppHandle, store: Arc<Store>, conv_id: String) {
    loop {
        let creds = read_dashboard_creds(&store);
        if !creds.is_connected() {
            tokio::time::sleep(RECONNECT_BACKOFF).await;
            continue;
        }
        let token = creds.token.clone().unwrap();
        let url = format!(
            "{}/api/conversations/{}/event-stream",
            creds.base_url.trim_end_matches('/'),
            urlencoding::encode(&conv_id),
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
        if status.as_u16() == 404 {
            // Conversation deleted/inaccessible — exit task.
            tracing::info!(conv = %conv_id, "conversation_stream 404, ending task");
            return;
        }
        if !status.is_success() {
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
                                        conversation_id: Some(conv_id.clone()),
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
}

fn decode_chunk(bytes: &Bytes) -> Option<String> {
    std::str::from_utf8(bytes).ok().map(|s| s.to_string())
}
