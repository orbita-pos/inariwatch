//! Deleting a watched file emits `FsChange::Deleted`.

use std::path::Path;
use std::time::{Duration, Instant};

use inariwatch_desktop_lib::daemon::{DaemonEvent, EventBus, FsChangeKind};
use inariwatch_desktop_lib::sensors::fs::watcher::watch_for_test;

const RECV_BUDGET:   Duration = Duration::from_secs(3);
const WARMUP_SETTLE: Duration = Duration::from_millis(300);

#[test]
fn delete_tracked_file_emits_deleted() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().to_path_buf();
    let file = root.join("trash.txt");
    std::fs::write(&file, b"bye").expect("seed");

    let bus = EventBus::new();
    let rx  = bus.subscribe();

    let _watcher = watch_for_test(bus.clone(), "repo-del".to_string(), root.clone())
        .expect("watcher attaches");

    std::thread::sleep(WARMUP_SETTLE);
    drain(&rx);

    std::fs::remove_file(&file).expect("delete");

    let event = wait_for_fs_change(&rx, RECV_BUDGET, &file)
        .expect("FsChange::Deleted must arrive within 3s");

    match event {
        DaemonEvent::FsChange { repo_id, path, kind } => {
            assert_eq!(repo_id, "repo-del");
            assert!(
                Path::new(&path).ends_with("trash.txt"),
                "expected path ending in trash.txt, got {}",
                path
            );
            assert_eq!(
                kind, FsChangeKind::Deleted,
                "missing path must classify as Deleted (got {:?})",
                kind
            );
        }
        other => panic!("expected FsChange::Deleted, got {:?}", other),
    }
}

fn drain(rx: &inariwatch_desktop_lib::daemon::bus::Receiver) {
    while rx.try_recv().is_ok() {}
}

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
