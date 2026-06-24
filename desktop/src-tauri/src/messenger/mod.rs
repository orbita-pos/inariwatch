//! Inari Live messenger-as-UI surface (S8).
//!
//! Turns WhatsApp / Telegram / Slack into a chat surface for the agent
//! by routing inbound DMs through the same `ToolRegistry` the dock
//! chat uses. WhatsApp goes through the full bidirectional pipeline
//! (AI loop on desktop, witness bit-exact); Telegram + Slack are
//! read-only mirrors of the existing web bots in S8 — full bidirection
//! lands in S8.5.
//!
//! ## Module layout
//!
//! - [`channel`] — `Channel` trait + `InboundMessage` / `OutboundMessage`
//!   + `DmPolicy`.
//! - [`gateway`] — `Gateway` orchestrator: pairing gate → per-entity
//!   mutex → AI loop → channel reply.
//! - [`ai_loop`] — single round-trip with two-phase invoke + AI
//!   dispatch trait.
//! - [`attribution`] — `ChannelAttribution` payload for the dock chat
//!   surface mirror.
//! - [`events`] — `MessengerEvent` cross-cutting bus.
//! - [`whatsapp`] / [`telegram`] / [`slack`] — per-channel adapters.
//!
//! ## Boot wiring (lib.rs)
//!
//! Pseudo-code for the S8 boot wire-up that lib.rs will land:
//!
//! ```ignore
//! let pairing = Arc::new(PairingService::new(PairingStore::new(pool)));
//! let (bus_tx, _) = broadcast::channel(MESSENGER_BUS_CAPACITY);
//! let gateway = Gateway::new(
//!     pairing.clone(),
//!     registry.clone(),
//!     ai_dispatch.clone(),
//!     bus_tx.clone(),
//!     workspace_id,
//! );
//! let wa = Arc::new(WhatsAppChannel::new(sidecar_manager.clone()));
//! let tg = Arc::new(TelegramChannel::new(Some(telegram_backend.clone())));
//! let slack = Arc::new(SlackChannel::new(Some(slack_backend.clone())));
//! tauri::async_runtime::spawn(gateway.run(vec![wa, tg, slack]));
//! ```
//!
//! S8 does NOT call this from `lib.rs::run()` yet — full boot wiring is
//! S8.5 once the AI dispatch adapter is finalised. The module compiles
//! cleanly so the IPC layer (S8) can be wired ahead of full boot.

pub mod ai_loop;
pub mod attribution;
pub mod channel;
pub mod events;
pub mod gateway;
// S12 — mobile PWA channel slot. Empty inbound; outbound is server-driven.
pub mod mobile;
pub mod slack;
pub mod telegram;
pub mod whatsapp;

#[cfg(test)]
mod tests;

pub use ai_loop::{AiDispatch, AiError, AiResponse, AiToolCall, LoopOutcome};
pub use attribution::{redact_identifier, ChannelAttribution};
pub use channel::{
    Channel, ChannelError, ChannelKind, DmPolicy, InboundMessage, MessageButton, MessageId,
    OutboundMessage,
};
pub use events::{MessengerEvent, MESSENGER_BUS_CAPACITY};
pub use gateway::Gateway;
// S12 — re-export mobile channel + relay-pair payload helper.
pub use mobile::{handle_relay_pair_event, MobileChannel, MobileSasShownPayload};
pub use slack::SlackChannel;
pub use telegram::TelegramChannel;
pub use whatsapp::WhatsAppChannel;
