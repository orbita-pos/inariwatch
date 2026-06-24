//! Session 4 — `daemon_status` payload shape.
//!
//! `snapshot_to_dto` is the single source of truth shared by the
//! `daemon_status` IPC command and the `daemon:status_changed` event
//! bridge. We exercise it directly to assert the wire shape:
//! - uptime/sensor/repo come from the SharedDaemonState snapshot
//! - version is `CARGO_PKG_VERSION`
//! - started_at is ISO-8601 UTC, length 20, ends with `Z`
//! - re-deriving across calls yields a stable `started_at` (no drift)

use inariwatch_desktop_lib::daemon::state::{DaemonStatus, SharedDaemonState};
use inariwatch_desktop_lib::ipc::commands::{epoch_secs_to_iso8601, snapshot_to_dto};

#[test]
fn dto_shape_matches_state() {
    let state = SharedDaemonState::new();
    state.set_uptime(std::time::Duration::from_secs(42));
    state.inc_sensors();
    state.inc_sensors();
    state.inc_repos();

    let dto = snapshot_to_dto(&state.snapshot());

    assert_eq!(dto.uptime_secs, 42);
    assert_eq!(dto.sensor_count, 2);
    assert_eq!(dto.repo_count, 1);
    assert_eq!(dto.version, env!("CARGO_PKG_VERSION"));
    assert!(dto.started_at.ends_with('Z'), "started_at must be UTC ISO-8601");
    assert_eq!(
        dto.started_at.len(),
        20,
        "started_at format YYYY-MM-DDTHH:MM:SSZ is 20 chars"
    );
}

#[test]
fn started_at_is_stable_across_calls() {
    let state = SharedDaemonState::new();
    state.set_uptime(std::time::Duration::from_secs(10));

    let dto1 = snapshot_to_dto(&state.snapshot());

    // Sleep a wall-clock second; if started_at were re-computed each
    // time without caching, dto2.started_at would differ from dto1.
    std::thread::sleep(std::time::Duration::from_secs(1));
    let dto2 = snapshot_to_dto(&state.snapshot());

    assert_eq!(
        dto1.started_at, dto2.started_at,
        "started_at must be cached on first call to keep PartialEq stable"
    );
}

#[test]
fn iso_helper_formats_known_epoch() {
    // 2026-04-29T12:00:00Z — the date this test was written.
    // 56 years × 365.25 days × 86400s ≈ 1_777_113_600 (approx)
    // Use a known unix timestamp: 0 → 1970-01-01T00:00:00Z.
    assert_eq!(epoch_secs_to_iso8601(0), "1970-01-01T00:00:00Z");
    assert_eq!(epoch_secs_to_iso8601(86_400), "1970-01-02T00:00:00Z");
    // Cross-year boundary.
    assert_eq!(epoch_secs_to_iso8601(31_536_000), "1971-01-01T00:00:00Z");
}

#[test]
fn dto_is_serde_compatible() {
    // A future change must not silently break the IPC contract.
    let snap = DaemonStatus {
        uptime_secs:  5,
        sensor_count: 0,
        repo_count:   0,
    };
    let dto = snapshot_to_dto(&snap);
    let json = serde_json::to_string(&dto).expect("serialize");
    assert!(json.contains("\"uptime_secs\":5"));
    assert!(json.contains("\"version\":"));
    assert!(json.contains("\"started_at\":"));
}
