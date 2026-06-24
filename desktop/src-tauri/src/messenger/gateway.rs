//! Gateway: fan inbound from N channels through one dispatch loop.
//!
//! Per inbound DM the gateway:
//!
//! 1. Look up the `(channel, identifier)` in [`crate::pairing::PairingService`].
//!    - If unpaired AND the channel uses `DmPolicy::Pairing`:
//!      - If text starts with `/pair CODE`: handoff to pairing flow
//!        (calls `redeem` + emits SAS-pending event + replies with the
//!        SAS digits).
//!      - Else: reply "please pair first" + drop the message.
//!    - If unpaired AND the channel uses `DmPolicy::Open`: synthesise
//!      an in-memory `PairedEntity` so attribution still works (the
//!      channel itself is workspace-authenticated; we don't need a
//!      SQLite row).
//!    - If paired: continue.
//! 2. Look for `/confirm <id>` or `/cancel <id>`: resume the pending
//!    tool flow (or drop it).
//! 3. Otherwise: run [`super::ai_loop::run_turn`].
//!
//! The gateway holds a per-entity tokio Mutex so two simultaneous
//! inbound messages from the same paired user serialize — no two
//! `invoke_traced` calls compete for the same `session_id`.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::agent::ToolRegistry;
use crate::pairing::{
    EntityKind, PairedEntity, PairingError, PairingService,
};

use super::ai_loop::{run_confirmation, run_turn, AiDispatch, LoopOutcome};
use super::attribution::{redact_identifier, ChannelAttribution};
use super::channel::{
    Channel, ChannelError, ChannelKind, DmPolicy, InboundMessage, OutboundMessage,
};
use super::events::MessengerEvent;

// ── Pending tool-call tracking ──────────────────────────────────────────────

/// In-memory store of "tool call awaiting `/confirm`". Keyed by
/// `tool_call_id` so the gateway resolves the next inbound `/confirm
/// <id>` to the right pending request without scanning.
///
/// Bounded — drop the oldest after this many. A user with 64 pending
/// confirms is in some kind of weird loop; we'd rather GC than OOM.
const MAX_PENDING_CONFIRMS: usize = 64;

#[derive(Debug, Clone)]
struct PendingConfirm {
    tool_name: String,
    args: Value,
    attribution: ChannelAttribution,
    session_id: String,
    to_identifier: String,
}

#[derive(Default)]
struct PendingConfirms {
    map: HashMap<String, PendingConfirm>,
    /// FIFO of insertion order for capped eviction. Cheap O(1)
    /// `push_back` + amortized `pop_front` — `VecDeque` would be the
    /// idiomatic choice but `Vec` is fine at N≤64.
    order: Vec<String>,
}

impl PendingConfirms {
    fn insert(&mut self, id: String, p: PendingConfirm) {
        if self.map.len() >= MAX_PENDING_CONFIRMS {
            if let Some(oldest) = self.order.first().cloned() {
                self.order.remove(0);
                self.map.remove(&oldest);
            }
        }
        self.order.push(id.clone());
        self.map.insert(id, p);
    }

    fn take(&mut self, id: &str) -> Option<PendingConfirm> {
        let value = self.map.remove(id)?;
        if let Some(pos) = self.order.iter().position(|k| k == id) {
            self.order.remove(pos);
        }
        Some(value)
    }
}

// ── Per-entity locks ────────────────────────────────────────────────────────

/// Per-paired-entity serialization. Two simultaneous inbound DMs from
/// the same phone go through this mutex one at a time. Cheap — at most
/// "active conversations" entries and we don't garbage-collect because
/// they're small.
type EntityLocks = Arc<Mutex<HashMap<Uuid, Arc<Mutex<()>>>>>;

async fn acquire_entity_lock(locks: &EntityLocks, entity_id: Uuid) -> Arc<Mutex<()>> {
    let mut guard = locks.lock().await;
    if let Some(m) = guard.get(&entity_id) {
        return m.clone();
    }
    let m = Arc::new(Mutex::new(()));
    guard.insert(entity_id, m.clone());
    m
}

// ── Gateway ─────────────────────────────────────────────────────────────────

/// One gateway per app boot. Cheap to clone — internal state is
/// `Arc`-wrapped.
#[derive(Clone)]
pub struct Gateway {
    pairing: Arc<PairingService>,
    registry: Arc<ToolRegistry>,
    ai: Arc<dyn AiDispatch>,
    bus: broadcast::Sender<MessengerEvent>,
    workspace_id: Uuid,
    pending_confirms: Arc<Mutex<PendingConfirms>>,
    entity_locks: EntityLocks,
}

impl Gateway {
    pub fn new(
        pairing: Arc<PairingService>,
        registry: Arc<ToolRegistry>,
        ai: Arc<dyn AiDispatch>,
        bus: broadcast::Sender<MessengerEvent>,
        workspace_id: Uuid,
    ) -> Self {
        Self {
            pairing,
            registry,
            ai,
            bus,
            workspace_id,
            pending_confirms: Arc::new(Mutex::new(PendingConfirms::default())),
            entity_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn bus(&self) -> broadcast::Sender<MessengerEvent> {
        self.bus.clone()
    }

    /// Dispatch a single inbound message. Synchronous from the caller's
    /// POV but the per-entity mutex inside means two concurrent calls
    /// for the same identifier serialise. Returns `Ok(())` even on most
    /// surface-visible errors (invalid pair codes, unknown identifiers)
    /// — those are reported back to the user via the channel's reply,
    /// not as a Rust error to the caller. The Result is reserved for
    /// transport/registry failures the gateway doesn't know how to
    /// recover from.
    pub async fn dispatch(
        &self,
        channel: Arc<dyn Channel>,
        inbound: InboundMessage,
    ) -> Result<(), ChannelError> {
        let kind = channel.kind();
        debug_assert_eq!(kind, inbound.channel, "channel kind / inbound mismatch");

        // ── 1. Pair lookup or DmPolicy::Open synthetic ────────────────────
        let entity_kind = match kind {
            ChannelKind::WhatsApp => EntityKind::Phone,
            ChannelKind::Telegram | ChannelKind::Slack => {
                // Open channels don't use the pairing primitive; we
                // still need a stable pseudo-id for per-entity locking.
                // Re-use the EntityKind::Device variant (it's the
                // closest match — "an authenticated thing that isn't a
                // human-typed phone").
                EntityKind::Device
            }
            // S12 — mobile pairing uses EntityKind::Device, same primitive.
            ChannelKind::MobileDevice => EntityKind::Device,
        };

        let paired = match channel.dm_policy() {
            DmPolicy::Pairing => {
                self.handle_pairing_inbound(&channel, &inbound, entity_kind).await
            }
            DmPolicy::Open => Ok(Some(self.synthesise_open_entity(&inbound, entity_kind))),
            DmPolicy::Custom => {
                tracing::warn!(
                    channel = ?kind,
                    "DmPolicy::Custom is not implemented — dropping inbound"
                );
                Ok(None)
            }
        }?;

        let paired = match paired {
            Some(p) => p,
            None => return Ok(()),
        };

        // ── 2. Per-entity serialization ──────────────────────────────────
        let entity_lock = acquire_entity_lock(&self.entity_locks, paired.id).await;
        let _entity_guard = entity_lock.lock().await;

        let session_id = format!(
            "messenger:{}:{}",
            kind.session_prefix(),
            paired.id.simple()
        );
        let attribution = ChannelAttribution {
            channel: kind,
            paired_id: paired.id,
            redacted_identifier: redact_identifier(kind, &paired.identifier),
            display_name: paired.display_name.clone(),
        };

        // Best-effort last_seen bump (paired entities only).
        let _ = self.pairing.touch_last_seen(paired.id).await;

        // ── 3. Confirm / Cancel resume ───────────────────────────────────
        if let Some(callback) = parse_callback(&inbound.text) {
            return self
                .resume_callback(
                    channel.as_ref(),
                    callback,
                    &attribution,
                    &session_id,
                    &paired.identifier,
                )
                .await;
        }

        // ── 4. Run the AI loop ───────────────────────────────────────────
        let outcome = run_turn(
            channel.as_ref(),
            &self.registry,
            self.ai.as_ref(),
            &self.bus,
            &attribution,
            &inbound.text,
            &session_id,
            &paired.identifier,
        )
        .await?;

        // Track pending confirms so the next inbound `/confirm <id>`
        // resumes the right call.
        if let LoopOutcome::ToolPendingConfirm {
            tool_call_id,
            tool_name,
            args,
            ..
        } = outcome
        {
            let mut pending = self.pending_confirms.lock().await;
            pending.insert(
                tool_call_id,
                PendingConfirm {
                    tool_name,
                    args,
                    attribution,
                    session_id,
                    to_identifier: paired.identifier.clone(),
                },
            );
        }

        Ok(())
    }

    // ── Pairing-policy inbound ──────────────────────────────────────────────
    //
    // Unpaired inbound on a Pairing channel: parse `/pair CODE`, redeem
    // it, emit SAS-pending; otherwise reject with a friendly message.
    async fn handle_pairing_inbound(
        &self,
        channel: &Arc<dyn Channel>,
        inbound: &InboundMessage,
        entity_kind: EntityKind,
    ) -> Result<Option<PairedEntity>, ChannelError> {
        // Already paired? Continue.
        let active = self
            .pairing
            .lookup_active(self.workspace_id, entity_kind, &inbound.from_identifier)
            .await
            .map_err(|e| ChannelError::Tool(e.to_string()))?;
        if let Some(entity) = active {
            return Ok(Some(entity));
        }

        let kind = channel.kind();
        if let Some(code) = parse_pair_command(&inbound.text) {
            let display_name =
                if inbound.display_name.trim().is_empty() {
                    inbound.from_identifier.clone()
                } else {
                    inbound.display_name.clone()
                };
            match self
                .pairing
                .redeem(&code, &inbound.from_identifier, &display_name)
                .await
            {
                Ok(challenge) => {
                    let reply = format!(
                        "Compare these digits with the desktop: {}\n\nIf they match, click Yes on the desktop. They expire in 5 minutes.",
                        challenge.sas_digits
                    );
                    channel
                        .send(
                            &inbound.from_identifier,
                            &OutboundMessage {
                                text: reply,
                                buttons: Vec::new(),
                                thread_id: None,
                            },
                            &format!("pairing:{}:{}", kind.session_prefix(), challenge.challenge_id.simple()),
                        )
                        .await?;
                    let _ = self.bus.send(MessengerEvent::SasPending {
                        challenge_id: challenge.challenge_id,
                        channel: kind,
                        identifier_redacted: redact_identifier(kind, &inbound.from_identifier),
                        display_name: challenge.display_name.clone(),
                        sas_digits: challenge.sas_digits.clone(),
                    });
                }
                Err(PairingError::NotFound) => {
                    channel
                        .send(
                            &inbound.from_identifier,
                            &OutboundMessage {
                                text: "That pairing code isn't recognised. Open Inari Live → Settings → Channels and generate a fresh one.".to_string(),
                                buttons: Vec::new(),
                                thread_id: None,
                            },
                            "pairing:reject",
                        )
                        .await?;
                }
                Err(PairingError::InvalidCode(e)) => {
                    channel
                        .send(
                            &inbound.from_identifier,
                            &OutboundMessage {
                                text: format!("That pairing code is malformed: {e}. Codes are 8 characters from the Crockford alphabet (no 0/O/1/I/L/U)."),
                                buttons: Vec::new(),
                                thread_id: None,
                            },
                            "pairing:reject",
                        )
                        .await?;
                }
                Err(other) => {
                    tracing::warn!(error = %other, "[messenger] pairing redeem failed");
                    channel
                        .send(
                            &inbound.from_identifier,
                            &OutboundMessage {
                                text: "Something went wrong while pairing. Please try again — if it keeps failing, open Inari Live and check Settings → Channels.".to_string(),
                                buttons: Vec::new(),
                                thread_id: None,
                            },
                            "pairing:reject",
                        )
                        .await?;
                }
            }
            return Ok(None);
        }

        // Unpaired + not a /pair command → reject with friendly message.
        channel
            .send(
                &inbound.from_identifier,
                &OutboundMessage {
                    text: "I don't recognise this number yet. To connect: open Inari Live → Settings → Channels → WhatsApp → Pair, then reply with `/pair CODE`.".to_string(),
                    buttons: Vec::new(),
                    thread_id: None,
                },
                "pairing:unauthorised",
            )
            .await?;
        let _ = self.bus.send(MessengerEvent::UnpairedRejected {
            channel: kind,
            identifier_redacted: redact_identifier(kind, &inbound.from_identifier),
            text_preview: inbound.text.chars().take(80).collect(),
        });
        Ok(None)
    }

    fn synthesise_open_entity(
        &self,
        inbound: &InboundMessage,
        entity_kind: EntityKind,
    ) -> PairedEntity {
        // Deterministic UUID derived from `(channel, identifier)` so
        // two messages from the same Slack user lock the same per-entity
        // mutex. We use UUIDv5 with the workspace id as the namespace.
        let ns = uuid::Uuid::from_u128_le(self.workspace_id.as_u128());
        let seed = format!("{}|{}", inbound.channel.as_str(), inbound.from_identifier);
        let id = uuid::Uuid::new_v5(&ns, seed.as_bytes());
        PairedEntity {
            id,
            kind: entity_kind,
            display_name: if inbound.display_name.is_empty() {
                inbound.from_identifier.clone()
            } else {
                inbound.display_name.clone()
            },
            identifier: inbound.from_identifier.clone(),
            workspace_id: self.workspace_id,
            paired_at_ms: 0,
            last_seen_at_ms: 0,
            revoked_at_ms: None,
        }
    }

    // ── Confirm / Cancel resume ─────────────────────────────────────────────
    async fn resume_callback(
        &self,
        channel: &dyn Channel,
        callback: CallbackKind,
        attribution: &ChannelAttribution,
        session_id: &str,
        to_identifier: &str,
    ) -> Result<(), ChannelError> {
        let id = callback.id();
        let pending = {
            let mut guard = self.pending_confirms.lock().await;
            guard.take(id)
        };
        let pending = match pending {
            Some(p) => p,
            None => {
                channel
                    .send(
                        to_identifier,
                        &OutboundMessage {
                            text: format!(
                                "I don't have a pending action with id `{id}`. It may have already been resolved or expired."
                            ),
                            buttons: Vec::new(),
                            thread_id: None,
                        },
                        session_id,
                    )
                    .await?;
                return Ok(());
            }
        };

        // Bus events for the resume path attribute to the ORIGINAL
        // tool call's audit-log session, not the current user's
        // session_id. The dock mirror keys on `attribution.paired_id`
        // so two different paired users couldn't accidentally see each
        // other's `/confirm` resolutions.
        let original_attribution = pending.attribution.clone();
        match callback {
            CallbackKind::Confirm(_) => {
                let _ = run_confirmation(
                    channel,
                    &self.registry,
                    &self.bus,
                    &original_attribution,
                    &pending.tool_name,
                    pending.args,
                    id,
                    &pending.session_id,
                    &pending.to_identifier,
                )
                .await?;
                // Suppress unused-variable warning when no other
                // arm reads the user's current attribution; we
                // explicitly mark it consulted via the debug log.
                tracing::debug!(
                    user_paired_id = %attribution.paired_id,
                    original_paired_id = %original_attribution.paired_id,
                    "[messenger] /confirm resumed"
                );
            }
            CallbackKind::Cancel(_) => {
                channel
                    .send(
                        to_identifier,
                        &OutboundMessage {
                            text: format!("Cancelled `{}`. Nothing was run.", pending.tool_name),
                            buttons: Vec::new(),
                            thread_id: None,
                        },
                        session_id,
                    )
                    .await?;
                let _ = self.bus.send(MessengerEvent::TurnComplete {
                    attribution: original_attribution,
                    session_id: pending.session_id,
                });
            }
        }
        Ok(())
    }
}

// ── Inbound text parsing ────────────────────────────────────────────────────

/// Parse a leading `/pair CODE` out of `text`. Returns the raw code
/// (un-validated; the pairing service is the canonical validator).
fn parse_pair_command(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    let prefix = "/pair ";
    if !lower.starts_with(prefix) {
        return None;
    }
    let rest = trimmed[prefix.len()..].trim();
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CallbackKind {
    Confirm(String),
    Cancel(String),
}

impl CallbackKind {
    fn id(&self) -> &str {
        match self {
            CallbackKind::Confirm(s) | CallbackKind::Cancel(s) => s,
        }
    }
}

fn parse_callback(text: &str) -> Option<CallbackKind> {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("/confirm ") {
        return Some(CallbackKind::Confirm(rest.trim().to_string()));
    }
    if let Some(rest) = lower.strip_prefix("/cancel ") {
        return Some(CallbackKind::Cancel(rest.trim().to_string()));
    }
    // Allow bare `/confirm` / `/cancel` only when there's a single
    // pending — this is a follow-up affordance for users who can't tap
    // a callback button. We keep parsing strict: id is required so the
    // gateway never resolves to the wrong call.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pair_extracts_code_after_slash_pair() {
        assert_eq!(parse_pair_command("/pair ABCDEFGH").as_deref(), Some("ABCDEFGH"));
        assert_eq!(
            parse_pair_command("  /pair ABCD-EFGH  ").as_deref(),
            Some("ABCD-EFGH")
        );
        // Case-insensitive on the prefix.
        assert_eq!(parse_pair_command("/PAIR abcdefgh").as_deref(), Some("abcdefgh"));
    }

    #[test]
    fn parse_pair_returns_none_without_prefix() {
        assert!(parse_pair_command("hello world").is_none());
        assert!(parse_pair_command("pair ABCDEFGH").is_none());
    }

    #[test]
    fn parse_pair_returns_none_for_bare_pair() {
        assert!(parse_pair_command("/pair").is_none());
        assert!(parse_pair_command("/pair  ").is_none());
    }

    #[test]
    fn parse_callback_extracts_confirm_id() {
        let cb = parse_callback("/confirm abc-123").expect("must parse");
        assert_eq!(cb, CallbackKind::Confirm("abc-123".into()));
    }

    #[test]
    fn parse_callback_extracts_cancel_id() {
        let cb = parse_callback("/cancel abc-123").expect("must parse");
        assert_eq!(cb, CallbackKind::Cancel("abc-123".into()));
    }

    #[test]
    fn parse_callback_none_for_bare_confirm() {
        assert!(parse_callback("/confirm").is_none());
    }
}
