//! Lifecycle state for a single pairing flow.
//!
//! ```text
//!   Pending ──redeem──▶ SasShown ──confirm_sas(approve)──▶ Confirmed
//!      │                   │
//!      │                   ├──confirm_sas(reject)─────────▶ Rejected
//!      │                   │
//!      │                   └──ttl elapsed────────────────▶ Expired
//!      │
//!      └──ttl elapsed────────────────────────────────────▶ Expired
//! ```
//!
//! - **Pending** — DB row in `pending_pairings`, code visible in the
//!   desktop UI, waiting for the remote user to type `/pair CODE`.
//! - **SasShown** — `redeem` consumed the code; the bot has the 6-digit
//!   SAS and replied with it. The challenge lives in memory in the
//!   service's `live_challenges` map until `confirm_sas` lands or the
//!   5-min cap fires.
//! - **Confirmed** — `paired_entities` row inserted; the messenger
//!   gateway lets messages from this identifier through.
//! - **Expired** / **Rejected** — terminal failure states. The bot
//!   replies with a friendly message; no row in `paired_entities`.
//!
//! Why not a state-machine crate: Inari Live's transitions are a
//! handful of methods on the [`super::PairingService`]. A dedicated
//! crate (typestate, finite-state, …) would be overkill for what's
//! effectively a 3-edge graph.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use super::code::PairingCode;
use super::sas::SAS_LEN;
use super::storage::{EntityKind, PairedEntity, PendingPairing};

/// Cap on the in-memory SAS challenge. After this, confirm_sas with the
/// challenge id is `ChallengeNotFound`. Documented because users with
/// an open pairing flow expect to compare digits within ~30s; 5 min is
/// the slack budget for "I scrolled the chat back, where was that
/// code?".
pub const SAS_CHALLENGE_TTL_MS: i64 = 5 * 60 * 1000;

/// Live SAS challenge the messenger has surfaced via reply. The desktop
/// UI displays the same digits; the user picks Yes/No after visually
/// comparing.
///
/// Carries everything `confirm_sas` needs WITHOUT a DB hit on the SAS
/// side — the pending-pairing row is consumed by `redeem`, so we lift
/// its state into memory here. If the desktop process restarts during a
/// pairing flow, the user just retypes `/pair CODE` (the code's still
/// valid in `pending_pairings` until TTL expires).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SasChallenge {
    pub challenge_id: Uuid,
    /// Original Crockford code (already consumed/deleted from
    /// `pending_pairings` by `redeem`). Kept here so the SAS derivation
    /// is reproducible.
    pub code: PairingCode,
    pub identifier: String,
    pub display_name: String,
    pub kind: EntityKind,
    pub workspace_id: Uuid,
    /// 6-digit SAS displayed to user + emitted to bot. Always exactly
    /// [`SAS_LEN`] bytes.
    pub sas_digits: String,
    pub created_at: DateTime<Utc>,
    /// Hard cap; after this, [`confirm_sas`](super::PairingService::confirm_sas)
    /// fails with `ChallengeExpired` regardless of approval.
    pub expires_at: DateTime<Utc>,
}

impl SasChallenge {
    pub fn new(
        challenge_id: Uuid,
        consumed: PendingPairing,
        identifier: String,
        display_name: String,
        sas_digits: String,
        now: DateTime<Utc>,
    ) -> Self {
        debug_assert_eq!(
            sas_digits.len(),
            SAS_LEN,
            "SAS must be exactly {SAS_LEN} digits"
        );
        Self {
            challenge_id,
            code: consumed.code,
            identifier,
            display_name,
            kind: consumed.kind,
            workspace_id: consumed.workspace_id,
            sas_digits,
            created_at: now,
            expires_at: now + chrono::Duration::milliseconds(SAS_CHALLENGE_TTL_MS),
        }
    }

    pub fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }
}

/// High-level flow state. Surfaced for telemetry / UI labels; the
/// service doesn't hold this enum (it operates on rows + challenges
/// directly), but tests and the audit emitter use it to describe what
/// happened in a single token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingFlowState {
    /// Code issued, awaiting `/pair`.
    Pending(PendingPairing),
    /// Code consumed, SAS shown, awaiting user yes/no.
    SasShown(SasChallenge),
    /// Confirmed; row in `paired_entities`.
    Confirmed(PairedEntity),
    /// User said no, OR challenge expired without confirmation.
    Rejected { reason: RejectReason },
    /// Pending row TTL fired before redeem.
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectReason {
    UserDeclined,
    ChallengeExpired,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_fixture() -> PendingPairing {
        PendingPairing {
            id: Uuid::nil(),
            code: PairingCode::from_canonical("ABCDEFGH".to_string()),
            kind: EntityKind::Phone,
            workspace_id: Uuid::nil(),
            initiator: "user".to_string(),
            created_at_ms: 0,
            expires_at_ms: 0,
        }
    }

    #[test]
    fn sas_challenge_carries_consumed_pending_state() {
        let now = Utc::now();
        let chal = SasChallenge::new(
            Uuid::new_v4(),
            pending_fixture(),
            "+5215551234567".to_string(),
            "Test Phone".to_string(),
            "482619".to_string(),
            now,
        );
        assert_eq!(chal.identifier, "+5215551234567");
        assert_eq!(chal.display_name, "Test Phone");
        assert_eq!(chal.sas_digits, "482619");
        assert_eq!(chal.kind, EntityKind::Phone);
        assert_eq!(chal.created_at, now);
        assert_eq!(
            chal.expires_at,
            now + chrono::Duration::milliseconds(SAS_CHALLENGE_TTL_MS)
        );
    }

    #[test]
    fn challenge_expires_after_ttl() {
        let now = Utc::now();
        let chal = SasChallenge::new(
            Uuid::new_v4(),
            pending_fixture(),
            "id".to_string(),
            "name".to_string(),
            "000000".to_string(),
            now,
        );
        assert!(!chal.is_expired_at(now));
        assert!(!chal.is_expired_at(
            now + chrono::Duration::milliseconds(SAS_CHALLENGE_TTL_MS - 1)
        ));
        assert!(chal.is_expired_at(now + chrono::Duration::milliseconds(SAS_CHALLENGE_TTL_MS)));
    }
}
