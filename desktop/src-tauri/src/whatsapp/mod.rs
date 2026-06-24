//! v0.3 S5 — Baileys WhatsApp sidecar control surface.
//!
//! Inari Live spawns a Node child process at boot (`sidecars/whatsapp/dist/
//! main.js` — uses `@whiskeysockets/baileys` to maintain a long-lived,
//! QR-paired session against the user's PERSONAL WhatsApp account).
//! Communication is JSON-RPC 2.0 over stdin/stdout.
//!
//! ## Why Baileys (and not Meta Cloud API / Twilio)
//!
//! Per the v0.3 S5 brief (Baileys rewrite, 2026-05-02), the prior
//! approach using Meta WhatsApp Business Cloud API + Twilio fallback was
//! REJECTED. Reasons:
//!   - Meta WABA requires business verification (1-3 weeks) + per-message
//!     fees + template-message approval gates.
//!   - Twilio sandbox needs a paid account + still costs per message.
//!   - Both send FROM a vendor number, never the user's own.
//!
//! Baileys (model: OpenClaw, MIT) connects DIRECTLY to WhatsApp's
//! WebSocket protocol (the same one the official mobile app uses) using
//! a session paired via QR code on the user's box. Zero paperwork,
//! zero per-message cost, and alerts arrive FROM the user's OWN
//! WhatsApp number — which is what users want anyway.
//!
//! TOS gray area: Meta MAY ban accounts that misbehave (high-volume
//! messaging, spam-shaped traffic). Mitigation lives in `send.ts` on the
//! sidecar side: per-recipient rate limits, "natural" message cadence,
//! no marketing-template payloads.
//!
//! ## Surfaces this module powers
//!
//! - **IPC commands** (`crate::ipc::whatsapp`): `whatsapp_login_start`,
//!   `whatsapp_send`, `whatsapp_logout`, `whatsapp_list_accounts`,
//!   `whatsapp_status`.
//! - **Relay dispatch** (`crate::relay_client`): the
//!   `notify.compose.whatsapp` task composes a body locally and (when a
//!   linked account is available) hands it to [`SidecarManager::send_message`].
//! - **Tauri events**: `whatsapp:qr-update`, `whatsapp:linked`,
//!   `whatsapp:logged-out`, `whatsapp:connection-state-changed`.
//!
//! ## What this module does NOT do
//!
//! - It does not own the QR-rendering UI — that's `desktop/src/components/
//!   WhatsappSetup.tsx`.
//! - It does not own JID format conversion — the sidecar's `send.ts`
//!   maps incoming E.164 phones to `<digits>@s.whatsapp.net`.
//! - It does not persist credentials — the sidecar writes auth state to
//!   `<app_local_data_dir>/whatsapp/<account_id>/` (creds.json + .bak).
//! - It does not embed a Node runtime — production builds bundle one via
//!   Tauri's resource pipeline (future session). Today, the dev path
//!   shells out to a system `node`.

pub mod sidecar;
pub mod types;

pub use sidecar::{SidecarError, SidecarManager};
pub use types::{
    AccountInfo, ConnectionStatus, QrUpdate, SendMessageRequest,
    SendMessageResponse, WhatsAppEvent,
};

#[cfg(test)]
mod tests;
