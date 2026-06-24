//! Slack Channel adapter — read-only mirror.
//!
//! Same shape as [`crate::messenger::telegram::adapter::TelegramChannel`].

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use tokio::sync::broadcast;

use super::super::channel::{
    Channel, ChannelError, ChannelKind, DmPolicy, InboundMessage, MessageId, OutboundMessage,
};
use super::inbound::{self, SlackMirrorPayload};

pub struct SlackChannel {
    /// Public so the relay handler can take a `Sender::clone()` at boot.
    pub mirror_tx: broadcast::Sender<SlackMirrorPayload>,
    inbound_stream: Mutex<Option<BoxStream<'static, InboundMessage>>>,
    backend: Option<Arc<dyn crate::agent::tools::SlackBackend>>,
}

impl SlackChannel {
    pub fn new(backend: Option<Arc<dyn crate::agent::tools::SlackBackend>>) -> Self {
        let (tx, stream) = inbound::build_bus();
        Self {
            mirror_tx: tx,
            inbound_stream: Mutex::new(Some(stream)),
            backend,
        }
    }

    #[cfg(any(test, feature = "agent-test-utils"))]
    pub fn for_test(stream: BoxStream<'static, InboundMessage>) -> Self {
        let (tx, _) = broadcast::channel(1);
        Self {
            mirror_tx: tx,
            inbound_stream: Mutex::new(Some(stream)),
            backend: None,
        }
    }
}

#[async_trait]
impl Channel for SlackChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::Slack
    }

    fn dm_policy(&self) -> DmPolicy {
        DmPolicy::Open
    }

    async fn subscribe(&self) -> BoxStream<'static, InboundMessage> {
        let mut guard = self.inbound_stream.lock().expect("inbound stream lock poisoned");
        guard
            .take()
            .unwrap_or_else(|| futures_util::stream::empty().boxed())
    }

    async fn send(
        &self,
        to_identifier: &str,
        msg: &OutboundMessage,
        _session_id: &str,
    ) -> Result<MessageId, ChannelError> {
        let backend = self.backend.as_ref().ok_or_else(|| ChannelError::Offline {
            kind: "slack",
            reason: "slack backend not wired (S8 mirror is read-only — outbound for mirror lands in S8.5)"
                .to_string(),
        })?;
        backend
            .send(to_identifier, Some(&msg.text), None)
            .await
            .map_err(ChannelError::Transport)?;
        Ok(MessageId {
            channel: ChannelKind::Slack,
            raw: format!("slack:{to_identifier}"),
        })
    }
}

use futures_util::stream::StreamExt;
