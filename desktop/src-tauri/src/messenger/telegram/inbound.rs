//! Relay subscriber for `messenger.mirror.tg-conversation` events.
//!
//! S8 design decision: the AI loop for Telegram stays web-side. The
//! desktop only mirrors threads. To avoid building a new relay
//! transport, we extend the existing
//! [`crate::relay_client::handle_dispatch`] dispatcher with a new task
//! name and route messages into a per-process `tokio::sync::broadcast`
//! that the channel adapter subscribes to.
//!
//! ## S8.5 follow-up
//!
//! Once the desktop is willing to host the Telegram AI loop locally,
//! the same channel mechanism flips into bidirectional mode without
//! changing the inbound shape — the gateway just stops short-circuiting
//! tg traffic into "mirror only" and runs the loop. The web bot would
//! then back off (or stay on as an offline-fallback brain).

use chrono::{TimeZone, Utc};
use futures_util::stream::{self, BoxStream, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::messenger::channel::{ChannelKind, InboundMessage};

/// Capacity of the per-process Telegram mirror bus. Tiny — the web bot
/// is the source of truth for conversation history; this only buffers
/// turns the desktop hasn't yet rendered.
pub const TELEGRAM_MIRROR_CAPACITY: usize = 64;

/// Wire shape the relay handler emits. Mirrors the JSON the
/// web `/api/desktop/telegram/...` endpoint forwards. Kept loose
/// (`#[serde(default)]` everywhere) so a server-side schema bump
/// doesn't break the desktop until we ship the matching client.
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramMirrorPayload {
    /// `@username` or numeric chat id (string form).
    pub from_identifier: String,
    #[serde(default)]
    pub display_name: String,
    pub text: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    /// Unix epoch ms.
    #[serde(default)]
    pub ts_ms: Option<i64>,
}

/// Build a fresh broadcast channel + the receiving stream the adapter
/// will hand to the gateway. Returns the `Sender` so the relay handler
/// can publish into it.
pub fn build_bus() -> (broadcast::Sender<TelegramMirrorPayload>, BoxStream<'static, InboundMessage>)
{
    let (tx, rx) = broadcast::channel::<TelegramMirrorPayload>(TELEGRAM_MIRROR_CAPACITY);
    let stream = stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(payload) => return Some((payload, rx)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        skipped,
                        "[messenger:tg] mirror bus lagged — dropping events"
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
    .map(|p: TelegramMirrorPayload| InboundMessage {
        channel: ChannelKind::Telegram,
        from_identifier: p.from_identifier,
        display_name: p.display_name,
        text: p.text,
        thread_id: p.thread_id,
        reply_to: p.reply_to,
        timestamp: p
            .ts_ms
            .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
            .unwrap_or_else(Utc::now),
    })
    .boxed();
    (tx, stream)
}

#[cfg(any(test, feature = "agent-test-utils"))]
pub fn test_stream(messages: Vec<InboundMessage>) -> BoxStream<'static, InboundMessage> {
    stream::iter(messages).boxed()
}
