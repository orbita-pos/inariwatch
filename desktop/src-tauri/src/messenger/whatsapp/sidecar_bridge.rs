//! Bridge: subscribe to the Baileys [`SidecarManager`] broadcast channel
//! and surface `MessageReceived` events as `InboundMessage`s.
//!
//! The Node sidecar (`desktop/src-tauri/sidecars/whatsapp/src/session.ts`)
//! handles `sock.ev.on('messages.upsert', …)` and emits a
//! `WhatsAppEvent::MessageReceived` notification. The Rust manager fans
//! that into a `tokio::sync::broadcast` for arbitrary subscribers; this
//! module is the messenger gateway's subscriber.
//!
//! ## Filtering
//!
//! - Group JIDs (`@g.us`) are filtered out at the sidecar level. We
//!   double-check here in case a future sidecar drops the filter — DMs
//!   only for S8.
//! - `from_me` messages are filtered: when the user sends a message
//!   from the WhatsApp app on their phone (not via Inari), Baileys
//!   surfaces it on the same socket. We skip them — only inbound DMs
//!   from contacts trigger the AI loop.

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use futures_util::stream::{self, BoxStream, StreamExt};
use tokio::sync::broadcast;

use crate::messenger::channel::{ChannelKind, InboundMessage};
use crate::whatsapp::{SidecarManager, WhatsAppEvent};

/// Build a stream of `InboundMessage`s by subscribing to the manager's
/// broadcast channel. The stream stays alive for the lifetime of the
/// adapter; subscribers that lag log a warn and drop the missed events
/// (broadcast `Lagged` error is per-receiver).
pub fn subscribe_inbound(manager: Arc<SidecarManager>) -> BoxStream<'static, InboundMessage> {
    let rx = manager.subscribe();
    // Roll our own broadcast→stream adapter using `unfold` so we don't
    // need the optional `tokio-stream` crate. The closure owns the
    // receiver and pulls one event per `await`. End-of-stream when the
    // sender is closed.
    stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => return Some((event, rx)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        skipped,
                        "[messenger:wa] broadcast lagged — dropping inbound events"
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
    .filter_map(|event: WhatsAppEvent| async move {
        match event {
            WhatsAppEvent::MessageReceived {
                from_jid,
                push_name,
                text,
                message_id: _,
                ts_ms,
                from_me,
                is_group,
                ..
            } => {
                if from_me || is_group {
                    return None;
                }
                let from_identifier = jid_to_e164(&from_jid)?;
                let timestamp = Utc.timestamp_millis_opt(ts_ms).single().unwrap_or_else(Utc::now);
                Some(InboundMessage {
                    channel: ChannelKind::WhatsApp,
                    from_identifier,
                    display_name: push_name.unwrap_or_default(),
                    text,
                    thread_id: None,
                    reply_to: None,
                    timestamp,
                })
            }
            _ => None,
        }
    })
    .boxed()
}

/// Convert a Baileys JID (`<digits>@s.whatsapp.net`) to E.164 with a
/// leading `+`. `None` if the JID isn't a personal contact (e.g. a
/// group `@g.us` slipped through somehow).
///
/// Strips the device suffix Baileys appends (`:13` etc.) BEFORE
/// extracting digits, so a multi-device sender doesn't end up with
/// "+5215551234567**13**" — the device id is not part of the phone.
pub fn jid_to_e164(jid: &str) -> Option<String> {
    let (digits_part, suffix) = jid.split_once('@')?;
    if suffix != "s.whatsapp.net" {
        return None;
    }
    // Drop the optional device suffix `:N` before counting digits.
    let phone_only = match digits_part.split_once(':') {
        Some((phone, _device)) => phone,
        None => digits_part,
    };
    let cleaned: String = phone_only.chars().filter(|c| c.is_ascii_digit()).collect();
    if cleaned.len() < 6 {
        return None;
    }
    Some(format!("+{cleaned}"))
}

/// Test-only stream factory: wrap a slice of `InboundMessage`s into a
/// `BoxStream`. Used by the gateway tests so they don't have to spin up
/// the sidecar to drive end-to-end behaviour.
#[cfg(any(test, feature = "agent-test-utils"))]
pub fn test_stream(messages: Vec<InboundMessage>) -> BoxStream<'static, InboundMessage> {
    stream::iter(messages).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jid_to_e164_round_trips_a_personal_jid() {
        assert_eq!(
            jid_to_e164("5215551234567@s.whatsapp.net"),
            Some("+5215551234567".to_string())
        );
    }

    #[test]
    fn jid_to_e164_strips_non_digits() {
        // Baileys sometimes emits `:13` for device suffixes; we drop them.
        assert_eq!(
            jid_to_e164("5215551234567:13@s.whatsapp.net"),
            Some("+5215551234567".to_string())
        );
    }

    #[test]
    fn jid_to_e164_returns_none_for_group_jid() {
        assert!(jid_to_e164("12345-67890@g.us").is_none());
    }

    #[test]
    fn jid_to_e164_returns_none_for_short_or_malformed() {
        assert!(jid_to_e164("@s.whatsapp.net").is_none());
        assert!(jid_to_e164("abc@s.whatsapp.net").is_none());
        assert!(jid_to_e164("nodomain").is_none());
    }
}
