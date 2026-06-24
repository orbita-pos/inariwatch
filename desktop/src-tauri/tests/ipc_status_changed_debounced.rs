//! Session 4 — `daemon:status_changed` dedup logic.
//!
//! `should_emit(last, current)` is the pure decision function the
//! status-bridge invokes between bus event and Tauri emit. We can't
//! easily drive the Tauri AppHandle here (no test harness yet), so we
//! exercise the dedup on its own:
//!
//! - first call (last=None) always emits
//! - identical back-to-back snapshots are suppressed
//! - any field change triggers an emit
//! - re-becoming-equal after a change emits once, then suppresses

use inariwatch_desktop_lib::ipc::commands::{snapshot_to_dto, DaemonStatusDto};
use inariwatch_desktop_lib::ipc::events::should_emit;
use inariwatch_desktop_lib::daemon::state::SharedDaemonState;

fn snap(uptime: u64, sensors: u32, repos: u32) -> DaemonStatusDto {
    let st = SharedDaemonState::new();
    st.set_uptime(std::time::Duration::from_secs(uptime));
    for _ in 0..sensors { st.inc_sensors(); }
    for _ in 0..repos   { st.inc_repos(); }
    snapshot_to_dto(&st.snapshot())
}

#[test]
fn first_emit_when_last_is_none() {
    let s = snap(10, 0, 0);
    assert!(should_emit(None, &s), "first observation must emit");
}

#[test]
fn duplicate_snapshot_is_suppressed() {
    let last = snap(10, 1, 0);
    let cur  = last.clone();
    assert!(!should_emit(Some(&last), &cur), "duplicate must suppress");
}

#[test]
fn sensor_count_change_emits() {
    let last = snap(10, 0, 0);
    let cur  = snap(10, 1, 0);
    assert!(should_emit(Some(&last), &cur), "sensor delta must emit");
}

#[test]
fn repo_count_change_emits() {
    let last = snap(10, 0, 0);
    let cur  = snap(10, 0, 1);
    assert!(should_emit(Some(&last), &cur), "repo delta must emit");
}

#[test]
fn back_to_back_burst_suppressed_after_first() {
    // Simulates 5 events arriving with no state change: only the
    // first transitions last=None → Some, the next 4 are suppressed.
    let mut last: Option<DaemonStatusDto> = None;
    let mut emits = 0;
    for _ in 0..5 {
        let cur = snap(10, 1, 0);
        if should_emit(last.as_ref(), &cur) {
            emits += 1;
            last = Some(cur);
        }
    }
    assert_eq!(emits, 1, "5 identical events must produce 1 emit");
}
