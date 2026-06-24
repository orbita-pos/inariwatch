//! Telegram channel — read-only mirror for S8.
//!
//! The web bot at `web/app/api/telegram/webhook/route.ts` already runs
//! the full bidirectional AI loop. S8 desktop-side mirrors threads in
//! the dock with attribution chips so the user sees their phone
//! conversations alongside the local dock chat. The desktop AI loop is
//! NOT wired for Telegram in S8 — that's S8.5.
//!
//! The mirror feed flows in via the existing relay:
//! `web/app/api/desktop/telegram/...` (server) emits a relay
//! `messenger.mirror.tg-conversation` task, the desktop's
//! `relay_client::handle_dispatch` forwards it to a `broadcast::Sender`
//! the inbound stream subscribes to. This module owns the subscriber
//! side; the relay-dispatch wiring is in
//! [`crate::messenger::telegram::inbound`].
//!
//! Outbound: when the user types in the dock for a Telegram-attributed
//! thread, the chat surface routes through `comm.send_telegram` (S5)
//! via `ToolRegistry::invoke_traced` — that path already exists and
//! is reused without modification.

pub mod adapter;
pub mod inbound;

pub use adapter::TelegramChannel;
