//! Inari Live ↔ relay.inariwatch.com WS client (v0.3 S2).
//!
//! Per `INARI_AI_ARCHITECTURE.md` §4 (LOCKED 2026-05-02): on app start
//! the desktop binary opens a long-lived WebSocket to the relay, sends a
//! `register` frame with the user's capabilities, and stays connected
//! while the app runs. When the connection drops we reconnect with
//! exponential backoff (1s → 30s ceiling). The relay forwards `dispatch`
//! frames here when the InariWatch cloud router decides a task should
//! run on the user's box (notify.compose.*, voice.tts, etc.).
//!
//! S2 ships only the registration + reconnect plumbing + a stub
//! dispatch handler that replies `{ ok, body: { stub: true } }`. Real
//! task execution lands in v0.3 S3 (`notify.compose.email` is the
//! first task wired to a local model).
//!
//! Tauri integration: state changes (Connected / Reconnecting /
//! Disconnected) are surfaced via the `relay:state` event for the
//! frontend to render an indicator. Wiring happens in `lib.rs` via
//! `relay_client::spawn(...)` after the auth/store handles are ready.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::task::JoinHandle;

// ── Capabilities advertised on register ─────────────────────────────────────
//
// Aligned with INARI_AI_ARCHITECTURE.md §3 (substrate = "user-sidecar").
// The relay routes `notify.compose.*`, `voice.tts.*`, `chat.conversational`,
// and `redact.*` here when the user has Inari Live online and the workspace
// flag is on. Until S3 wires real handlers we still advertise the full
// surface so the relay's online-user view is honest.

pub const CAPABILITIES: &[&str] = &[
    "notify.compose.email",
    "notify.compose.slack",
    "notify.compose.telegram",
    "notify.compose.whatsapp",
    "notify.compose.push",
    "notify.compose.digest",
    "notify.compose.status-page",
    "notify.compose.postmortem-prose",
    "voice.tts.alert",
    "voice.tts.digest",
    "chat.conversational",
    "redact.pii.breadcrumbs",
    "redact.pii.stacktrace",
];

// ── State / events ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

impl RelayState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RelayState::Disconnected => "disconnected",
            RelayState::Connecting => "connecting",
            RelayState::Connected => "connected",
            RelayState::Reconnecting => "reconnecting",
        }
    }
}

// ── Frames ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct RegisterFrame {
    #[serde(rename = "type")]
    ty: &'static str,
    capabilities: Vec<String>,
    app_version: String,
    os: String,
    arch: String,
}

impl RegisterFrame {
    pub fn build(app_version: impl Into<String>) -> Self {
        Self {
            ty: "register",
            capabilities: CAPABILITIES.iter().map(|s| s.to_string()).collect(),
            app_version: app_version.into(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DispatchFrame {
    #[serde(rename = "type")]
    pub ty: String,
    pub request_id: String,
    pub task: String,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResponseFrame {
    #[serde(rename = "type")]
    pub ty: &'static str,
    pub request_id: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Backoff ─────────────────────────────────────────────────────────────────

/// Exponential backoff: 1s, 2s, 4s, 8s, 16s, then capped at 30s. Adds
/// up to ±20% jitter so reconnect storms after a relay restart don't
/// stampede.
#[derive(Debug, Clone)]
pub struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub fn new() -> Self {
        Self { attempt: 0 }
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Returns the next sleep duration AND advances the attempt counter.
    pub fn next(&mut self) -> Duration {
        let base_secs = match self.attempt {
            0 => 1,
            1 => 2,
            2 => 4,
            3 => 8,
            4 => 16,
            _ => 30,
        };
        self.attempt = self.attempt.saturating_add(1);
        let jitter_pct = (rand::random::<f32>() * 0.4) - 0.2; // ±20%
        let dur = (base_secs as f32 * (1.0 + jitter_pct)).max(0.5);
        Duration::from_secs_f32(dur)
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }
}

// ── Public client handle ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RelayClient {
    state_tx: broadcast::Sender<RelayState>,
    cmd_tx: mpsc::Sender<Cmd>,
    inner: Arc<RelayClientInner>,
}

#[derive(Debug)]
struct RelayClientInner {
    /// Atomic snapshot of the latest state — survives broadcast lag for
    /// new subscribers.
    last_state: AtomicU32,
    /// JoinHandle for the supervisor task. Held in a Mutex so `shutdown`
    /// can take and await it.
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Debug)]
enum Cmd {
    Shutdown,
}

impl RelayClient {
    pub fn current_state(&self) -> RelayState {
        match self.inner.last_state.load(Ordering::Relaxed) {
            0 => RelayState::Disconnected,
            1 => RelayState::Connecting,
            2 => RelayState::Connected,
            3 => RelayState::Reconnecting,
            _ => RelayState::Disconnected,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RelayState> {
        self.state_tx.subscribe()
    }

    pub async fn shutdown(&self) {
        let _ = self.cmd_tx.send(Cmd::Shutdown).await;
        let mut guard = self.inner.supervisor.lock().await;
        if let Some(h) = guard.take() {
            let _ = h.await;
        }
    }
}

// ── Config ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// e.g. `wss://relay.inariwatch.com`. Stripped of trailing slash.
    pub base_url: String,
    /// HS256 user JWT issued by web on Inari Live login.
    pub jwt: String,
    /// `Cargo.toml` package version, plumbed through `env!("CARGO_PKG_VERSION")`.
    pub app_version: String,
    /// Override for tests. Production callers leave this `None` to get the
    /// default exponential backoff.
    pub initial_backoff: Option<Backoff>,
}

impl RelayConfig {
    pub fn ws_url(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if base.ends_with("/ws") {
            base.to_string()
        } else {
            format!("{}/ws", base)
        }
    }
}

// ── Spawn ──────────────────────────────────────────────────────────────────

/// Spawns the supervisor task. Returns immediately with a handle; the
/// task runs in the background until `RelayClient::shutdown` is called.
///
/// Failure to connect is non-fatal: the supervisor backs off and tries
/// again. Sidecar dispatch handlers degrade to a stub response in S2 —
/// real tasks are wired in v0.3 S3.
pub fn spawn(cfg: RelayConfig) -> RelayClient {
    let (state_tx, _) = broadcast::channel::<RelayState>(8);
    let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(4);

    let inner = Arc::new(RelayClientInner {
        last_state: AtomicU32::new(0),
        supervisor: Mutex::new(None),
    });

    let supervisor = tokio::spawn(supervisor_loop(
        cfg,
        state_tx.clone(),
        cmd_rx,
        inner.clone(),
    ));

    let supervisor_owner = inner.clone();
    tokio::spawn(async move {
        let mut guard = supervisor_owner.supervisor.lock().await;
        *guard = Some(supervisor);
    });

    RelayClient {
        state_tx,
        cmd_tx,
        inner,
    }
}

fn publish_state(
    inner: &RelayClientInner,
    tx: &broadcast::Sender<RelayState>,
    s: RelayState,
) {
    inner.last_state.store(s as u32, Ordering::Relaxed);
    let _ = tx.send(s);
}

#[cfg(test)]
mod backoff_tests {
    use super::*;

    #[test]
    fn backoff_progresses_exponentially() {
        let mut b = Backoff::new();
        let mut bases = Vec::new();
        for _ in 0..7 {
            bases.push(b.next().as_secs_f32());
        }
        // Lower bounds (assuming -20% jitter floor) — ensure each window
        // strictly contains the doubling base.
        assert!(bases[0] < 1.5);
        assert!(bases[1] >= 1.5 && bases[1] < 3.0);
        assert!(bases[2] >= 3.0 && bases[2] < 5.5);
        assert!(bases[3] >= 6.0 && bases[3] < 10.5);
        assert!(bases[4] >= 12.0 && bases[4] < 20.5);
        // Cap at 30s ± 20% — both 5th and 6th attempt sit in the
        // 24..36 window.
        assert!(bases[5] >= 24.0 && bases[5] < 36.5);
        assert!(bases[6] >= 24.0 && bases[6] < 36.5);
        assert_eq!(b.attempt(), 7);
    }

    #[test]
    fn backoff_reset_starts_over() {
        let mut b = Backoff::new();
        for _ in 0..5 {
            b.next();
        }
        b.reset();
        assert_eq!(b.attempt(), 0);
        let first = b.next().as_secs_f32();
        assert!(first < 1.5);
    }

    #[test]
    fn register_frame_carries_capabilities_and_meta() {
        let frame = RegisterFrame::build("0.3.0");
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "register");
        assert_eq!(json["app_version"], "0.3.0");
        assert!(json["os"].is_string());
        assert!(json["arch"].is_string());
        let caps = json["capabilities"].as_array().expect("array");
        assert!(caps.len() >= 13);
        assert!(caps.iter().any(|v| v == "notify.compose.email"));
        assert!(caps.iter().any(|v| v == "voice.tts.alert"));
        assert!(caps.iter().any(|v| v == "redact.pii.breadcrumbs"));
    }

    #[test]
    fn ws_url_appends_path() {
        let cfg = RelayConfig {
            base_url: "wss://relay.inariwatch.com/".into(),
            jwt: "x".into(),
            app_version: "0.3.0".into(),
            initial_backoff: None,
        };
        assert_eq!(cfg.ws_url(), "wss://relay.inariwatch.com/ws");

        let cfg2 = RelayConfig {
            base_url: "wss://relay.inariwatch.com/ws".into(),
            jwt: "x".into(),
            app_version: "0.3.0".into(),
            initial_backoff: None,
        };
        assert_eq!(cfg2.ws_url(), "wss://relay.inariwatch.com/ws");
    }

    #[test]
    fn relay_state_serializes_snake_case() {
        let s = RelayState::Reconnecting;
        let raw = serde_json::to_string(&s).unwrap();
        assert_eq!(raw, "\"reconnecting\"");
        let back: RelayState = serde_json::from_str("\"connected\"").unwrap();
        assert_eq!(back, RelayState::Connected);
    }

    #[test]
    fn dispatch_frame_deserializes_with_optional_timeout() {
        let raw = r#"{"type":"dispatch","request_id":"r1","task":"notify.compose.email","payload":{"alert":"x"}}"#;
        let df: DispatchFrame = serde_json::from_str(raw).unwrap();
        assert_eq!(df.ty, "dispatch");
        assert_eq!(df.request_id, "r1");
        assert_eq!(df.task, "notify.compose.email");
        assert_eq!(df.timeout_ms, 0);
    }

    #[test]
    fn stub_response_round_trips_request_id_and_task() {
        let df = DispatchFrame {
            ty: "dispatch".into(),
            request_id: "rid-77".into(),
            task: "voice.tts.alert".into(),
            payload: serde_json::json!({"text": "hi"}),
            timeout_ms: 0,
        };
        let resp = build_stub_response(&df);
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["type"], "response");
        assert_eq!(json["request_id"], "rid-77");
        assert_eq!(json["status"], "ok");
        assert_eq!(json["body"]["task"], "voice.tts.alert");
        assert_eq!(json["body"]["stub"], true);
        // No error field serialized when None.
        assert!(json.get("error").is_none());
        assert!(json.get("receipt").is_none());
    }
}

// ── Supervisor loop ─────────────────────────────────────────────────────────

async fn supervisor_loop(
    cfg: RelayConfig,
    state_tx: broadcast::Sender<RelayState>,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    inner: Arc<RelayClientInner>,
) {
    let mut backoff = cfg.initial_backoff.clone().unwrap_or_else(Backoff::new);
    publish_state(&inner, &state_tx, RelayState::Connecting);

    loop {
        // Surface the current attempt-count via state — Connecting on
        // first attempt, Reconnecting on subsequent ones. Mirrors
        // typical UI conventions (Slack/Discord).
        if backoff.attempt() > 0 {
            publish_state(&inner, &state_tx, RelayState::Reconnecting);
        }

        match connect_once(&cfg, &state_tx, &inner).await {
            Ok(disconnect_reason) => {
                tracing::info!(reason = %disconnect_reason, "[relay] connection closed; reconnecting");
                publish_state(&inner, &state_tx, RelayState::Disconnected);
                backoff.reset();
            }
            Err(err) => {
                tracing::warn!(error = %err, "[relay] connect failed");
                publish_state(&inner, &state_tx, RelayState::Disconnected);
            }
        }

        let sleep = backoff.next();
        tokio::select! {
            _ = tokio::time::sleep(sleep) => {}
            cmd = cmd_rx.recv() => {
                if matches!(cmd, Some(Cmd::Shutdown) | None) {
                    return;
                }
            }
        }
    }
}

// ── connect_once ────────────────────────────────────────────────────────────
//
// Real production path. Establishes a WS, sends `register`, pumps frames.
// The dispatch handler is a stub for S2 — it replies `{ ok, body: { stub: true } }`
// for every task. Real per-task handlers (notify.compose.email first) ship
// in v0.3 S3.

async fn connect_once(
    cfg: &RelayConfig,
    state_tx: &broadcast::Sender<RelayState>,
    inner: &RelayClientInner,
) -> Result<&'static str, ConnectError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest, protocol::Message,
    };

    let url = cfg.ws_url();
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| ConnectError::Handshake(e.to_string()))?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", cfg.jwt)
            .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
            .map_err(|e| ConnectError::Handshake(e.to_string()))?,
    );

    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| ConnectError::Handshake(e.to_string()))?;

    let (mut sink, mut stream) = ws.split();

    let reg = RegisterFrame::build(cfg.app_version.clone());
    let reg_json =
        serde_json::to_string(&reg).map_err(|e| ConnectError::Handshake(e.to_string()))?;
    sink.send(Message::Text(reg_json))
        .await
        .map_err(|e| ConnectError::Handshake(e.to_string()))?;

    publish_state(inner, state_tx, RelayState::Connected);

    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Text(txt)) => {
                if let Ok(df) = serde_json::from_str::<DispatchFrame>(&txt) {
                    if df.ty != "dispatch" {
                        continue;
                    }
                    let resp = build_stub_response(&df);
                    if let Ok(out) = serde_json::to_string(&resp) {
                        if sink.send(Message::Text(out)).await.is_err() {
                            return Ok("send-failed");
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => return Ok("close-frame"),
            Ok(Message::Ping(p)) => {
                let _ = sink.send(Message::Pong(p)).await;
            }
            Err(_) => return Ok("stream-error"),
            _ => {}
        }
    }
    Ok("stream-ended")
}

/// Builds the v0.3 S2 stub response. Pulled out so unit tests can verify
/// the contract without touching the network. Real handlers replace this
/// in v0.3 S3 (notify.compose.email first).
pub fn build_stub_response(df: &DispatchFrame) -> ResponseFrame {
    ResponseFrame {
        ty: "response",
        request_id: df.request_id.clone(),
        status: "ok",
        body: Some(serde_json::json!({
            "stub": true,
            "task": df.task.clone(),
            "note": "v0.3 S2 — real handler ships in S3",
        })),
        receipt: None,
        error: None,
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ConnectError {
    #[error("handshake: {0}")]
    Handshake(String),
}
