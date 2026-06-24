//! Telegram Channel adapter — read-only mirror.
//!
//! Outbound from this adapter routes through `comm.send_telegram` via
//! the existing S5 backend pipeline; we don't duplicate that here. The
//! gateway's `Channel::send` for Telegram is exercised when the user
//! types a reply in the dock for a tg-attributed thread; the chat
//! surface invokes `comm.send_telegram` through the `ToolRegistry`
//! itself (matching the dock's S6 path). For S8 the gateway never
//! triggers outbound — the AI loop is web-side — so this adapter's
//! `send` is wired but inert in production.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use tokio::sync::broadcast;

use crate::agent::tools::TelegramChatId;

use super::super::channel::{
    Channel, ChannelError, ChannelKind, DmPolicy, InboundMessage, MessageId, OutboundMessage,
};
use super::inbound::{self, TelegramMirrorPayload};

/// Production Telegram mirror channel. Carries the broadcast `Sender`
/// (for the relay handler to publish into) and a single-shot `Mutex`
/// over the receiving stream (since `Channel::subscribe` is `&self` →
/// the stream must move out of the adapter exactly once).
pub struct TelegramChannel {
    /// Public so the relay handler in `crate::relay_client` can take a
    /// `Sender::clone()` at boot.
    pub mirror_tx: broadcast::Sender<TelegramMirrorPayload>,
    inbound_stream: Mutex<Option<BoxStream<'static, InboundMessage>>>,
    /// S5 backend reused for outbound. `None` in tests (where we don't
    /// drive outbound — only mirror inbound).
    backend: Option<Arc<dyn crate::agent::tools::TelegramBackend>>,
}

impl TelegramChannel {
    pub fn new(backend: Option<Arc<dyn crate::agent::tools::TelegramBackend>>) -> Self {
        let (tx, stream) = inbound::build_bus();
        Self {
            mirror_tx: tx,
            inbound_stream: Mutex::new(Some(stream)),
            backend,
        }
    }

    /// Test-only constructor that injects a pre-built inbound stream.
    /// Useful for the gateway integration test that drives the mirror
    /// without spinning up the relay handler.
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
impl Channel for TelegramChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::Telegram
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
            kind: "telegram",
            reason: "telegram backend not wired (S8 mirror is read-only — outbound for mirror lands in S8.5)"
                .to_string(),
        })?;
        let chat_id = TelegramChatId::Str(to_identifier.to_string());
        backend
            .send(&chat_id, &msg.text, None)
            .await
            .map_err(ChannelError::Transport)?;
        Ok(MessageId {
            channel: ChannelKind::Telegram,
            raw: format!("tg:{to_identifier}"),
        })
    }
}

use futures_util::stream::StreamExt;
