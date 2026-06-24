//! `Channel` impl for WhatsApp.
//!
//! Outbound: adapts `comm.send_whatsapp` via `ToolRegistry::invoke_traced_confirmed`.
//! We call `_confirmed` because the messenger turn-level confirmation
//! was either:
//!
//! 1. Already passed through (if the loop's two-phase invoke surfaced
//!    `RequiresConfirm` and the user replied `confirm`), OR
//! 2. Not required (if the bot is replying with its own assistant
//!    text, no tool — the channel.send for that path doesn't go
//!    through `comm.send_whatsapp`).
//!
//! For the actual reply text the gateway emits as the AI loop's
//! "assistant text", we route directly through the SidecarManager —
//! that's what S5 already wired and what notify.compose.whatsapp uses.
//! Going through `comm.send_whatsapp` here would double-charge audit
//! rows (the loop already wrote one row for the LLM round-trip).
//!
//! ## Inbound
//!
//! [`WhatsAppChannel::subscribe`] returns the bridge's stream from
//! [`super::sidecar_bridge::subscribe_inbound`].

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::stream::BoxStream;

use crate::whatsapp::{ConnectionStatus, SendMessageRequest, SidecarManager};

use super::super::channel::{
    Channel, ChannelError, ChannelKind, DmPolicy, InboundMessage, MessageId, OutboundMessage,
};
use super::sidecar_bridge;

/// Production WhatsApp channel adapter.
pub struct WhatsAppChannel {
    manager: Arc<SidecarManager>,
}

impl WhatsAppChannel {
    pub fn new(manager: Arc<SidecarManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl Channel for WhatsAppChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::WhatsApp
    }

    fn dm_policy(&self) -> DmPolicy {
        DmPolicy::Pairing
    }

    async fn subscribe(&self) -> BoxStream<'static, InboundMessage> {
        sidecar_bridge::subscribe_inbound(self.manager.clone())
    }

    async fn send(
        &self,
        to_identifier: &str,
        msg: &OutboundMessage,
        _session_id: &str,
    ) -> Result<MessageId, ChannelError> {
        // Pick the first paired account (same approach as S5's
        // `TauriWhatsAppBackend`). If none paired, return Offline so
        // the gateway can surface a stable error to the user.
        let accounts = self.manager.list_accounts().await;
        let account_id = accounts
            .into_iter()
            .find(|a| matches!(a.status, ConnectionStatus::Connected))
            .map(|a| a.account_id)
            .ok_or_else(|| ChannelError::Offline {
                kind: "whatsapp",
                reason:
                    "no linked WhatsApp account is connected — pair one in Settings → Channels"
                        .to_string(),
            })?;

        // E.164 with `+` → strip for the sidecar (`SendMessageRequest::to`
        // documented as no leading `+`).
        let to_no_plus = to_identifier.strip_prefix('+').unwrap_or(to_identifier);

        // Render buttons inline — Baileys doesn't expose interactive
        // list / button messages from a personal account on the public
        // WhatsApp protocol (it's a Business-only feature). We append a
        // plain-text affordance.
        let body = if msg.buttons.is_empty() {
            msg.text.clone()
        } else {
            let labels: Vec<String> = msg
                .buttons
                .iter()
                .map(|b| format!("• Reply `{}` for {}", b.callback, b.label))
                .collect();
            format!("{}\n\n{}", msg.text, labels.join("\n"))
        };

        let resp = self
            .manager
            .send_message(SendMessageRequest {
                account_id,
                to: to_no_plus.to_string(),
                body,
                reply_to: None,
            })
            .await
            .map_err(|e| ChannelError::Transport(e.to_string()))?;

        Ok(MessageId {
            channel: ChannelKind::WhatsApp,
            raw: resp.message_id,
        })
    }
}
