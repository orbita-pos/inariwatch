//! Pairing primitive — workspace-scoped, S12-ready.
//!
//! ## What this module owns
//!
//! - **Crockford codes** (8-char, 28-letter alphabet) — the
//!   hand-typeable identifier the user types on a remote messenger
//!   (`/pair ABCDEFGH`).
//! - **6-digit SAS** — the side-channel mismatch defense (Signal-style).
//! - **SQLite-backed lifecycle** — `pending_pairings` (TTL 1h, 3-pending
//!   cap per workspace) + `paired_entities` (long-lived, revocable).
//!
//! ## What this module does NOT own
//!
//! - **Surface-specific delivery** — WhatsApp inbound bridging, the
//!   `/pair` parser, the SAS modal: those live in
//!   [`crate::messenger`] / [`crate::ipc::pairing`] respectively. This
//!   module exposes the contract; consumers wire it.
//! - **Channel-level auth** for Telegram / Slack — those messengers
//!   already authenticate at the workspace level via OAuth, so they
//!   don't go through the pairing primitive at all (`DmPolicy::Open`
//!   in [`crate::messenger`]).
//! - **Network transport** — receiving the `/pair` line is owned by the
//!   sidecar bridge.
//!
//! ## API contract (LOCKED — S12 mobile pairing consumes this)
//!
//! Anything `pub` exported here is part of S12's contract. Adding
//! optional fields with `Default` is OK; reordering, renaming, or
//! removing is NOT — the API is the seam between desktop messenger
//! pairing (S8) and mobile PWA pairing (S12).
//!
//! Types you'll consume:
//!
//! - [`PairingCode`] — Crockford 8-char wrapper.
//! - [`EntityKind`] — `Phone` (S8 WhatsApp) or `Device` (S12 mobile).
//! - [`PendingPairing`] — the `{code, kind, workspace, expiry}` row
//!   surfaced before redemption.
//! - [`PairedEntity`] — the persisted "this identifier is the user"
//!   record after SAS confirmation.
//! - [`SasChallenge`] — opaque handle returned by [`PairingService::redeem`];
//!   pass it back to [`PairingService::confirm_sas`] verbatim.
//! - [`PairingService`] — the orchestrator. Drop-in for both S8 and S12.
//!
//! See [`PairingService`] for the full happy path.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, TimeZone, Utc};
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

pub mod code;
pub mod sas;
pub mod state_machine;
pub mod storage;

#[cfg(test)]
mod tests;

pub use code::{CodeError, PairingCode};
pub use state_machine::{PairingFlowState, RejectReason, SasChallenge, SAS_CHALLENGE_TTL_MS};
pub use storage::{
    EntityKind, PairedEntity, PairingStore, PendingPairing, StorageError, MAX_PENDING_PER_WORKSPACE,
    PENDING_TTL_MS,
};

#[cfg(any(test, feature = "agent-test-utils"))]
pub use storage::test_clock::TestClock;

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum PairingError {
    #[error("storage: {0}")]
    Storage(#[from] StorageError),

    #[error("invalid pairing code: {0}")]
    InvalidCode(#[from] CodeError),

    /// The code is unknown or already consumed.
    #[error("unknown pairing code")]
    NotFound,

    /// The code matched a row but its TTL has elapsed.
    #[error("pairing code expired")]
    Expired,

    /// SAS challenge id is unknown — the in-memory entry was either
    /// never created (expired pending row), or already confirmed/cancelled.
    #[error("unknown SAS challenge")]
    ChallengeNotFound,

    /// SAS challenge was created, but its 5-min cap has elapsed.
    #[error("SAS challenge expired")]
    ChallengeExpired,
}

// ── Initiator ──────────────────────────────────────────────────────────────

/// Who started the pairing flow. Used for the audit trail. Kept open
/// (free-form string) so future callers (workspace admin actions, S12
/// mobile init) don't need a schema change to add a new origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingInitiator(pub String);

impl PairingInitiator {
    pub fn user() -> Self {
        Self("user".to_string())
    }

    pub fn admin() -> Self {
        Self("admin".to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// ── Service ─────────────────────────────────────────────────────────────────

/// Thread-safe pairing orchestrator. Cheap to clone (one
/// [`PairingStore`] clone + one Arc clone of the live-challenges map).
///
/// ## Happy path
///
/// 1. Workspace user clicks "Pair a phone" in Settings →
///    [`generate(EntityKind::Phone, ws)`] → [`PendingPairing`] →
///    desktop UI renders the 8-char code.
/// 2. Workspace user types `/pair ABCDEFGH` from their phone — bot
///    bridge calls [`redeem(&code, &phone, &display_name)`] →
///    [`SasChallenge`] → bot replies with the 6-digit SAS.
/// 3. Desktop UI shows the same SAS — user clicks Yes / No. Frontend
///    calls [`confirm_sas(&challenge, true|false)`]. On `true`, a
///    [`PairedEntity`] row lands; on `false`, no row + the challenge
///    is dropped.
///
/// ## State sharing
///
/// `pending_pairings` is the source of truth between `generate` and
/// `redeem` — the desktop process can restart freely between them
/// (the user retypes `/pair CODE` on the next boot).
///
/// `live_challenges` (in-memory) is the source of truth between
/// `redeem` and `confirm_sas` — if the desktop restarts mid-SAS,
/// the user retypes `/pair CODE` again (which `redeem`s a fresh
/// challenge — costless on a still-live pending row).
#[derive(Clone)]
pub struct PairingService {
    store: PairingStore,
    /// SAS challenges live here between `redeem` and `confirm_sas`.
    /// Locked behind a tokio Mutex because the messenger gateway
    /// services them concurrently.
    live_challenges: Arc<Mutex<HashMap<Uuid, SasChallenge>>>,
}

impl PairingService {
    pub fn new(store: PairingStore) -> Self {
        Self {
            store,
            live_challenges: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Issue a fresh pending code. Errors only on storage failure or
    /// the 3-pending cap being internally inconsistent (which we treat
    /// as an SQL bug, not a user-visible state).
    pub async fn generate(
        &self,
        kind: EntityKind,
        workspace_id: Uuid,
        initiator: &PairingInitiator,
    ) -> Result<PendingPairing, PairingError> {
        let code = PairingCode::random();
        let pending = self
            .store
            .insert_pending(kind, workspace_id, initiator.as_str(), &code)?;
        Ok(pending)
    }

    /// Redeem a code typed by the remote user. On success returns a
    /// [`SasChallenge`] which both:
    ///
    /// - Is registered in [`Self::live_challenges`] keyed by its
    ///   `challenge_id`.
    /// - Carries the 6-digit SAS for the bot to echo back.
    ///
    /// Side effect: the pending row is deleted so the code can't be
    /// double-spent.
    pub async fn redeem(
        &self,
        raw_code: &str,
        identifier: &str,
        display_name: &str,
    ) -> Result<SasChallenge, PairingError> {
        let code = PairingCode::parse(raw_code)?;
        let pending = self
            .store
            .lookup_pending_active(&code)?
            .ok_or(PairingError::NotFound)?;

        // Compute SAS from the *consumed* state. We bind the
        // identifier here too so a swapped-in identifier on the bot
        // side surfaces as a SAS mismatch.
        let sas_digits = sas::derive(&sas::SasInputs {
            pairing_code: code.as_str(),
            identifier,
            workspace_id: &pending.workspace_id.simple().to_string(),
            created_at_ms: pending.created_at_ms,
        });

        // Consume the pending row — no double-spend.
        self.store.delete_pending(pending.id)?;

        // Stamp the challenge "now". Use chrono::Utc so callers can
        // reason in `DateTime<Utc>` regardless of how the storage
        // layer chose to keep its epoch ms.
        let now_ms = self.store.clock().now_ms();
        let now: DateTime<Utc> = Utc
            .timestamp_millis_opt(now_ms)
            .single()
            .unwrap_or_else(Utc::now);

        let challenge = SasChallenge::new(
            Uuid::new_v4(),
            pending,
            identifier.to_string(),
            display_name.to_string(),
            sas_digits,
            now,
        );

        let mut live = self.live_challenges.lock().await;
        live.insert(challenge.challenge_id, challenge.clone());

        Ok(challenge)
    }

    /// Apply the user's Yes/No to a SAS challenge. On `approve = true`
    /// we insert the paired entity and return it. On `approve = false`
    /// we drop the challenge and return `None`.
    ///
    /// `ChallengeNotFound` distinguishes "I never saw that
    /// challenge_id" (almost always means the user double-clicked or
    /// the desktop restarted) from `ChallengeExpired` (challenge was
    /// real but its 5-min cap fired).
    pub async fn confirm_sas(
        &self,
        challenge_id: Uuid,
        approve: bool,
    ) -> Result<Option<PairedEntity>, PairingError> {
        let mut live = self.live_challenges.lock().await;
        let challenge = live.remove(&challenge_id).ok_or(PairingError::ChallengeNotFound)?;
        let now_ms = self.store.clock().now_ms();
        let now = Utc
            .timestamp_millis_opt(now_ms)
            .single()
            .unwrap_or_else(Utc::now);
        if challenge.is_expired_at(now) {
            return Err(PairingError::ChallengeExpired);
        }
        // Drop the lock before the (possibly contended) DB write.
        drop(live);

        if !approve {
            return Ok(None);
        }

        let entity = self.store.insert_paired(
            challenge.kind,
            &challenge.display_name,
            &challenge.identifier,
            challenge.workspace_id,
        )?;
        Ok(Some(entity))
    }

    /// Mark a paired entity as revoked. Idempotent.
    pub async fn revoke(&self, entity_id: Uuid) -> Result<(), PairingError> {
        self.store.revoke(entity_id)?;
        Ok(())
    }

    /// List active paired entities for a workspace, newest first.
    pub async fn list(&self, workspace_id: Uuid) -> Result<Vec<PairedEntity>, PairingError> {
        Ok(self.store.list_active(workspace_id)?)
    }

    /// Look up an active paired entity by `(workspace, kind,
    /// identifier)`. The hot path used by the messenger gateway on
    /// every inbound DM. `Ok(None)` ⇒ unknown identifier OR explicitly
    /// revoked.
    pub async fn lookup_active(
        &self,
        workspace_id: Uuid,
        kind: EntityKind,
        identifier: &str,
    ) -> Result<Option<PairedEntity>, PairingError> {
        Ok(self.store.lookup_paired_active(workspace_id, kind, identifier)?)
    }

    /// Best-effort `last_seen_at_ms` bump.
    pub async fn touch_last_seen(&self, entity_id: Uuid) -> Result<(), PairingError> {
        self.store.touch_last_seen(entity_id)?;
        Ok(())
    }

    /// Sweep expired pending rows + drop stale in-memory SAS
    /// challenges. Returns total dropped (pending + challenges).
    pub async fn cleanup_expired(&self) -> Result<usize, PairingError> {
        let mut total = self.store.cleanup_expired()?;
        let now_ms = self.store.clock().now_ms();
        let now = Utc
            .timestamp_millis_opt(now_ms)
            .single()
            .unwrap_or_else(Utc::now);
        let mut live = self.live_challenges.lock().await;
        let before = live.len();
        live.retain(|_, ch| !ch.is_expired_at(now));
        total += before - live.len();
        Ok(total)
    }

    /// Test-only: introspect the live-challenge cache size. NOT public
    /// API — exposed via `cfg(test)` to keep the trait surface clean.
    #[cfg(test)]
    pub(crate) async fn live_challenge_count(&self) -> usize {
        self.live_challenges.lock().await.len()
    }
}
