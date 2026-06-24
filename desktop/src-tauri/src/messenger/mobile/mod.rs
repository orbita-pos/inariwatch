//! S12 — Mobile PWA Channel adapter.
//!
//! The mobile chat-agent (PWA at `web/app/mobile/`) talks to the web
//! API directly — the AI loop runs server-side in
//! `web/lib/services/chat.service.ts`, NOT here. So this Channel impl
//! is mostly a placeholder for the messenger Gateway's
//! `ChannelKind::MobileDevice` slot — its inbound stream is empty
//! (no DMs ever arrive on this channel from the user's mobile;
//! everything goes through the web), and its outbound `send` writes
//! a web-push notification via the relay (deferred to S12.5 — for
//! S12 itself the `send` returns `Offline` so the gateway falls back
//! to a friendly "open the mobile app" error).
//!
//! What this module DOES own:
//!
//! - The relay listener that receives `pair:sas-shown` events and
//!   routes them into the messenger event bus as
//!   [`MessengerEvent::SasPending`] for the desktop frontend's
//!   SasConfirmModal.
//! - The IPC commands (in `crate::ipc::mobile_pairing`) that the
//!   frontend Settings → Channels → Mobile section calls to start +
//!   confirm a pairing.

pub mod adapter;
pub mod inbound;

pub use adapter::MobileChannel;
pub use inbound::{handle_relay_pair_event, MobileSasShownPayload};
