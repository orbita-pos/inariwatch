//! S8 — pairing IPC contract tests.
//!
//! The IPC commands themselves take `tauri::State` arguments which need
//! a live Tauri runtime to drive. These tests exercise the underlying
//! `PairingService` paths the IPC commands wrap, so we can assert the
//! contract (Crockford code shape, list filtering, revoke idempotency,
//! workspace scoping) without spinning up Tauri. The thin command
//! shells are covered by the unit tests in `pairing::tests`.
//!
//! Required-features: `agent-test-utils` for the `TestClock` re-export.

use std::sync::Arc;

use r2d2_sqlite::SqliteConnectionManager;
use uuid::Uuid;

use inariwatch_desktop_lib::pairing::{
    EntityKind, PairingInitiator, PairingService, PairingStore, TestClock, MAX_PENDING_PER_WORKSPACE,
};

fn pool() -> inariwatch_desktop_lib::store::SqlitePool {
    let manager = SqliteConnectionManager::memory();
    r2d2::Pool::builder().max_size(1).build(manager).unwrap()
}

fn rig() -> (Arc<PairingService>, Arc<TestClock>) {
    let clock = Arc::new(TestClock::new(1_700_000_000_000));
    let store = PairingStore::with_clock(pool(), clock.clone());
    store.ensure_schema().unwrap();
    (Arc::new(PairingService::new(store)), clock)
}

#[tokio::test]
async fn ipc_generate_returns_valid_crockford_code() {
    let (svc, _clock) = rig();
    let ws = Uuid::new_v4();

    let pending = svc
        .generate(EntityKind::Phone, ws, &PairingInitiator::user())
        .await
        .expect("generate");

    // Code is 8 chars, only Crockford alphabet (no 0/O/1/I/L/U).
    let code = pending.code.as_str();
    assert_eq!(code.len(), 8);
    for c in code.chars() {
        assert!(c.is_ascii_alphanumeric());
        assert!(!matches!(c, '0' | 'O' | '1' | 'I' | 'L' | 'U'));
    }

    // Chunked form is `XXXX-XXXX`.
    let chunked = pending.code.chunked();
    assert_eq!(chunked.len(), 9);
    assert_eq!(&chunked[4..5], "-");
}

#[tokio::test]
async fn ipc_list_filters_by_workspace_and_omits_revoked() {
    let (svc, _clock) = rig();
    let ws_a = Uuid::new_v4();
    let ws_b = Uuid::new_v4();

    async fn pair_one(
        svc: &PairingService,
        ws: Uuid,
        ident: &str,
        label: &str,
    ) -> uuid::Uuid {
        let p = svc
            .generate(EntityKind::Phone, ws, &PairingInitiator::user())
            .await
            .unwrap();
        let c = svc.redeem(p.code.as_str(), ident, label).await.unwrap();
        let entity = svc
            .confirm_sas(c.challenge_id, true)
            .await
            .unwrap()
            .unwrap();
        entity.id
    }

    let a1 = pair_one(&svc, ws_a, "+1", "A1").await;
    let _a2 = pair_one(&svc, ws_a, "+2", "A2").await;
    let _b1 = pair_one(&svc, ws_b, "+3", "B1").await;
    svc.revoke(a1).await.unwrap();

    let listed_a = svc.list(ws_a).await.unwrap();
    assert_eq!(listed_a.len(), 1, "ws_a active = a2 only after revoke");
    let listed_b = svc.list(ws_b).await.unwrap();
    assert_eq!(listed_b.len(), 1, "ws_b active = b1");
}

#[tokio::test]
async fn ipc_revoke_is_idempotent_and_silent_on_missing_id() {
    let (svc, _clock) = rig();
    // Revoking a UUID that was never paired must not error — the IPC
    // returns `()` regardless. Frontend can call from a stale UI
    // without surfacing a "not found" toast.
    svc.revoke(Uuid::new_v4()).await.expect("idempotent revoke");
}

#[tokio::test]
async fn ipc_confirm_round_trip_returns_paired_entity_dto_payload() {
    let (svc, _clock) = rig();
    let ws = Uuid::new_v4();
    let pending = svc
        .generate(EntityKind::Phone, ws, &PairingInitiator::user())
        .await
        .unwrap();
    let challenge = svc
        .redeem(pending.code.as_str(), "+5215551234567", "Jesus Phone")
        .await
        .unwrap();
    let entity = svc
        .confirm_sas(challenge.challenge_id, true)
        .await
        .unwrap()
        .expect("yes returns entity");
    assert_eq!(entity.identifier, "+5215551234567");
    assert_eq!(entity.display_name, "Jesus Phone");
    assert_eq!(entity.kind, EntityKind::Phone);
    assert!(entity.revoked_at_ms.is_none());
}

#[tokio::test]
async fn ipc_pending_cap_holds_at_max_pending_per_workspace_across_generates() {
    let (svc, clock) = rig();
    let ws = Uuid::new_v4();
    // Generate cap+1 to exercise the eviction.
    let mut codes = Vec::new();
    for _ in 0..(MAX_PENDING_PER_WORKSPACE + 1) {
        let p = svc
            .generate(EntityKind::Phone, ws, &PairingInitiator::user())
            .await
            .unwrap();
        codes.push(p.code);
        // Bump the clock so created_at_ms differs (ordering depends on it).
        clock.advance(1);
    }
    // The first code should be evicted; the rest should all redeem.
    let err = svc
        .redeem(codes[0].as_str(), "+1", "x")
        .await
        .expect_err("first code must be evicted");
    assert!(matches!(
        err,
        inariwatch_desktop_lib::pairing::PairingError::NotFound
    ));
    for code in codes.iter().skip(1) {
        let _ = svc
            .redeem(code.as_str(), "+1", "x")
            .await
            .expect("non-evicted code redeems");
    }
}
