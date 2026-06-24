//! Channel trait + shared types.
//!
//! Each integrated messenger (WhatsApp, Telegram, Slack) implements
//! [`Channel`] so the [`super::Gateway`] can fan inbound messages through
//! a single dispatch loop without per-channel branching. The trait is
//! deliberately narrow: send a message, subscribe to inbound, declare
//! the auth policy. Anything channel-specific (Baileys' E.164 ↔ JID
//! conversion, Slack's blocks JSON shape) is owned by each adapter.
//!
//! The trait carries `Arc<dyn …>` instances so the gateway holds
//! channels by trait object — adding a 4th channel later is a single
//! `Vec::push` at boot.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};

// ── Discriminator ───────────────────────────────────────────────────────────

/// Which messenger a message belongs to. Surfaced into the chat
/// surface's attribution chip and into the audit-log session id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ChannelKind {
    /// Renamed explicitly to `"whatsapp"` (no underscore) so the wire
    /// matches `as_str()` and the audit-log session prefix convention.
    /// `serde(rename_all = "snake_case")` would emit `"whats_app"`,
    /// which would drift from every other surface.
    #[serde(rename = "whatsapp")]
    WhatsApp,
    #[serde(rename = "telegram")]
    Telegram,
    #[serde(rename = "slack")]
    Slack,
    /// S12 — mobile PWA paired devices. Wire form `"mobile"` so the
    /// frontend SasConfirmModal can branch on it without a string-cast.
    #[serde(rename = "mobile")]
    MobileDevice,
}

impl ChannelKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelKind::WhatsApp => "whatsapp",
            ChannelKind::Telegram => "telegram",
            ChannelKind::Slack => "slack",
            ChannelKind::MobileDevice => "mobile",
        }
    }

    /// Short code used in the `session_id` convention
    /// (`messenger:wa:<entity>` / `messenger:tg:...` / `messenger:slack:...`
    /// / `messenger:mobile:<device_id>`).
    pub fn session_prefix(&self) -> &'static str {
        match self {
            ChannelKind::WhatsApp => "wa",
            ChannelKind::Telegram => "tg",
            ChannelKind::Slack => "slack",
            ChannelKind::MobileDevice => "mobile",
        }
    }
}

// ── Auth policy ─────────────────────────────────────────────────────────────

/// Declares whether inbound DMs need the pairing primitive before the
/// AI loop runs. WhatsApp uses [`Pairing`] (any phone could text the
/// bot, so without pairing the bot is wide open). Telegram + Slack use
/// [`Open`] because the channel itself is workspace-authenticated via
/// OAuth bot tokens.
///
/// `Custom` is reserved for future channels that need bespoke auth
/// (e.g. signing-secret-bound webhook handlers).
///
/// [`Pairing`]: DmPolicy::Pairing
/// [`Open`]: DmPolicy::Open
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DmPolicy {
    /// Inbound from an unpaired identifier is dropped with a friendly
    /// "please pair first" reply. The pairing primitive in
    /// [`crate::pairing`] mediates.
    Pairing,
    /// Channel-level workspace auth is sufficient (Telegram bot token,
    /// Slack OAuth installation). Inbound runs straight into the AI
    /// loop.
    Open,
    /// Channel-specific. Adapter-defined semantics.
    Custom,
}

// ── Inbound / outbound payloads ─────────────────────────────────────────────

/// One DM the channel handed us. Channel-agnostic — all adapters
/// normalise to this shape. The gateway dispatches on this; channels
/// don't drive the AI loop themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMessage {
    pub channel: ChannelKind,
    /// Phone (E.164 with `+`), `@username`, channel id — channel-defined.
    pub from_identifier: String,
    /// Best-effort human label the channel knows for the sender.
    pub display_name: String,
    pub text: String,
    /// Channel-defined opaque thread id, used by adapters to correlate
    /// replies. None for one-shot DMs that don't carry a thread.
    pub thread_id: Option<String>,
    /// Channel-defined message id for "reply to this specific message".
    pub reply_to: Option<String>,
    pub timestamp: DateTime<Utc>,
}

/// Reply to be sent. Channels translate this to their native shape:
/// WhatsApp = plain text + interactive buttons; Telegram = inline
/// keyboard; Slack = blocks. Buttons are a small union — channels that
/// don't support inline buttons (S5 v1 WhatsApp via Baileys) emit plain
/// text with the action labels as a fallback "tap to reply with"
/// hint.
#[derive(Debug, Clone)]
pub struct OutboundMessage {
    pub text: String,
    pub buttons: Vec<MessageButton>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageButton {
    /// User-visible label — e.g. "Confirm", "Open Settings", "Cancel".
    pub label: String,
    /// Opaque payload the channel relays back on click. Adapters that
    /// don't support a callback payload (Baileys today) parse the next
    /// inbound text against this string verbatim.
    pub callback: String,
}

/// Identifier the channel returns after a successful send. Round-trips
/// in a future "edit this message" path; not used by S8 itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageId {
    pub channel: ChannelKind,
    pub raw: String,
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ChannelError {
    #[error("channel `{kind}` is offline: {reason}")]
    Offline {
        kind: &'static str,
        reason: String,
    },

    /// Adapter wraps a tool error from `ToolRegistry::invoke_traced` —
    /// surfaced when the outbound path goes through `comm.send_*`.
    #[error("tool: {0}")]
    Tool(String),

    /// Catch-all for transport / serialisation issues.
    #[error("transport: {0}")]
    Transport(String),
}

// ── Trait ───────────────────────────────────────────────────────────────────

/// Surface a messenger exposes to the [`super::Gateway`]. Implementations
/// MUST be cheap to clone (the gateway holds them through `Arc<dyn>`).
///
/// `subscribe` returns a `BoxStream` of inbound messages. The gateway
/// merges streams from every channel via `tokio_stream::StreamExt::merge_all`
/// and dispatches one task per inbound DM.
#[async_trait]
pub trait Channel: Send + Sync {
    fn kind(&self) -> ChannelKind;

    /// Whether unpaired inbound messages require the pairing flow.
    fn dm_policy(&self) -> DmPolicy;

    /// Subscribe to the channel's inbound feed. The returned stream
    /// stays alive for the lifetime of the channel — the gateway only
    /// calls `subscribe` once per channel during `Gateway::run`.
    async fn subscribe(&self) -> BoxStream<'static, InboundMessage>;

    /// Send `msg` to the identifier (phone E.164 / `@user` / `#alerts`
    /// — channel-defined; the adapter is responsible for any necessary
    /// translation). The session id is the gateway's
    /// `messenger:<prefix>:<entity_id>` so witness receipts emitted by
    /// outbound tool calls are filed under the correct session.
    async fn send(
        &self,
        to_identifier: &str,
        msg: &OutboundMessage,
        session_id: &str,
    ) -> Result<MessageId, ChannelError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_kind_serializes_to_explicit_lowercase() {
        // We rename each variant explicitly (rather than relying on
        // `rename_all = "snake_case"`, which would emit `"whats_app"`)
        // so the wire form matches the audit-log session prefix
        // convention and the per-channel `as_str()`.
        let raw = serde_json::to_string(&ChannelKind::WhatsApp).unwrap();
        assert_eq!(raw, "\"whatsapp\"");
        assert_eq!(ChannelKind::WhatsApp.as_str(), "whatsapp");
        assert_eq!(ChannelKind::Telegram.as_str(), "telegram");
        assert_eq!(ChannelKind::Slack.as_str(), "slack");
        // Round-trip.
        let back: ChannelKind = serde_json::from_str("\"whatsapp\"").unwrap();
        assert_eq!(back, ChannelKind::WhatsApp);
    }

    #[test]
    fn channel_kind_session_prefixes_match_convention() {
        assert_eq!(ChannelKind::WhatsApp.session_prefix(), "wa");
        assert_eq!(ChannelKind::Telegram.session_prefix(), "tg");
        assert_eq!(ChannelKind::Slack.session_prefix(), "slack");
    }

    #[test]
    fn dm_policy_round_trips_through_serde() {
        for (p, raw) in [
            (DmPolicy::Pairing, "\"pairing\""),
            (DmPolicy::Open, "\"open\""),
            (DmPolicy::Custom, "\"custom\""),
        ] {
            let s = serde_json::to_string(&p).unwrap();
            assert_eq!(s, raw);
            let back: DmPolicy = serde_json::from_str(raw).unwrap();
            assert_eq!(p, back);
        }
    }
}
