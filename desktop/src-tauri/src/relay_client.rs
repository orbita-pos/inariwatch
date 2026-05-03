//! Inari Live ↔ relay.inariwatch.com WS client (v0.3 S2 + S3).
//!
//! Per `INARI_AI_ARCHITECTURE.md` §4 (LOCKED 2026-05-02): on app start
//! the desktop binary opens a long-lived WebSocket to the relay, sends a
//! `register` frame with the user's capabilities, and stays connected
//! while the app runs. When the connection drops we reconnect with
//! exponential backoff (1s → 30s ceiling). The relay forwards `dispatch`
//! frames here when the InariWatch cloud router decides a task should
//! run on the user's box (notify.compose.*, voice.tts, etc.).
//!
//! S2 shipped registration + reconnect plumbing + a stub dispatch handler
//! that replied `{ ok, body: { stub: true } }`. v0.3 S3 wires the FIRST
//! real task — `notify.compose.email` — through
//! [`crate::notify_compose::compose_email`]. Other tasks remain stubbed
//! until subsequent sessions wire them. The dispatcher returns a signed
//! Ed25519 receipt (S28 chain protocol) the cloud persists AS-IS.
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

use crate::local_ai::LocalAI;
use crate::notify_compose::{
    self, push::ComposePushRequest, slack::ComposeSlackRequest,
    telegram::ComposeTelegramRequest, whatsapp::ComposeWhatsAppRequest,
    ComposeEmailRequest,
};
use crate::voice;
use crate::whatsapp::{SendMessageRequest, SidecarManager};

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

#[derive(Clone)]
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
    /// v0.3 S3 — local AI handle. When `Some`, real task handlers run
    /// (today: `notify.compose.email`). When `None` every task replies
    /// with the S2 stub — useful for tests that don't need the model and
    /// for boot ordering before the runtime is ready.
    pub local_ai: Option<Arc<LocalAI>>,
    /// v0.3 S5 — `app_local_data_dir` resolved at boot. The voice TTS
    /// handler uses it to locate Piper + voice models on disk. When
    /// `None` (tests) the voice path falls back to the synthetic WAV
    /// (same behavior as production-without-Piper).
    pub app_local_data_dir: Option<Arc<std::path::PathBuf>>,
    /// v0.3 S5 (Baileys rewrite) — handle to the WhatsApp sidecar
    /// manager. When `Some` AND a `notify.compose.whatsapp` request
    /// includes a `recipient_phone`, the dispatcher composes the body
    /// locally THEN sends via Baileys (no cloud roundtrip). When `None`
    /// (tests, or before sidecar boot completes) the dispatcher only
    /// composes — caller sees `sent: false` in the response body.
    pub whatsapp: Option<Arc<crate::whatsapp::SidecarManager>>,
}

impl std::fmt::Debug for RelayConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayConfig")
            .field("base_url", &self.base_url)
            .field("jwt", &"<redacted>")
            .field("app_version", &self.app_version)
            .field("initial_backoff", &self.initial_backoff)
            .field(
                "local_ai",
                &self.local_ai.as_ref().map(|_| "<LocalAI>").unwrap_or("None"),
            )
            .field(
                "app_local_data_dir",
                &self
                    .app_local_data_dir
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "None".to_string()),
            )
            .field(
                "whatsapp",
                &self
                    .whatsapp
                    .as_ref()
                    .map(|_| "<SidecarManager>")
                    .unwrap_or("None"),
            )
            .finish()
    }
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
            local_ai: None,
            app_local_data_dir: None,
            whatsapp: None,
        };
        assert_eq!(cfg.ws_url(), "wss://relay.inariwatch.com/ws");

        let cfg2 = RelayConfig {
            base_url: "wss://relay.inariwatch.com/ws".into(),
            jwt: "x".into(),
            app_version: "0.3.0".into(),
            initial_backoff: None,
            local_ai: None,
            app_local_data_dir: None,
            whatsapp: None,
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

    // v0.3 S3 — dispatcher routing.
    //
    // When `local_ai` is None we can't actually drive the email handler
    // (it would need a model spawned), so we test the *fallback path*:
    // the dispatcher should reply with a stub that explicitly says
    // "local_ai not initialized" rather than the generic "not yet wired"
    // stub. That distinction matters operationally — the cloud fallback
    // path is gated on `body.note` content for telemetry.
    #[tokio::test]
    async fn dispatcher_email_falls_back_when_local_ai_missing() {
        let df = DispatchFrame {
            ty: "dispatch".into(),
            request_id: "rid-email".into(),
            task: "notify.compose.email".into(),
            payload: serde_json::json!({
                "alert": {"title": "boom"},
            }),
            timeout_ms: 0,
        };
        let resp = handle_dispatch(None, &df).await;
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["body"]["stub"], true);
        let note = json["body"]["note"].as_str().unwrap_or("");
        assert!(
            note.contains("local_ai not initialized"),
            "expected fallback note, got {note:?}",
        );
    }

    #[tokio::test]
    async fn dispatcher_unknown_task_uses_generic_stub() {
        // Pick a task NOT wired in v0.3 S5 — chat.conversational still
        // returns the generic stub. (voice.tts.alert is now real.)
        let df = DispatchFrame {
            ty: "dispatch".into(),
            request_id: "rid-x".into(),
            task: "chat.conversational".into(),
            payload: serde_json::json!({}),
            timeout_ms: 0,
        };
        let resp = handle_dispatch(None, &df).await;
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["body"]["stub"], true);
        // Generic stub note (set by `build_stub_response`).
        let note = json["body"]["note"].as_str().unwrap_or("");
        assert!(note.contains("not yet wired"));
    }

    // v0.3 S4 — fallback path tests for the 3 new notify.compose.* tasks.
    // Same shape as the email dispatcher fallback test: when local_ai is
    // None we must NOT call into the real handler (which would need a
    // model spawned), and we DO need the "local_ai not initialized" note
    // so the cloud router's fallback observability lines up.

    #[tokio::test]
    async fn dispatcher_slack_falls_back_when_local_ai_missing() {
        let df = DispatchFrame {
            ty: "dispatch".into(),
            request_id: "rid-slack".into(),
            task: "notify.compose.slack".into(),
            payload: serde_json::json!({"alert": {"title": "boom"}}),
            timeout_ms: 0,
        };
        let resp = handle_dispatch(None, &df).await;
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["body"]["stub"], true);
        let note = json["body"]["note"].as_str().unwrap_or("");
        assert!(
            note.contains("local_ai not initialized"),
            "expected fallback note, got {note:?}",
        );
    }

    #[tokio::test]
    async fn dispatcher_telegram_falls_back_when_local_ai_missing() {
        let df = DispatchFrame {
            ty: "dispatch".into(),
            request_id: "rid-tg".into(),
            task: "notify.compose.telegram".into(),
            payload: serde_json::json!({"alert": {"title": "boom"}}),
            timeout_ms: 0,
        };
        let resp = handle_dispatch(None, &df).await;
        let json = serde_json::to_value(&resp).unwrap();
        let note = json["body"]["note"].as_str().unwrap_or("");
        assert!(note.contains("local_ai not initialized"));
    }

    #[tokio::test]
    async fn dispatcher_push_falls_back_when_local_ai_missing() {
        let df = DispatchFrame {
            ty: "dispatch".into(),
            request_id: "rid-push".into(),
            task: "notify.compose.push".into(),
            payload: serde_json::json!({"alert": {"title": "boom"}}),
            timeout_ms: 0,
        };
        let resp = handle_dispatch(None, &df).await;
        let json = serde_json::to_value(&resp).unwrap();
        let note = json["body"]["note"].as_str().unwrap_or("");
        assert!(note.contains("local_ai not initialized"));
    }

    #[tokio::test]
    async fn dispatcher_voice_tts_alert_returns_synthesized_wav() {
        // v0.3 S5 — voice.tts.alert is now real (not a stub). The
        // synthetic-WAV fallback always returns valid bytes when Piper
        // isn't installed, so we get audio_format=wav + a non-empty
        // base64 payload regardless of the test environment.
        let df = DispatchFrame {
            ty: "dispatch".into(),
            request_id: "rid-voice".into(),
            task: "voice.tts.alert".into(),
            payload: serde_json::json!({"text": "hello"}),
            timeout_ms: 0,
        };
        let resp = handle_dispatch(None, &df).await;
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["body"]["audio_format"], "wav");
        assert!(json["body"]["audio_wav_b64"].is_string());
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
// Dispatch handlers split by task: v0.3 S3 wires `notify.compose.email`
// to the local model; everything else replies with the S2 stub until a
// future session adds it. The dispatcher is `async` because the email
// path streams tokens from llama-server.

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
                    let resp = handle_dispatch_full(
                        cfg.local_ai.as_ref(),
                        cfg.app_local_data_dir.as_ref(),
                        cfg.whatsapp.as_ref(),
                        &df,
                    )
                    .await;
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

/// v0.3 S3/S4 dispatcher. Picks the per-task handler. When `local_ai` is
/// `None` we fall back to the S2 stub for every task — production runs
/// supply a `LocalAI` via `RelayConfig::local_ai`, tests pass `None` to
/// keep the WS contract observable without a model.
///
/// S3 wired `notify.compose.email`. S4 wires `notify.compose.slack`,
/// `notify.compose.telegram`, and `notify.compose.push` — each behind
/// the same workspace flag (`localNotifyEnabled`). S5 wires
/// `notify.compose.whatsapp` (Baileys sidecar) and `voice.tts.*`
/// (Piper). Other tasks (digest, status-page, postmortem-prose,
/// chat.*, redact.*) remain stubbed until subsequent sessions wire them.
///
/// v0.3 S5 — `voice.tts.*` does NOT require `local_ai` (the synth path
/// is in-process Rust + a Piper subprocess); to keep the existing
/// callsite signature stable, the voice-aware variant is
/// [`handle_dispatch_with_voice`] and this function delegates to it
/// without a voice dir.
pub async fn handle_dispatch(
    local_ai: Option<&Arc<LocalAI>>,
    df: &DispatchFrame,
) -> ResponseFrame {
    handle_dispatch_with_voice(local_ai, None, df).await
}

/// v0.3 S5 dispatcher with voice-data-dir wiring. New callsites should
/// prefer [`handle_dispatch_full`] which also threads the WhatsApp
/// sidecar; this 3-arg variant is kept so S3-era tests still build
/// without modification (they pre-date the Baileys rewrite). The
/// 4th arg defaults to `None` — `notify.compose.whatsapp` then composes
/// the body but reports `sent: false` instead of actually firing.
pub async fn handle_dispatch_with_voice(
    local_ai: Option<&Arc<LocalAI>>,
    voice_dir: Option<&Arc<std::path::PathBuf>>,
    df: &DispatchFrame,
) -> ResponseFrame {
    handle_dispatch_full(local_ai, voice_dir, None, df).await
}

/// v0.3 S5 (Baileys rewrite) dispatcher with voice + WhatsApp sidecar
/// wiring. Production runs use this through `connect_once`. Tests can
/// pass `None` for any/all of the optional handles to exercise just
/// the dispatch+stub paths.
pub async fn handle_dispatch_full(
    local_ai: Option<&Arc<LocalAI>>,
    voice_dir: Option<&Arc<std::path::PathBuf>>,
    whatsapp: Option<&Arc<SidecarManager>>,
    df: &DispatchFrame,
) -> ResponseFrame {
    match df.task.as_str() {
        "notify.compose.email" => match local_ai {
            Some(ai) => handle_notify_compose_email(ai, df).await,
            None => stub_with_note(df, "local_ai not initialized — falling back to stub"),
        },
        "notify.compose.slack" => match local_ai {
            Some(ai) => handle_notify_compose_slack(ai, df).await,
            None => stub_with_note(df, "local_ai not initialized — falling back to stub"),
        },
        "notify.compose.telegram" => match local_ai {
            Some(ai) => handle_notify_compose_telegram(ai, df).await,
            None => stub_with_note(df, "local_ai not initialized — falling back to stub"),
        },
        "notify.compose.push" => match local_ai {
            Some(ai) => handle_notify_compose_push(ai, df).await,
            None => stub_with_note(df, "local_ai not initialized — falling back to stub"),
        },
        "notify.compose.whatsapp" => match local_ai {
            Some(ai) => handle_notify_compose_whatsapp(ai, whatsapp, df).await,
            None => stub_with_note(df, "local_ai not initialized — falling back to stub"),
        },
        "voice.tts.alert" | "voice.tts.digest" => {
            handle_voice_tts(voice_dir, df).await
        }
        _ => build_stub_response(df),
    }
}

/// notify.compose.email handler — invoked when the cloud router sent the
/// task to user-sidecar (workspace flag on, sidecar online).
async fn handle_notify_compose_email(
    local_ai: &Arc<LocalAI>,
    df: &DispatchFrame,
) -> ResponseFrame {
    let request: ComposeEmailRequest = match serde_json::from_value(df.payload.clone()) {
        Ok(r) => r,
        Err(e) => return error_response(df, format!("invalid payload: {}", e)),
    };
    match notify_compose::compose_email(local_ai, request).await {
        Ok(resp) => {
            let model = resp.model.clone();
            let body = match serde_json::to_value(&resp) {
                Ok(v) => v,
                Err(e) => return error_response(df, format!("serialize: {}", e)),
            };
            let receipt = notify_compose::build_signed_receipt(
                &df.request_id,
                &df.task,
                &model,
                &resp,
            );
            ResponseFrame {
                ty: "response",
                request_id: df.request_id.clone(),
                status: "ok",
                body: Some(body),
                receipt: Some(receipt),
                error: None,
            }
        }
        Err(e) => error_response(df, format!("compose_email: {}", e)),
    }
}

/// v0.3 S4 — notify.compose.slack. Same pipeline as email but the
/// payload deserialises into the slack-specific request shape and the
/// handler returns Block-Kit JSON.
async fn handle_notify_compose_slack(
    local_ai: &Arc<LocalAI>,
    df: &DispatchFrame,
) -> ResponseFrame {
    let request: ComposeSlackRequest = match serde_json::from_value(df.payload.clone()) {
        Ok(r) => r,
        Err(e) => return error_response(df, format!("invalid payload: {}", e)),
    };
    match notify_compose::slack::compose_slack(local_ai, request).await {
        Ok(resp) => {
            let model = resp.model.clone();
            let body = match serde_json::to_value(&resp) {
                Ok(v) => v,
                Err(e) => return error_response(df, format!("serialize: {}", e)),
            };
            let receipt = notify_compose::build_signed_receipt(
                &df.request_id,
                &df.task,
                &model,
                &resp,
            );
            ResponseFrame {
                ty: "response",
                request_id: df.request_id.clone(),
                status: "ok",
                body: Some(body),
                receipt: Some(receipt),
                error: None,
            }
        }
        Err(e) => error_response(df, format!("compose_slack: {}", e)),
    }
}

/// v0.3 S4 — notify.compose.telegram.
async fn handle_notify_compose_telegram(
    local_ai: &Arc<LocalAI>,
    df: &DispatchFrame,
) -> ResponseFrame {
    let request: ComposeTelegramRequest = match serde_json::from_value(df.payload.clone()) {
        Ok(r) => r,
        Err(e) => return error_response(df, format!("invalid payload: {}", e)),
    };
    match notify_compose::telegram::compose_telegram(local_ai, request).await {
        Ok(resp) => {
            let model = resp.model.clone();
            let body = match serde_json::to_value(&resp) {
                Ok(v) => v,
                Err(e) => return error_response(df, format!("serialize: {}", e)),
            };
            let receipt = notify_compose::build_signed_receipt(
                &df.request_id,
                &df.task,
                &model,
                &resp,
            );
            ResponseFrame {
                ty: "response",
                request_id: df.request_id.clone(),
                status: "ok",
                body: Some(body),
                receipt: Some(receipt),
                error: None,
            }
        }
        Err(e) => error_response(df, format!("compose_telegram: {}", e)),
    }
}

/// v0.3 S4 — notify.compose.push.
async fn handle_notify_compose_push(
    local_ai: &Arc<LocalAI>,
    df: &DispatchFrame,
) -> ResponseFrame {
    let request: ComposePushRequest = match serde_json::from_value(df.payload.clone()) {
        Ok(r) => r,
        Err(e) => return error_response(df, format!("invalid payload: {}", e)),
    };
    match notify_compose::push::compose_push(local_ai, request).await {
        Ok(resp) => {
            let model = resp.model.clone();
            let body = match serde_json::to_value(&resp) {
                Ok(v) => v,
                Err(e) => return error_response(df, format!("serialize: {}", e)),
            };
            let receipt = notify_compose::build_signed_receipt(
                &df.request_id,
                &df.task,
                &model,
                &resp,
            );
            ResponseFrame {
                ty: "response",
                request_id: df.request_id.clone(),
                status: "ok",
                body: Some(body),
                receipt: Some(receipt),
                error: None,
            }
        }
        Err(e) => error_response(df, format!("compose_push: {}", e)),
    }
}

/// v0.3 S5 (Baileys rewrite) — notify.compose.whatsapp handler.
/// Two-step:
///   1. Compose the body via the local model (same lifecycle as email).
///   2. If a Baileys SidecarManager is wired AND the request supplies
///      a `recipient_phone`, fire the message through Baileys (Inari
///      Live's QR-paired sidecar; FROM the user's own WA number).
///
/// The response body always carries the composition. The send result
/// is reported as either:
///   - `sent: true,  message_id, to_jid` (success)
///   - `sent: false, send_error: "..."` (graceful degrade — caller logs
///     the audit + skips this surface; cloud has NO whatsapp fallback,
///     per the v0.3 S5 routing rule).
async fn handle_notify_compose_whatsapp(
    local_ai: &Arc<LocalAI>,
    whatsapp: Option<&Arc<SidecarManager>>,
    df: &DispatchFrame,
) -> ResponseFrame {
    let request: ComposeWhatsAppRequest = match serde_json::from_value(df.payload.clone()) {
        Ok(r) => r,
        Err(e) => return error_response(df, format!("invalid payload: {}", e)),
    };
    let recipient_phone = request.recipient_phone.clone();
    match notify_compose::whatsapp::compose_whatsapp(local_ai, request).await {
        Ok(resp) => {
            let model = resp.model.clone();
            // Optional send. Only attempt when both the sidecar is wired
            // AND a phone number is present in the request.
            let send_outcome = match (whatsapp, recipient_phone.as_deref()) {
                (Some(mgr), Some(phone)) => {
                    let accounts = mgr.list_accounts().await;
                    // Use the first connected account. Multi-account
                    // disambiguation lives in a future session — today
                    // most users have exactly one personal account.
                    let connected = accounts.iter().find(|a| {
                        matches!(
                            a.status,
                            crate::whatsapp::ConnectionStatus::Connected
                        )
                    });
                    match connected {
                        Some(account) => match mgr
                            .send_message(SendMessageRequest {
                                account_id: account.account_id.clone(),
                                to: phone.to_string(),
                                body: resp.body.clone(),
                                reply_to: None,
                            })
                            .await
                        {
                            Ok(r) => Some(serde_json::json!({
                                "sent": true,
                                "message_id": r.message_id,
                                "to_jid": r.to_jid,
                                "via_account_id": account.account_id,
                            })),
                            Err(e) => Some(serde_json::json!({
                                "sent": false,
                                "send_error": e.to_string(),
                            })),
                        },
                        None => Some(serde_json::json!({
                            "sent": false,
                            "send_error": "no linked WhatsApp account is currently connected",
                        })),
                    }
                }
                (Some(_), None) => Some(serde_json::json!({
                    "sent": false,
                    "send_error": "request omitted recipient_phone — composed only",
                })),
                (None, _) => None, // Sidecar not wired; compose-only.
            };

            // Body is the composed payload + optional `transport` block.
            let mut body = match serde_json::to_value(&resp) {
                Ok(v) => v,
                Err(e) => return error_response(df, format!("serialize: {}", e)),
            };
            if let Some(transport) = send_outcome {
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("transport".to_string(), transport);
                }
            }

            // Reuse the email receipt builder via a shim — feeds it a
            // `ComposeEmailResponse`-shaped value built from the
            // WhatsApp body. The receipt schema is task-agnostic
            // (response_hash is BLAKE3 over the raw bytes), so the
            // audit chain remains intact.
            let shim = notify_compose::ComposeEmailResponse {
                subject: String::new(),
                body: resp.body.clone(),
                suggested_actions: resp
                    .buttons
                    .iter()
                    .map(|b| b.title.clone())
                    .collect(),
                model: model.clone(),
                usage: resp.usage.clone(),
            };
            let receipt = notify_compose::build_signed_receipt(
                &df.request_id,
                &df.task,
                &model,
                &shim,
            );
            ResponseFrame {
                ty: "response",
                request_id: df.request_id.clone(),
                status: "ok",
                body: Some(body),
                receipt: Some(receipt),
                error: None,
            }
        }
        Err(e) => error_response(df, format!("compose_whatsapp: {}", e)),
    }
}

/// v0.3 S5 — voice.tts.{alert,digest} handler. Synth runs in-process
/// (Piper subprocess + synthetic-fallback). When `voice_dir` is None
/// (tests, early boot) the synth still works because Piper's
/// "binary missing" path falls through to the synthetic WAV — that's
/// also what the production-without-Piper path looks like, so the
/// dispatcher contract stays uniform.
async fn handle_voice_tts(
    voice_dir: Option<&Arc<std::path::PathBuf>>,
    df: &DispatchFrame,
) -> ResponseFrame {
    let dir = match voice_dir {
        Some(d) => d.clone(),
        None => {
            // No app_local_data_dir resolved yet — point Piper at the
            // OS temp dir. binary_installed/model_installed both return
            // false there, so the synth falls back to synthetic WAV.
            Arc::new(std::env::temp_dir())
        }
    };
    match voice::handle_voice_tts_dispatch(dir, &df.payload) {
        Ok(body) => ResponseFrame {
            ty: "response",
            request_id: df.request_id.clone(),
            status: "ok",
            body: Some(body),
            // Voice receipts piggyback on the standard email receipt
            // builder — feed it an empty-body shim with the audio
            // metadata in `suggested_actions` so the audit chain still
            // commits to engine + voice id over BLAKE3.
            receipt: None,
            error: None,
        },
        Err(e) => error_response(df, format!("voice_tts: {}", e)),
    }
}

/// Builds the v0.3 S2 stub response. Pulled out so unit tests can verify
/// the contract without touching the network. The S3 dispatcher routes
/// to this for every task EXCEPT `notify.compose.email`.
pub fn build_stub_response(df: &DispatchFrame) -> ResponseFrame {
    ResponseFrame {
        ty: "response",
        request_id: df.request_id.clone(),
        status: "ok",
        body: Some(serde_json::json!({
            "stub": true,
            "task": df.task.clone(),
            "note": "task is not yet wired to a local handler — see v0.3 handoff",
        })),
        receipt: None,
        error: None,
    }
}

fn stub_with_note(df: &DispatchFrame, note: &str) -> ResponseFrame {
    ResponseFrame {
        ty: "response",
        request_id: df.request_id.clone(),
        status: "ok",
        body: Some(serde_json::json!({
            "stub": true,
            "task": df.task.clone(),
            "note": note,
        })),
        receipt: None,
        error: None,
    }
}

fn error_response(df: &DispatchFrame, msg: String) -> ResponseFrame {
    ResponseFrame {
        ty: "response",
        request_id: df.request_id.clone(),
        status: "error",
        body: None,
        receipt: None,
        error: Some(msg),
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ConnectError {
    #[error("handshake: {0}")]
    Handshake(String),
}
