//! WhatsApp Channel adapter.
//!
//! Wraps the existing [`crate::whatsapp::SidecarManager`] (S5) for
//! outbound and bridges its inbound `messages.upsert` events (S8 Node-
//! sidecar extension) into the gateway's `InboundMessage` shape.
//!
//! Outbound goes through `comm.send_whatsapp` via
//! `ToolRegistry::invoke_traced` — we adapt, never duplicate.

pub mod adapter;
pub mod inbound;
pub mod sidecar_bridge;

pub use adapter::WhatsAppChannel;
