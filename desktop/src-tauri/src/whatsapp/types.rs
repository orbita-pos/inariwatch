//! v0.3 S5 — JSON-RPC payload shapes for the Baileys sidecar.
//!
//! Mirrors `desktop/src-tauri/sidecars/whatsapp/src/types.ts` —
//! changing one side requires changing the other. Both sides round-trip
//! through serde / `JSON.stringify`, so field names and casings must match
//! literally.

use serde::{Deserialize, Serialize};

/// Status of a single linked account. Frontend renders this via the
/// `whatsapp_list_accounts` IPC command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountInfo {
    pub account_id: String,
    /// User-visible label. Set when `whatsapp_login_start` is invoked.
    pub label: String,
    /// JID of the linked account once paired (e.g.,
    /// `5215551234567@s.whatsapp.net`). `None` while QR-pending or after
    /// logout.
    pub self_jid: Option<String>,
    pub status: ConnectionStatus,
    /// Unix epoch ms when the most recent QR string was emitted to the
    /// frontend. `None` when no QR has been issued in the current
    /// login attempt.
    pub last_qr_at_ms: Option<i64>,
    /// Unix epoch ms when the account most recently transitioned to
    /// `linked`.
    pub last_linked_at_ms: Option<i64>,
}

/// Lifecycle stages the frontend renders distinctly in the Settings UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    /// Initial state — no login has been attempted, OR the user
    /// explicitly logged out.
    Disconnected,
    /// QR has been requested and is being rendered. Frontend listens to
    /// `whatsapp:qr-update` events for the actual QR string.
    QrPending,
    /// Paired and reachable. Outbound `send_message` will succeed.
    Connected,
    /// Was paired, lost the WS — sidecar is reconnecting with backoff.
    Reconnecting,
    /// Multiple consecutive reconnects failed; sidecar gave up.
    /// Frontend should show "Reconnect" CTA.
    Failed,
}

impl ConnectionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectionStatus::Disconnected => "disconnected",
            ConnectionStatus::QrPending => "qr_pending",
            ConnectionStatus::Connected => "connected",
            ConnectionStatus::Reconnecting => "reconnecting",
            ConnectionStatus::Failed => "failed",
        }
    }
}

/// Emitted to the frontend (and our event sink) every time the sidecar
/// produces a fresh QR. The frontend renders this in the modal until
/// the matching `linked` event lands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QrUpdate {
    pub account_id: String,
    /// The raw QR string (Baileys' `pairingCode`-shaped output). The
    /// frontend feeds this into a `qrcode` lib to render the SVG.
    pub qr: String,
    pub ts_ms: i64,
}

/// Outbound message send payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageRequest {
    pub account_id: String,
    /// E.164 phone (no leading `+`, no spaces). Sidecar converts to JID.
    pub to: String,
    pub body: String,
    /// Optional WhatsApp message id of a message to reply to. Surfaces
    /// "Reply" in the recipient's app.
    #[serde(default)]
    pub reply_to: Option<String>,
}

/// Successful send result. `message_id` is what `WAMessageKey.id` returns
/// from Baileys — useful as a `reply_to` in subsequent sends.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResponse {
    pub message_id: String,
    /// JID we actually sent to (after E.164 → JID conversion).
    pub to_jid: String,
}

/// Push-notification-shaped events the sidecar emits on its own
/// schedule. Re-published as Tauri events to the frontend AND used
/// inside the SidecarManager to update the in-process AccountInfo
/// snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WhatsAppEvent {
    QrUpdate {
        account_id: String,
        qr: String,
        ts_ms: i64,
    },
    Linked {
        account_id: String,
        self_jid: String,
        ts_ms: i64,
    },
    LoggedOut {
        account_id: String,
        ts_ms: i64,
    },
    ConnectionStateChanged {
        account_id: String,
        status: ConnectionStatus,
        ts_ms: i64,
    },
    /// Sidecar process emitted a fatal error (uncaught exception, peer
    /// closed, etc.). The frontend shows this as a toast.
    Fatal {
        account_id: Option<String>,
        message: String,
        ts_ms: i64,
    },
    /// v0.3 S8 — inbound DM. Emitted by the sidecar after a
    /// `messages.upsert` from Baileys. The bridge in
    /// `crate::messenger::whatsapp::sidecar_bridge` filters these
    /// (drops `from_me` echoes + group `@g.us` JIDs) and surfaces them
    /// as `crate::messenger::channel::InboundMessage`s.
    MessageReceived {
        account_id: String,
        /// Sender JID. For DMs that's `<digits>@s.whatsapp.net`; the
        /// bridge converts to E.164.
        from_jid: String,
        /// Push name (Baileys' best-effort display name from the
        /// sender's WhatsApp profile). May be empty.
        #[serde(default)]
        push_name: Option<String>,
        /// Message text — extracted from the WAMessage.message body
        /// (`conversation` / `extendedTextMessage.text`). The Node
        /// sidecar already filters non-text shapes (image, audio, …)
        /// so the bridge can assume a plain string here.
        text: String,
        /// `WAMessageKey.id` for "reply to this specific message"
        /// flows on outbound side.
        message_id: String,
        ts_ms: i64,
        /// True when the sender is the linked account itself (echoed
        /// onto the same socket because the user typed in the WhatsApp
        /// app). Bridge drops these.
        #[serde(default)]
        from_me: bool,
        /// True when the JID is a group (`@g.us`). Sidecar should
        /// already filter these; bridge double-checks. Out of scope
        /// for v1 (S8 = 1:1 DMs only).
        #[serde(default)]
        is_group: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_status_serializes_snake_case() {
        let s = ConnectionStatus::QrPending;
        let raw = serde_json::to_string(&s).unwrap();
        assert_eq!(raw, "\"qr_pending\"");
        let back: ConnectionStatus = serde_json::from_str("\"connected\"").unwrap();
        assert_eq!(back, ConnectionStatus::Connected);
    }

    #[test]
    fn whatsapp_event_uses_tagged_union() {
        let e = WhatsAppEvent::Linked {
            account_id: "a1".into(),
            self_jid: "5215551234567@s.whatsapp.net".into(),
            ts_ms: 0,
        };
        let raw = serde_json::to_value(&e).unwrap();
        assert_eq!(raw["type"], "linked");
        assert_eq!(raw["account_id"], "a1");
    }

    #[test]
    fn send_message_omits_optional_reply_to_when_none() {
        let req = SendMessageRequest {
            account_id: "a1".into(),
            to: "5215551234567".into(),
            body: "hi".into(),
            reply_to: None,
        };
        let raw = serde_json::to_value(&req).unwrap();
        assert_eq!(raw["reply_to"], serde_json::Value::Null);
    }
}
