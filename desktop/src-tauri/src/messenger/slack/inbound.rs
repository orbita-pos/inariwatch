//! Relay subscriber for `messenger.mirror.slack-conversation` events.
//!
//! Mirror of [`crate::messenger::telegram::inbound`] for Slack. Same
//! S8.5 design path applies.

use chrono::{TimeZone, Utc};
use futures_util::stream::{self, BoxStream, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::messenger::channel::{ChannelKind, InboundMessage};

pub const SLACK_MIRROR_CAPACITY: usize = 64;

#[derive(Debug, Clone, Deserialize)]
pub struct SlackMirrorPayload {
    /// Slack `Cxxx` channel id (or `Dxxx` IM channel) the message lives
    /// in. Surfaced as the "from" identifier in the dock so the user
    /// sees `from #alerts` / `from @user`.
    pub from_identifier: String,
    #[serde(default)]
    pub display_name: String,
    pub text: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub ts_ms: Option<i64>,
}

pub fn build_bus() -> (broadcast::Sender<SlackMirrorPayload>, BoxStream<'static, InboundMessage>) {
    let (tx, rx) = broadcast::channel::<SlackMirrorPayload>(SLACK_MIRROR_CAPACITY);
    let stream = stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(payload) => return Some((payload, rx)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        skipped,
                        "[messenger:slack] mirror bus lagged — dropping events"
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
    .map(|p: SlackMirrorPayload| InboundMessage {
        channel: ChannelKind::Slack,
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
