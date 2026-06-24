//! Communication tool cluster (S5) — three concrete `ChatTool`s that
//! let the agent send a message on the user's behalf over WhatsApp,
//! Telegram, or Slack. Every tool defaults to [`Confirm`] — there is
//! no analogue to S3's "safe read" tier here. A misfire on
//! `comm.send_*` would mean the user accidentally pinged a real
//! recipient on a real network, so the per-call confirmation gate is
//! the headline guard. Schema is the secondary one.
//!
//! | name                  | default      | wraps                                   |
//! |-----------------------|--------------|-----------------------------------------|
//! | `comm.send_whatsapp`  | [`Confirm`]  | local Baileys sidecar (`whatsapp::SidecarManager`) |
//! | `comm.send_telegram`  | [`Confirm`]  | web proxy `POST /api/desktop/telegram/send`        |
//! | `comm.send_slack`     | [`Confirm`]  | web proxy `POST /api/desktop/slack/send`           |
//!
//! ## Backend pattern (vs S4)
//!
//! Same `XBackend` seam as [`super::local_exec`] — async traits, mocks
//! gated behind `cfg(any(test, feature = "agent-test-utils"))`. A
//! `MockTelegramBackend` that records calls without ever opening a TCP
//! socket is harmless on its own, but anything `pub` in the default
//! build can end up in production code by import. The feature flag
//! keeps that footgun closed.
//!
//! ## Permission story (sticky / "remember per recipient")
//!
//! Every tool is `Confirm` on every call — there is **no** "remember
//! this approval for chat_id X" today. That sticky-permission
//! extension lives downstream of [`super::super::PermissionResolver`]
//! and is explicitly a follow-up to S5 (see `INARI_LIVE_AGENT_PLAN.md`).
//!
//! ## What this module does NOT do
//!
//! - Boot wiring of these tools into a [`super::super::ToolRegistry`]
//!   instance — that lands in S6 alongside the chat surface.
//! - IPC commands for invoking the tools from the frontend — also S6.
//! - Permission UI per-tool — S11 owns that.
//! - WhatsApp QR pairing flow — that's owned by [`crate::whatsapp`]; S5
//!   only consumes the sidecar's `send_message` RPC.
//! - Telegram / Slack OAuth onboarding — owned by the web app; S5 only
//!   forwards the agent's request through the existing
//!   `/api/desktop/{telegram,slack}/send` endpoints.
//!
//! [`Confirm`]: super::super::PermissionLevel::Confirm

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

use super::super::{
    ChatTool, PermissionLevel, RegistryError, ToolError, ToolInvocation, ToolMeta, ToolOutput,
    ToolRegistry,
};

// ── Backend traits ──────────────────────────────────────────────────────────

/// WhatsApp send seam. The `to` argument is E.164 *with* a leading `+`
/// (the tool schema enforces that). Implementations that talk to the
/// Baileys sidecar must strip the `+` themselves — Baileys'
/// `SendMessageRequest::to` is documented as "no leading `+`, no
/// spaces" (sidecar converts to JID).
#[async_trait]
pub trait WhatsAppBackend: Send + Sync + 'static {
    async fn send(&self, to: &str, message: &str) -> Result<(), String>;
}

/// Telegram chat identifier. The Bot API accepts both forms
/// interchangeably: a numeric chat id (group/user/channel) OR a string
/// (`@channelusername` for public channels). We carry both shapes
/// without normalizing so the wire round-trip preserves intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelegramChatId {
    /// Free-form string. Includes `@channelusername` (public channels)
    /// and the stringified numeric id (`"-1001234567890"` for
    /// supergroups).
    Str(String),
    /// Pre-parsed integer chat id. Used when the agent emits a
    /// JSON `integer` rather than a `string` in the schema's
    /// `oneOf`.
    Int(i64),
}

impl TelegramChatId {
    /// Stringify for transport. Numeric ids become decimal strings.
    pub fn as_string(&self) -> String {
        match self {
            Self::Str(s) => s.clone(),
            Self::Int(n) => n.to_string(),
        }
    }
}

/// Telegram send seam. `parse_mode` is the Bot API formatting flag
/// (`MarkdownV2`, `HTML`); `None` means plain text.
#[async_trait]
pub trait TelegramBackend: Send + Sync + 'static {
    async fn send(
        &self,
        chat_id: &TelegramChatId,
        text: &str,
        parse_mode: Option<&str>,
    ) -> Result<(), String>;
}

/// Slack send seam. At least one of `text` / `blocks` is set — the
/// tool schema's `anyOf` enforces that. Implementations forwarding to
/// the web proxy should pass both fields through verbatim; the proxy
/// applies its own validation (40 KB cap on `text`, max 50 blocks).
#[async_trait]
pub trait SlackBackend: Send + Sync + 'static {
    async fn send(
        &self,
        channel: &str,
        text: Option<&str>,
        blocks: Option<&Value>,
    ) -> Result<(), String>;
}

// ── Bundle ──────────────────────────────────────────────────────────────────

/// All three backends the comm cluster needs at boot. Tests build this
/// with [`mocks::mock_backends`]; production goes through
/// [`Self::from_app`] which constructs a [`TauriWhatsAppBackend`] over
/// the managed [`crate::whatsapp::SidecarManager`] plus a shared
/// [`DesktopApiClient`] for the two web proxies.
pub struct CommBackends {
    pub whatsapp: Arc<dyn WhatsAppBackend>,
    pub telegram: Arc<dyn TelegramBackend>,
    pub slack: Arc<dyn SlackBackend>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConstructError {
    #[error("WhatsApp sidecar manager is not registered as Tauri managed state")]
    WhatsAppManagerMissing,
}

impl CommBackends {
    /// Production constructor. Wires:
    ///
    /// - `whatsapp` → [`TauriWhatsAppBackend`] over the
    ///   [`crate::whatsapp::SidecarManager`] managed by Tauri (registered
    ///   in `lib.rs::run`).
    /// - `telegram` / `slack` → web-proxy backends sharing one
    ///   [`DesktopApiClient`] (built from
    ///   [`crate::cloud::api::read_dashboard_creds`]).
    ///
    /// Returns [`ConstructError::WhatsAppManagerMissing`] if the
    /// sidecar manager hasn't been registered yet — that would only
    /// happen if S5 boot wiring is called before
    /// `app.manage(Arc<SidecarManager>)`, which the runtime does
    /// unconditionally today.
    pub fn from_app(app: tauri::AppHandle) -> Result<Self, ConstructError> {
        use tauri::Manager;
        let mgr = app
            .try_state::<Arc<crate::whatsapp::SidecarManager>>()
            .ok_or(ConstructError::WhatsAppManagerMissing)?;
        let store = app.state::<Arc<crate::store::Store>>();

        let api = Arc::new(DesktopApiClient::new(store.inner().clone()));

        Ok(Self {
            whatsapp: Arc::new(TauriWhatsAppBackend::new(mgr.inner().clone())),
            telegram: Arc::new(TauriTelegramBackend::new(api.clone())),
            slack: Arc::new(TauriSlackBackend::new(api)),
        })
    }
}

// ── Tauri WhatsApp backend ──────────────────────────────────────────────────

/// Production [`WhatsAppBackend`] — wraps the managed
/// [`crate::whatsapp::SidecarManager`].
///
/// Because the sidecar hosts N accounts behind one process, the
/// backend has to pick one before issuing the RPC. We pick the first
/// `Connected` account in the manager's snapshot; if none is paired,
/// we return a clean error so the chat surface can prompt the user to
/// pair an account in Settings.
pub struct TauriWhatsAppBackend {
    mgr: Arc<crate::whatsapp::SidecarManager>,
}

impl TauriWhatsAppBackend {
    pub fn new(mgr: Arc<crate::whatsapp::SidecarManager>) -> Self {
        Self { mgr }
    }
}

#[async_trait]
impl WhatsAppBackend for TauriWhatsAppBackend {
    async fn send(&self, to: &str, message: &str) -> Result<(), String> {
        // Pick the first paired account. The sidecar uses the
        // ConnectionStatus::Connected variant for "ready to send".
        let accounts = self.mgr.list_accounts().await;
        let account_id = accounts
            .into_iter()
            .find(|a| matches!(a.status, crate::whatsapp::ConnectionStatus::Connected))
            .map(|a| a.account_id)
            .ok_or_else(|| {
                "no linked WhatsApp account: pair one in Settings → WhatsApp before sending"
                    .to_string()
            })?;

        // Tool schema enforces a leading `+`; sidecar wants no `+`.
        let to_no_plus = to.strip_prefix('+').unwrap_or(to).to_string();

        self.mgr
            .send_message(crate::whatsapp::SendMessageRequest {
                account_id,
                to: to_no_plus,
                body: message.to_string(),
                reply_to: None,
            })
            .await
            .map(|_resp| ())
            .map_err(|e| e.to_string())
    }
}

// ── Desktop API client (shared by Telegram + Slack web proxies) ─────────────

/// Thin HTTP client for the desktop's web-proxy endpoints. Owns one
/// long-lived `reqwest::Client`, reads `dashboard_url`/`dashboard_token`
/// from the SQL settings store on every call so a re-login picks up the
/// new bearer without restarting Inari Live.
///
/// Path arg to [`Self::post_json`] is the `/api/...` segment, joined to
/// the user's persisted base URL (defaulting to
/// [`crate::cloud::api::DEFAULT_API_URL`] if nothing has been saved).
/// Auth header is always `Bearer <dashboard_token>`; calls without a
/// token return [`ApiError::Unauthorized`] before opening a socket.
pub struct DesktopApiClient {
    http: reqwest::Client,
    store: Arc<crate::store::Store>,
}

#[derive(Debug)]
pub enum ApiError {
    /// User is logged out (no `dashboard_token` saved).
    Unauthorized,
    /// HTTP transport failure (DNS, TLS, connect, …).
    Transport(String),
    /// Server replied with a non-2xx status. `body` is the response
    /// body (best-effort — empty on read failure).
    Status { status: u16, body: String },
}

impl DesktopApiClient {
    pub fn new(store: Arc<crate::store::Store>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("reqwest client builds with default config"),
            store,
        }
    }

    /// POST `body` as JSON to `<base_url><path>` with the user's
    /// desktop bearer token. `body` must serialize to a JSON object —
    /// the desktop endpoints are uniformly object-shaped.
    pub async fn post_json<B: Serialize>(&self, path: &str, body: &B) -> Result<(), ApiError> {
        let creds = crate::cloud::api::read_dashboard_creds(&self.store);
        if !creds.is_connected() {
            return Err(ApiError::Unauthorized);
        }
        let token = creds.token.unwrap_or_default();
        let url = format!("{}{}", creds.base_url.trim_end_matches('/'), path);

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&token)
            .json(body)
            .send()
            .await
            .map_err(|e| ApiError::Transport(e.to_string()))?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        if status.as_u16() == 401 {
            return Err(ApiError::Unauthorized);
        }
        let body = resp.text().await.unwrap_or_default();
        Err(ApiError::Status {
            status: status.as_u16(),
            body,
        })
    }

    /// GET `<base_url><path>` with the user's desktop bearer token and
    /// parse the response body as JSON. Used by the cloud.* agent tools
    /// (`cloud.list_projects`, `cloud.get_project_health`,
    /// `cloud.get_workspace_summary`) to read aggregated state out of
    /// the user's paired workspace without each tool re-implementing
    /// the auth + transport plumbing.
    pub async fn get_json(&self, path: &str) -> Result<Value, ApiError> {
        let creds = crate::cloud::api::read_dashboard_creds(&self.store);
        if !creds.is_connected() {
            return Err(ApiError::Unauthorized);
        }
        let token = creds.token.unwrap_or_default();
        let url = format!("{}{}", creds.base_url.trim_end_matches('/'), path);

        let resp = self
            .http
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| ApiError::Transport(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(ApiError::Unauthorized);
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Status {
                status: status.as_u16(),
                body,
            });
        }
        resp.json::<Value>()
            .await
            .map_err(|e| ApiError::Transport(format!("parse json: {e}")))
    }
}

fn api_error_to_string(prefix: &str, err: ApiError) -> String {
    match err {
        ApiError::Unauthorized => "desktop auth required: run /login first".to_string(),
        ApiError::Transport(m) => format!("{prefix}: transport error: {m}"),
        ApiError::Status { status, body } => {
            // The body is the upstream JSON; we surface the first 256
            // chars to keep the error message readable in the chat
            // surface.
            let trimmed: String = body.chars().take(256).collect();
            format!("{prefix}: HTTP {status}: {trimmed}")
        }
    }
}

// ── Tauri Telegram backend ──────────────────────────────────────────────────

/// Production [`TelegramBackend`] — POSTs to
/// `/api/desktop/telegram/send` via the shared [`DesktopApiClient`].
///
/// The tool schema's `chat_id` (free-form Telegram chat id, e.g.
/// `@channel` or `-1001234567890`) maps to the endpoint's
/// `chatIdOverride`. The endpoint additionally requires a
/// `notificationChannels` row UUID (`channelId`) to scope the bot
/// token; we read that from the persisted setting
/// `default_telegram_channel_id`. An unset setting yields a clean
/// `desktop_telegram_send: ...` error so the user knows to pick a
/// default Telegram channel in Settings → Notifications.
///
/// Note: the existing endpoint does NOT support a `parse_mode` flag
/// today (the body shape is `{channelId, message, chatIdOverride?}`).
/// `parse_mode` is therefore *advisory* — accepted at the schema level
/// so future endpoint extensions can pick it up without churning the
/// tool surface, but ignored on the wire today.
pub struct TauriTelegramBackend {
    api: Arc<DesktopApiClient>,
}

impl TauriTelegramBackend {
    pub fn new(api: Arc<DesktopApiClient>) -> Self {
        Self { api }
    }
}

#[async_trait]
impl TelegramBackend for TauriTelegramBackend {
    async fn send(
        &self,
        chat_id: &TelegramChatId,
        text: &str,
        _parse_mode: Option<&str>,
    ) -> Result<(), String> {
        let channel_id = crate::store::settings::get(&self.api.store, "default_telegram_channel_id")
            .map_err(|e| format!("settings: {e}"))?
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                "no default Telegram channel configured: pick one in Settings → Notifications"
                    .to_string()
            })?;

        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(rename = "channelId")]
            channel_id: &'a str,
            message: &'a str,
            #[serde(rename = "chatIdOverride")]
            chat_id_override: String,
        }

        let body = Body {
            channel_id: &channel_id,
            message: text,
            chat_id_override: chat_id.as_string(),
        };

        self.api
            .post_json("/api/desktop/telegram/send", &body)
            .await
            .map_err(|e| api_error_to_string("desktop_telegram_send", e))
    }
}

// ── Tauri Slack backend ─────────────────────────────────────────────────────

/// Production [`SlackBackend`] — POSTs to `/api/desktop/slack/send`
/// via the shared [`DesktopApiClient`].
///
/// The endpoint has two routing modes:
///
/// 1. **Project-scoped:** `{ projectId, text, blocks? }` — picks the
///    project's mapped Slack channel.
/// 2. **Direct:** `{ installationId, channel, text, blocks? }` — posts
///    to a literal Slack channel id under the named installation.
///
/// The agent's `channel` argument is a literal Slack channel id (e.g.
/// `C12345`, `#alerts`, `@user`), so we always use mode 2. The
/// `installationId` comes from the persisted setting
/// `default_slack_installation_id`. An unset setting yields a clean
/// error so the user knows to pick a default Slack workspace in
/// Settings → Notifications.
///
/// The endpoint requires a non-empty `text`. When the agent only
/// passed `blocks`, we fall back to a placeholder string (`"(see
/// attached blocks)"`) so the request validates upstream — Slack
/// itself uses `text` as the notification preview, so a stub is
/// acceptable when blocks carry the real content.
pub struct TauriSlackBackend {
    api: Arc<DesktopApiClient>,
}

impl TauriSlackBackend {
    pub fn new(api: Arc<DesktopApiClient>) -> Self {
        Self { api }
    }
}

#[async_trait]
impl SlackBackend for TauriSlackBackend {
    async fn send(
        &self,
        channel: &str,
        text: Option<&str>,
        blocks: Option<&Value>,
    ) -> Result<(), String> {
        let installation_id = crate::store::settings::get(
            &self.api.store,
            "default_slack_installation_id",
        )
        .map_err(|e| format!("settings: {e}"))?
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            "no default Slack installation configured: pick one in Settings → Notifications"
                .to_string()
        })?;

        let text_for_wire = text.unwrap_or("(see attached blocks)");

        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(rename = "installationId")]
            installation_id: &'a str,
            channel: &'a str,
            text: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            blocks: Option<&'a Value>,
        }

        let body = Body {
            installation_id: &installation_id,
            channel,
            text: text_for_wire,
            blocks,
        };

        self.api
            .post_json("/api/desktop/slack/send", &body)
            .await
            .map_err(|e| api_error_to_string("desktop_slack_send", e))
    }
}

// ── Tools ───────────────────────────────────────────────────────────────────

fn whatsapp_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["to", "message"],
        "properties": {
            "to":      { "type": "string", "pattern": "^\\+[1-9][0-9]{6,14}$" },
            "message": { "type": "string", "minLength": 1, "maxLength": 4096 }
        }
    })
}

fn telegram_schema() -> Value {
    // `chat_id` accepts both string usernames (`@user`) and numeric IDs at
    // runtime (see `execute()` below — `Value::Number` is also handled),
    // but the schema is narrowed to `string` because OpenAI/Together's
    // tool-schema validator rejects `oneOf` inside a property. The model
    // is told via the description to stringify numeric IDs.
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["chat_id", "text"],
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "Telegram chat ID — `@username`, channel handle, or numeric chat ID as a string (e.g. \"123456789\")."
            },
            "text":    { "type": "string", "minLength": 1, "maxLength": 4096 },
            "parse_mode": { "type": "string", "enum": ["MarkdownV2", "HTML"] }
        }
    })
}

fn slack_schema() -> Value {
    // `blocks` REQUIRES an `items` schema — OpenAI strict-mode (and
    // Together's edge validator that ships with newer Qwen models)
    // rejects any `type: "array"` without `items`, even though vLLM
    // doesn't actually constrain decoding. `{ type: "object" }` is the
    // permissive correct value: Slack Block Kit blocks are heterogeneous
    // objects keyed by `type`, so the model only needs to know "array of
    // objects" — Slack itself validates the inner block structure.
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["channel"],
        "properties": {
            "channel": { "type": "string", "pattern": "^[#@C][A-Za-z0-9._-]+$|^[A-Z][A-Z0-9]+$" },
            "text":    { "type": "string", "maxLength": 40000 },
            "blocks":  {
                "type": "array",
                "items": { "type": "object" },
                "maxItems": 50,
                "description": "Slack Block Kit blocks (array of block objects — see https://api.slack.com/block-kit)."
            }
        },
        "anyOf": [
            { "required": ["text"] },
            { "required": ["blocks"] }
        ]
    })
}

/// `comm.send_whatsapp` — proxy a single WhatsApp message via the
/// user's local Baileys sidecar.
pub struct SendWhatsAppTool {
    meta: ToolMeta,
    backend: Arc<dyn WhatsAppBackend>,
}

impl SendWhatsAppTool {
    pub fn new(backend: Arc<dyn WhatsAppBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "comm.send_whatsapp".into(),
                description:
                    "Send a WhatsApp message via the user's paired Baileys sidecar. \
                     `to` is E.164 with a leading `+`; the sidecar handles the JID conversion. \
                     Always Confirm — every send is one user approval per call (no \"remember\" yet)."
                        .into(),
                params_schema: whatsapp_schema(),
                default_permission: PermissionLevel::Confirm,
            },
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for SendWhatsAppTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let to = invocation
            .args
            .get("to")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing to".into()))?
            .to_string();
        let message = invocation
            .args
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing message".into()))?
            .to_string();
        self.backend
            .send(&to, &message)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        Ok(ToolOutput {
            value: json!({ "ok": true, "to": to }),
            summary: Some(format!("Sent WhatsApp to {to}")),
        })
    }
}

/// `comm.send_telegram` — proxy a Telegram message through the desktop
/// web endpoint.
pub struct SendTelegramTool {
    meta: ToolMeta,
    backend: Arc<dyn TelegramBackend>,
}

impl SendTelegramTool {
    pub fn new(backend: Arc<dyn TelegramBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "comm.send_telegram".into(),
                description:
                    "Send a Telegram message via the user's configured Telegram bot. \
                     `chat_id` is the Telegram chat id (string `@channel` or numeric). \
                     `parse_mode` accepted at the schema level for forward compatibility \
                     but ignored on the wire today (web proxy doesn't support it yet). \
                     Always Confirm — every send is one user approval per call."
                        .into(),
                params_schema: telegram_schema(),
                default_permission: PermissionLevel::Confirm,
            },
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for SendTelegramTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let chat_id = match invocation.args.get("chat_id") {
            Some(Value::String(s)) => TelegramChatId::Str(s.clone()),
            Some(Value::Number(n)) => TelegramChatId::Int(
                n.as_i64()
                    .ok_or_else(|| ToolError::InvalidArgs("chat_id integer overflow".into()))?,
            ),
            Some(_) => {
                return Err(ToolError::InvalidArgs(
                    "chat_id must be string or integer".into(),
                ))
            }
            None => return Err(ToolError::InvalidArgs("missing chat_id".into())),
        };
        let text = invocation
            .args
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing text".into()))?
            .to_string();
        let parse_mode = invocation
            .args
            .get("parse_mode")
            .and_then(Value::as_str)
            .map(str::to_string);

        self.backend
            .send(&chat_id, &text, parse_mode.as_deref())
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let to_label = chat_id.as_string();
        Ok(ToolOutput {
            value: json!({ "ok": true, "chat_id": to_label }),
            summary: Some(format!("Sent Telegram to {to_label}")),
        })
    }
}

/// `comm.send_slack` — proxy a Slack message through the desktop web
/// endpoint.
pub struct SendSlackTool {
    meta: ToolMeta,
    backend: Arc<dyn SlackBackend>,
}

impl SendSlackTool {
    pub fn new(backend: Arc<dyn SlackBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "comm.send_slack".into(),
                description:
                    "Send a Slack message via the user's installed Slack bot. \
                     `channel` is a Slack channel id / name (`#alerts`, `@user`, `C12345`). \
                     Provide at least one of `text` (plain) or `blocks` (Block Kit JSON). \
                     Always Confirm — every send is one user approval per call."
                        .into(),
                params_schema: slack_schema(),
                default_permission: PermissionLevel::Confirm,
            },
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for SendSlackTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let channel = invocation
            .args
            .get("channel")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing channel".into()))?
            .to_string();
        let text = invocation
            .args
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string);
        let blocks = invocation.args.get("blocks").cloned();

        self.backend
            .send(&channel, text.as_deref(), blocks.as_ref())
            .await
            .map_err(ToolError::ExecutionFailed)?;
        Ok(ToolOutput {
            value: json!({ "ok": true, "channel": channel }),
            summary: Some(format!("Sent Slack to {channel}")),
        })
    }
}

// ── Catalog + register ──────────────────────────────────────────────────────

/// Per-cluster catalog of `ToolMeta` for bookkeeping. S11 is wiring a
/// `catalog_all()` aggregator in `super::mod`; this entry is what it
/// will collect from. Returned metas use placeholder backends (the
/// schema + name + permission default are what matter — the metas
/// don't drive execution).
pub fn catalog() -> Vec<ToolMeta> {
    let placeholder = Arc::new(mocks_placeholder::NoopWhatsApp);
    let placeholder_t = Arc::new(mocks_placeholder::NoopTelegram);
    let placeholder_s = Arc::new(mocks_placeholder::NoopSlack);
    vec![
        SendWhatsAppTool::new(placeholder).meta().clone(),
        SendTelegramTool::new(placeholder_t).meta().clone(),
        SendSlackTool::new(placeholder_s).meta().clone(),
    ]
}

/// Internal placeholder backends used only by [`catalog`]. They never
/// execute — `catalog()` only reads `meta()`. Kept private so the
/// public no-op surface stays empty.
mod mocks_placeholder {
    use super::*;

    pub(super) struct NoopWhatsApp;
    #[async_trait]
    impl WhatsAppBackend for NoopWhatsApp {
        async fn send(&self, _to: &str, _message: &str) -> Result<(), String> {
            Err("placeholder: do not invoke".into())
        }
    }

    pub(super) struct NoopTelegram;
    #[async_trait]
    impl TelegramBackend for NoopTelegram {
        async fn send(
            &self,
            _chat_id: &TelegramChatId,
            _text: &str,
            _parse_mode: Option<&str>,
        ) -> Result<(), String> {
            Err("placeholder: do not invoke".into())
        }
    }

    pub(super) struct NoopSlack;
    #[async_trait]
    impl SlackBackend for NoopSlack {
        async fn send(
            &self,
            _channel: &str,
            _text: Option<&str>,
            _blocks: Option<&Value>,
        ) -> Result<(), String> {
            Err("placeholder: do not invoke".into())
        }
    }
}

/// Register the three comm tools on `reg`. Errors propagate the first
/// [`RegistryError::DuplicateTool`] — same shape as
/// [`super::desktop_os::register_desktop_os_tools`] and
/// [`super::local_exec::register_local_exec_tools`].
pub fn register_comm_tools(
    reg: &ToolRegistry,
    backends: CommBackends,
) -> Result<(), RegistryError> {
    reg.register(Arc::new(SendWhatsAppTool::new(backends.whatsapp)))?;
    reg.register(Arc::new(SendTelegramTool::new(backends.telegram)))?;
    reg.register(Arc::new(SendSlackTool::new(backends.slack)))?;
    Ok(())
}

// ── Mocks (gated) ───────────────────────────────────────────────────────────

#[cfg(any(test, feature = "agent-test-utils"))]
pub mod mocks {
    //! Test-only backend impls. Same gating policy as
    //! [`super::super::local_exec::mocks`] — never compiled by
    //! `cargo build` of the bin/cdylib because a `MockTelegramBackend`
    //! that pretends to send is exactly the kind of object you do
    //! NOT want to wire into production by accident.

    use super::*;
    use std::sync::Mutex;

    // ── MockWhatsAppBackend ─────────────────────────────────────────────────

    #[derive(Debug, Clone)]
    pub struct WhatsAppCall {
        pub to: String,
        pub message: String,
    }

    #[derive(Default)]
    pub struct MockWhatsAppBackend {
        inner: Mutex<MockWhatsAppState>,
    }

    #[derive(Default)]
    struct MockWhatsAppState {
        calls: Vec<WhatsAppCall>,
        next_error: Option<String>,
    }

    impl MockWhatsAppBackend {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }

        pub fn calls(&self) -> Vec<WhatsAppCall> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl WhatsAppBackend for MockWhatsAppBackend {
        async fn send(&self, to: &str, message: &str) -> Result<(), String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(WhatsAppCall {
                to: to.to_string(),
                message: message.to_string(),
            });
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            Ok(())
        }
    }

    // ── MockTelegramBackend ─────────────────────────────────────────────────

    #[derive(Debug, Clone)]
    pub struct TelegramCall {
        pub chat_id: TelegramChatId,
        pub text: String,
        pub parse_mode: Option<String>,
    }

    #[derive(Default)]
    pub struct MockTelegramBackend {
        inner: Mutex<MockTelegramState>,
    }

    #[derive(Default)]
    struct MockTelegramState {
        calls: Vec<TelegramCall>,
        next_error: Option<String>,
    }

    impl MockTelegramBackend {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }

        pub fn calls(&self) -> Vec<TelegramCall> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl TelegramBackend for MockTelegramBackend {
        async fn send(
            &self,
            chat_id: &TelegramChatId,
            text: &str,
            parse_mode: Option<&str>,
        ) -> Result<(), String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(TelegramCall {
                chat_id: chat_id.clone(),
                text: text.to_string(),
                parse_mode: parse_mode.map(str::to_string),
            });
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            Ok(())
        }
    }

    // ── MockSlackBackend ────────────────────────────────────────────────────

    #[derive(Debug, Clone)]
    pub struct SlackCall {
        pub channel: String,
        pub text: Option<String>,
        pub blocks: Option<Value>,
    }

    #[derive(Default)]
    pub struct MockSlackBackend {
        inner: Mutex<MockSlackState>,
    }

    #[derive(Default)]
    struct MockSlackState {
        calls: Vec<SlackCall>,
        next_error: Option<String>,
    }

    impl MockSlackBackend {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }

        pub fn calls(&self) -> Vec<SlackCall> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl SlackBackend for MockSlackBackend {
        async fn send(
            &self,
            channel: &str,
            text: Option<&str>,
            blocks: Option<&Value>,
        ) -> Result<(), String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(SlackCall {
                channel: channel.to_string(),
                text: text.map(str::to_string),
                blocks: blocks.cloned(),
            });
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            Ok(())
        }
    }

    // ── Bundle ──────────────────────────────────────────────────────────────

    /// Convenience: build a [`CommBackends`] over fresh mocks plus
    /// hand back the `Arc`s to each so the test can assert on
    /// recorded calls and queue failures.
    pub fn mock_backends() -> (
        CommBackends,
        Arc<MockWhatsAppBackend>,
        Arc<MockTelegramBackend>,
        Arc<MockSlackBackend>,
    ) {
        let whatsapp = Arc::new(MockWhatsAppBackend::new());
        let telegram = Arc::new(MockTelegramBackend::new());
        let slack = Arc::new(MockSlackBackend::new());

        let bundle = CommBackends {
            whatsapp: whatsapp.clone(),
            telegram: telegram.clone(),
            slack: slack.clone(),
        };
        (bundle, whatsapp, telegram, slack)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::mocks::*;
    use super::*;

    fn invocation(name: &str, args: Value) -> ToolInvocation {
        ToolInvocation {
            id: "test-id".into(),
            tool_name: name.into(),
            args,
            session_id: None,
        }
    }

    // ── send_whatsapp ───────────────────────────────────────────────────────

    #[test]
    fn send_whatsapp_meta_advertises_confirm_default_and_e164_pattern() {
        let tool = SendWhatsAppTool::new(Arc::new(MockWhatsAppBackend::new()));
        assert_eq!(tool.meta().name, "comm.send_whatsapp");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
        let pattern = tool.meta().params_schema["properties"]["to"]["pattern"]
            .as_str()
            .expect("schema must constrain to with E.164 regex");
        assert_eq!(pattern, "^\\+[1-9][0-9]{6,14}$");
    }

    #[tokio::test]
    async fn send_whatsapp_forwards_args_to_backend_canonically() {
        let backend = Arc::new(MockWhatsAppBackend::new());
        let tool = SendWhatsAppTool::new(backend.clone());
        let inv = invocation(
            "comm.send_whatsapp",
            json!({ "to": "+5215551234567", "message": "hi" }),
        );
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["ok"], json!(true));
        assert_eq!(out.value["to"], json!("+5215551234567"));
        let calls = backend.calls();
        assert_eq!(calls.len(), 1);
        // Tool keeps the `+` — sidecar wrapper strips it itself.
        assert_eq!(calls[0].to, "+5215551234567");
        assert_eq!(calls[0].message, "hi");
    }

    #[tokio::test]
    async fn send_whatsapp_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockWhatsAppBackend::new());
        backend.fail_next("sidecar not running");
        let tool = SendWhatsAppTool::new(backend);
        let err = tool
            .execute(&invocation(
                "comm.send_whatsapp",
                json!({ "to": "+15551234567", "message": "x" }),
            ))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::ExecutionFailed(m) if m == "sidecar not running"));
    }

    // ── send_telegram ───────────────────────────────────────────────────────

    #[test]
    fn send_telegram_meta_advertises_confirm_default_and_string_chat_id() {
        // chat_id used to be `oneOf: [string, integer]` but OpenAI/Together's
        // tool-schema validator rejects nested `oneOf`. The schema now declares
        // `string` only — `execute()` still accepts both runtime types (string
        // from the model, integer if a caller bypasses the model). The
        // description tells the model to stringify numeric chat IDs.
        let tool = SendTelegramTool::new(Arc::new(MockTelegramBackend::new()));
        assert_eq!(tool.meta().name, "comm.send_telegram");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
        let chat_id = &tool.meta().params_schema["properties"]["chat_id"];
        assert_eq!(
            chat_id.get("type").and_then(Value::as_str),
            Some("string"),
            "chat_id must declare type=string post-sanitization; got {chat_id}"
        );
        assert!(
            chat_id.get("description").and_then(Value::as_str).is_some(),
            "chat_id must carry a description so the model knows to stringify numeric IDs"
        );
    }

    #[tokio::test]
    async fn send_telegram_carries_string_chat_id() {
        let backend = Arc::new(MockTelegramBackend::new());
        let tool = SendTelegramTool::new(backend.clone());
        tool.execute(&invocation(
            "comm.send_telegram",
            json!({ "chat_id": "@alerts", "text": "ping" }),
        ))
        .await
        .expect("ok");
        let calls = backend.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].chat_id, TelegramChatId::Str("@alerts".into()));
        assert_eq!(calls[0].text, "ping");
        assert_eq!(calls[0].parse_mode, None);
    }

    #[tokio::test]
    async fn send_telegram_carries_integer_chat_id_and_parse_mode() {
        let backend = Arc::new(MockTelegramBackend::new());
        let tool = SendTelegramTool::new(backend.clone());
        tool.execute(&invocation(
            "comm.send_telegram",
            json!({ "chat_id": -1001234567890i64, "text": "ping", "parse_mode": "MarkdownV2" }),
        ))
        .await
        .expect("ok");
        let calls = backend.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].chat_id, TelegramChatId::Int(-1001234567890));
        assert_eq!(calls[0].parse_mode.as_deref(), Some("MarkdownV2"));
    }

    #[tokio::test]
    async fn send_telegram_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockTelegramBackend::new());
        backend.fail_next("desktop_telegram_send: HTTP 401: ...");
        let tool = SendTelegramTool::new(backend);
        let err = tool
            .execute(&invocation(
                "comm.send_telegram",
                json!({ "chat_id": "@x", "text": "x" }),
            ))
            .await
            .expect_err("must fail");
        match err {
            ToolError::ExecutionFailed(m) => assert!(m.contains("HTTP 401")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    // ── send_slack ──────────────────────────────────────────────────────────

    #[test]
    fn send_slack_meta_advertises_confirm_default_and_anyof_text_or_blocks() {
        let tool = SendSlackTool::new(Arc::new(MockSlackBackend::new()));
        assert_eq!(tool.meta().name, "comm.send_slack");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
        let any_of = tool.meta().params_schema["anyOf"]
            .as_array()
            .expect("schema must enforce anyOf(text, blocks)");
        assert_eq!(any_of.len(), 2);
    }

    #[test]
    fn send_slack_blocks_property_has_items_schema() {
        // Regression for the Together 400:
        //   "Invalid schema for function 'comm-send_slack':
        //    In context=('properties', 'blocks'), array schema missing items."
        // OpenAI strict mode + Together's edge validator both require every
        // `type: "array"` to declare `items`. The TS sanitizer also injects
        // a permissive default if missing — but we pin it at the source so
        // the source is self-explanatory and the model gets a real type hint.
        let tool = SendSlackTool::new(Arc::new(MockSlackBackend::new()));
        let blocks = &tool.meta().params_schema["properties"]["blocks"];
        assert_eq!(blocks.get("type").and_then(Value::as_str), Some("array"));
        let items = blocks.get("items").expect("blocks.items must exist");
        assert_eq!(
            items.get("type").and_then(Value::as_str),
            Some("object"),
            "blocks.items must declare type=object (Slack Block Kit blocks are objects); got {items}"
        );
    }

    #[tokio::test]
    async fn send_slack_carries_text_only() {
        let backend = Arc::new(MockSlackBackend::new());
        let tool = SendSlackTool::new(backend.clone());
        tool.execute(&invocation(
            "comm.send_slack",
            json!({ "channel": "C12345", "text": "deploy green" }),
        ))
        .await
        .expect("ok");
        let calls = backend.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].channel, "C12345");
        assert_eq!(calls[0].text.as_deref(), Some("deploy green"));
        assert!(calls[0].blocks.is_none());
    }

    #[tokio::test]
    async fn send_slack_carries_blocks_only() {
        let backend = Arc::new(MockSlackBackend::new());
        let tool = SendSlackTool::new(backend.clone());
        let blocks = json!([{ "type": "section", "text": { "type": "mrkdwn", "text": "hi" } }]);
        tool.execute(&invocation(
            "comm.send_slack",
            json!({ "channel": "#alerts", "blocks": blocks }),
        ))
        .await
        .expect("ok");
        let calls = backend.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].channel, "#alerts");
        assert!(calls[0].text.is_none());
        assert_eq!(calls[0].blocks, Some(blocks));
    }

    #[tokio::test]
    async fn send_slack_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockSlackBackend::new());
        backend.fail_next("desktop_slack_send: HTTP 429: rate limited");
        let tool = SendSlackTool::new(backend);
        let err = tool
            .execute(&invocation(
                "comm.send_slack",
                json!({ "channel": "C1", "text": "x" }),
            ))
            .await
            .expect_err("must fail");
        match err {
            ToolError::ExecutionFailed(m) => assert!(m.contains("HTTP 429")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    // ── catalog ─────────────────────────────────────────────────────────────

    #[test]
    fn catalog_returns_three_tools_with_unique_names_and_confirm_defaults() {
        let metas = catalog();
        assert_eq!(metas.len(), 3);
        let names: std::collections::HashSet<_> = metas.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains("comm.send_whatsapp"));
        assert!(names.contains("comm.send_telegram"));
        assert!(names.contains("comm.send_slack"));
        for m in metas {
            assert_eq!(
                m.default_permission,
                PermissionLevel::Confirm,
                "{} must be Confirm",
                m.name
            );
        }
    }
}
