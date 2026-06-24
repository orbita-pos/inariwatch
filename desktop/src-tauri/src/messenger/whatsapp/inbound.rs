//! WhatsApp inbound facade.
//!
//! The actual `messages.upsert` → `InboundMessage` bridge lives in
//! [`super::sidecar_bridge`]. This module exists to keep the public
//! shape consistent across channels (`telegram::inbound`, `slack::inbound`
//! also expose a single `subscribe` function).

pub use super::sidecar_bridge::{jid_to_e164, subscribe_inbound};

#[cfg(any(test, feature = "agent-test-utils"))]
pub use super::sidecar_bridge::test_stream;
