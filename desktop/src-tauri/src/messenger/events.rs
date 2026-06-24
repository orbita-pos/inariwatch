//! Cross-cutting event bus the messenger layer publishes to.
//!
//! The dock chat surface subscribes to this bus to mirror messenger
//! threads. The IPC layer (S8) wraps it in a Tauri-event bridge so the
//! frontend sees `messenger:turn` / `messenger:sas-pending` payloads.
//!
//! Capacity is generous (256) — each event is small (a few hundred
//! bytes) and the dock catches up after a tab change without dropping
//! the most recent turn.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::attribution::ChannelAttribution;
use super::channel::ChannelKind;

/// Channel capacity for the messenger broadcast. Sized so a slow
/// subscriber (the dock during a window-restore) doesn't lose more than
/// a few seconds of turns. The gateway emits ~one event per inbound +
/// one per outbound + one per tool-call confirm, so 256 buys ~80
/// round-trips.
pub const MESSENGER_BUS_CAPACITY: usize = 256;

/// Round-trip lifecycle stage. Surfaced so a dock subscriber can pick
/// which transitions to render — e.g. show the "Confirm needed" toast
/// only on `RequiresConfirm`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessengerEvent {
    /// Inbound message accepted by the gateway. Surfaced before the
    /// AI loop so the dock can paint the user-side bubble immediately.
    InboundReceived {
        attribution: ChannelAttribution,
        text: String,
        timestamp: DateTime<Utc>,
    },
    /// AI replied with text only (no tool call).
    AssistantReplied {
        attribution: ChannelAttribution,
        text: String,
        /// Audit-log session id. Always `messenger:<prefix>:<entity>`.
        session_id: String,
    },
    /// AI emitted a tool call. The card may still be `pending` or
    /// `confirming` — subscribers update existing cards by `tool_call_id`.
    ToolCallStarted {
        attribution: ChannelAttribution,
        tool_call_id: String,
        tool_name: String,
        session_id: String,
    },
    /// Tool finished (success or failure). Carries the witness
    /// invocation_id for the verifier modal.
    ToolCallFinished {
        attribution: ChannelAttribution,
        tool_call_id: String,
        invocation_id: String,
        tool_name: String,
        success: bool,
        session_id: String,
    },
    /// Tool requires confirmation. Emitted between `Started` and
    /// `Finished`; the gateway pauses until the user replies via the
    /// channel-native confirm UI.
    ToolCallRequiresConfirm {
        attribution: ChannelAttribution,
        tool_call_id: String,
        tool_name: String,
        session_id: String,
    },
    /// Tool was denied by user override.
    ToolCallDenied {
        attribution: ChannelAttribution,
        tool_call_id: String,
        tool_name: String,
        session_id: String,
    },
    /// Round-trip ended. Subscribers use this to drop "in-flight" UI.
    TurnComplete {
        attribution: ChannelAttribution,
        session_id: String,
    },
    /// Pairing flow surfaced a SAS challenge — the desktop modal must
    /// show the same digits. The gateway emits this as soon as `redeem`
    /// returns the challenge.
    SasPending {
        challenge_id: Uuid,
        channel: ChannelKind,
        identifier_redacted: String,
        display_name: String,
        sas_digits: String,
    },
    /// Inbound was rejected because the identifier wasn't paired.
    UnpairedRejected {
        channel: ChannelKind,
        identifier_redacted: String,
        text_preview: String,
    },
}
