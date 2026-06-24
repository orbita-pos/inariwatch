//! v0.3 Phase A — SSE client for `/api/alerts/stream`.
//!
//! The web SSE route polls the DB every 10 s and emits an `alerts`
//! event with the recent slice. We forward each event verbatim to the
//! frontend as a Tauri `cloud-alerts-update` event so the right-side
//! dashboard panel can refresh without polling on its own.
//!
//! Reconnect policy: drop → wait 5 s → reconnect. The web side currently
//! caps each connection at 55 s (Vercel hard 60 s limit), so a healthy
//! channel sees a clean drop ~once a minute and we reconnect on the
//! 5 s back-off. 401 → emit `cloud-auth-required` and back off 30 s.
//!
//! NOT a polling loop — runs as long as a token is configured, sleeps
//! when disconnected, returns to top of the reconnect loop on every
//! drop. One global instance per app process; idempotent across
//! lifetime.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::api::read_dashboard_creds;
use crate::store::Store;

const RECONNECT_BACKOFF: Duration = Duration::from_secs(5);
const AUTH_BACKOFF:      Duration = Duration::from_secs(30);
/// Disconnected polling cadence. Sleeping a full 5 s when the user has
/// not yet connected wastes nothing — the loop wakes back up the moment
/// the dashboard token is persisted.
const DISCONNECTED_BACKOFF: Duration = Duration::from_secs(5);

const EVT_ALERTS_UPDATE: &str = "cloud-alerts-update";
const EVT_AUTH_REQUIRED: &str = "cloud-auth-required";

#[derive(Debug, Serialize, Clone)]
pub struct StreamEvent {
    /// Event name from the SSE stream (`alerts`, `connected`, …). The
    /// frontend keys behaviour off this — `alerts` triggers a refetch
    /// of the alerts widget; everything else is heartbeat noise.
    pub event: String,
    /// Raw JSON payload, opaque to the Rust side.
    pub data:  String,
}

/// Spawn the persistent SSE client task. Idempotent — call once from
/// `setup`. Like the alert poller, the loop survives token churn: it
/// re-reads creds on every iteration so logout + login takes effect on
/// the next cycle without an app restart.
pub fn start(app: AppHandle, store: Arc<Store>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let creds = read_dashboard_creds(&store);
            if !creds.is_connected() {
                tokio::time::sleep(DISCONNECTED_BACKOFF).await;
                continue;
            }

            let token = creds.token.clone().unwrap();
            let url = format!(
                "{}/api/alerts/stream",
                creds.base_url.trim_end_matches('/'),
            );

            let client = reqwest::Client::builder()
                // SSE never closes from the server before 55 s, so a
                // long timeout keeps the channel up; the wrapper loop
                // is responsible for reconnecting after each drop.
                .timeout(Duration::from_secs(0).max(Duration::from_secs(60)))
                .build();
            let client = match client {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "alert_stream client build");
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
                    tracing::warn!(error = %e, "alert_stream connect");
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
                tracing::warn!(status = %status, "alert_stream non-200");
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
                            // Each SSE event is `\n\n`-terminated. Drain
                            // every complete event from the buffer; what
                            // remains is the partial tail.
                            while let Some(idx) = buf.find("\n\n") {
                                let raw = buf[..idx].to_string();
                                buf.drain(..idx + 2);
                                if let Some(evt) = parse_event(&raw) {
                                    if !evt.event.starts_with("heartbeat") {
                                        let _ = app.emit(EVT_ALERTS_UPDATE, &evt);
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::debug!(error = %e, "alert_stream chunk drop");
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

/// Parse one SSE event block: lines beginning with `event:` and `data:`
/// concatenated until the blank-line terminator. Returns `None` if the
/// block has no data (e.g. comment-only `: heartbeat` ping).
pub(crate) fn parse_event(raw: &str) -> Option<StreamEvent> {
    let mut event = "message".to_string();
    let mut data = String::new();
    let mut had_data = false;
    for line in raw.lines() {
        if let Some(name) = line.strip_prefix("event:") {
            event = name.trim().to_string();
        } else if let Some(payload) = line.strip_prefix("data:") {
            if had_data { data.push('\n'); }
            data.push_str(payload.trim_start());
            had_data = true;
        }
        // SSE comment lines (`: heartbeat`) — ignore.
    }
    if had_data {
        Some(StreamEvent { event, data })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_event() {
        let raw = "event: alerts\ndata: {\"x\":1}";
        let evt = parse_event(raw).expect("should parse");
        assert_eq!(evt.event, "alerts");
        assert_eq!(evt.data, "{\"x\":1}");
    }

    #[test]
    fn parses_multiline_data() {
        let raw = "event: alerts\ndata: line1\ndata: line2";
        let evt = parse_event(raw).expect("should parse");
        assert_eq!(evt.event, "alerts");
        assert_eq!(evt.data, "line1\nline2");
    }

    #[test]
    fn defaults_event_name_to_message() {
        let raw = "data: {\"hello\":\"world\"}";
        let evt = parse_event(raw).expect("should parse");
        assert_eq!(evt.event, "message");
        assert_eq!(evt.data, "{\"hello\":\"world\"}");
    }

    #[test]
    fn ignores_heartbeat_only_block() {
        // SSE comment lines start with `:`; no data ever attached.
        let raw = ": heartbeat\n: another";
        assert!(parse_event(raw).is_none());
    }

    #[test]
    fn skips_blank_lines() {
        // The chunk splitter already strips the trailing \n\n, but inner
        // blanks shouldn't trip the parser.
        let raw = "\nevent: connected\n\ndata: {}\n";
        let evt = parse_event(raw).expect("should parse");
        assert_eq!(evt.event, "connected");
        assert_eq!(evt.data, "{}");
    }
}
