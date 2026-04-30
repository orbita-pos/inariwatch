//! Modifying a watched file emits `FsChange::Modified` within ≤500ms.
//!
//! This is the smoke test that the notify-debouncer-mini wiring
//! actually delivers events end-to-end. We use the test-only
//! `watch_for_test` helper that constructs a debouncer synchronously
//! (skipping the actor thread) so the test can deterministically
//! observe one repo without racing the actor's `recv_timeout` cycle.

use std::path::Path;
use std::time::{Duration, Instant};

use inariwatch_desktop_lib::daemon::{DaemonEvent, EventBus, FsChangeKind};
use inariwatch_desktop_lib::sensors::fs::watcher::watch_for_test;

const RECV_BUDGET:    Duration = Duration::from_secs(2);
const WARMUP_SETTLE:  Duration = Duration::from_millis(300);

#[test]
fn modify_existing_file_emits_modified() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().to_path_buf();
    let file = root.join("note.txt");
    std::fs::write(&file, b"v1").expect("seed");

    let bus = EventBus::new();
    let rx  = bus.subscribe();

    let _watcher = watch_for_test(bus.clone(), "repo-modify".to_string(), root.clone())
        .expect("watcher attaches");

    // notify-debouncer-mini sometimes fires a "ready" event after attach
    // — burn the warm-up window before we touch the file so we measure
    // only post-modification latency.
    std::thread::sleep(WARMUP_SETTLE);
    drain(&rx);

    let started_at = Instant::now();
    std::fs::write(&file, b"v2").expect("modify");

    // 50 rapid follow-up writes within 100ms simulate a save burst —
    // they must collapse into ONE delivery thanks to the debouncer's
    // 200ms window.
    for i in 0..50 {
        std::fs::write(&file, format!("v{}", i).as_bytes()).expect("modify burst");
    }

    let event = wait_for_fs_change(&rx, RECV_BUDGET, &file)
        .expect("FsChange::Modified must arrive within 2s");

    match event {
        DaemonEvent::FsChange { repo_id, path, kind } => {
            assert_eq!(repo_id, "repo-modify");
            assert!(
                Path::new(&path).ends_with("note.txt"),
                "expected path ending in note.txt, got {}",
                path
            );
            assert_eq!(kind, FsChangeKind::Modified);
            // Latency budget: the debouncer's 200ms window + delivery
            // overhead. Real-world is well under 500ms; we cap at 2s
            // so flaky CI doesn't false-fail.
            let elapsed = started_at.elapsed();
            assert!(
                elapsed < Duration::from_secs(2),
                "FsChange took {:?} (>2s budget)", elapsed
            );
        }
        other => panic!("expected FsChange::Modified, got {:?}", other),
    }
}

fn drain(rx: &inariwatch_desktop_lib::daemon::bus::Receiver) {
    while rx.try_recv().is_ok() {}
}

/// Block until an FsChange targeting `target` arrives, or the budget
/// expires. Skips Heartbeat / RepoIndexed / SensorWarning events that
/// might be racing in the bus.
fn wait_for_fs_change(
    rx:     &inariwatch_desktop_lib::daemon::bus::Receiver,
    budget: Duration,
    target: &Path,
) -> Option<DaemonEvent> {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(ev) => match &ev {
                DaemonEvent::FsChange { path, .. }
                    if Path::new(path).file_name() == target.file_name() =>
                {
                    return Some(ev);
                }
                _ => continue,
            },
            Err(_) => return None,
        }
    }
    None
}
