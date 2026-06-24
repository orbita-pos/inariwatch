//! `Channel` impl for the S12 mobile PWA.
//!
//! The mobile PWA is a thin client; its chat / fix actions hit the
//! web API directly. Therefore this Channel:
//!
//! - `subscribe()` returns an empty inbound stream — DMs never
//!   arrive from the mobile through the desktop. (Placeholder is
//!   intentional; S12.5 may wire push notifications back to the
//!   desktop's notifications surface.)
//! - `send()` returns `ChannelError::Offline` — outbound notifications
//!   go through the web's web-push pipeline, not the desktop. The
//!   gateway never actually calls `send()` on this channel today
//!   because there is no inbound to reply to.
//!
//! The point of this Channel impl is to occupy the
//! `ChannelKind::MobileDevice` slot in the messenger Gateway so:
//!
//! 1. `Gateway::dispatch` exhaustive matches keep compiling when a
//!    future code path adds a mobile-side inbound (e.g. a relay-
//!    forwarded chat message).
//! 2. The frontend Channels list shows "Mobile" alongside WhatsApp /
//!    Telegram / Slack with consistent Channel-trait wiring.

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream};

use crate::messenger::channel::{
    Channel, ChannelError, ChannelKind, DmPolicy, InboundMessage, MessageId, OutboundMessage,
};

/// Mobile-PWA channel. Stateless; the actual state lives in web's
/// `mobile_paired_devices` table.
#[derive(Default, Debug, Clone)]
pub struct MobileChannel;

impl MobileChannel {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Channel for MobileChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::MobileDevice
    }

    fn dm_policy(&self) -> DmPolicy {
        // Mobile devices ARE paired (via S12's web-side pairing flow);
        // the gateway only ever sees pre-authenticated identifiers, so
        // the DM-policy gate is a no-op. We declare `Pairing` for
        // semantic accuracy + so the gateway's pairing handler doesn't
        // synthesise a fake PairedEntity for unknown pubkeys.
        DmPolicy::Pairing
    }

    async fn subscribe(&self) -> BoxStream<'static, InboundMessage> {
        // No inbound. The gateway calls `subscribe` once at boot — we
        // hand it an empty stream so the merge_all in `Gateway::run`
        // sees a no-op contributor.
        Box::pin(stream::empty())
    }

    async fn send(
        &self,
        _to_identifier: &str,
        _msg: &OutboundMessage,
        _session_id: &str,
    ) -> Result<MessageId, ChannelError> {
        // Outbound is web-push, fired from the cloud. The desktop
        // Channel surface returning Offline communicates "this lane
        // is server-driven, not desktop-driven" without crashing the
        // gateway if a future path tries to send through here.
        Err(ChannelError::Offline {
            kind:   "mobile",
            reason: "mobile push runs server-side; desktop does not send to mobile devices"
                .to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn kind_is_mobile_device() {
        let m = MobileChannel::new();
        assert_eq!(m.kind(), ChannelKind::MobileDevice);
    }

    #[test]
    fn dm_policy_is_pairing() {
        let m = MobileChannel::new();
        assert_eq!(m.dm_policy(), DmPolicy::Pairing);
    }

    #[tokio::test]
    async fn subscribe_returns_empty_stream() {
        let m = MobileChannel::new();
        let s = m.subscribe().await;
        let collected: Vec<_> = s.collect().await;
        assert!(collected.is_empty());
    }

    #[tokio::test]
    async fn send_returns_offline_error() {
        let m = MobileChannel::new();
        let r = m
            .send(
                "abc",
                &OutboundMessage {
                    text:    "hi".to_string(),
                    buttons: Vec::new(),
                    thread_id: None,
                },
                "session",
            )
            .await;
        assert!(matches!(r, Err(ChannelError::Offline { kind, .. }) if kind == "mobile"));
    }
}
