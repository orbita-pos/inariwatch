//! Debouncer collapse + classification + inotify-limit detection.

use std::path::Path;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::FsChangeKind;
use inariwatch_desktop_lib::sensors::fs::debouncer::{
    classify, is_watch_limit_error, DEBOUNCE_WINDOW, INOTIFY_LIMIT_HINT,
};

#[test]
fn classify_existing_file_is_modified() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("hello.txt");
    std::fs::write(&path, b"x").expect("write");
    assert_eq!(classify(&path), FsChangeKind::Modified);
}

#[test]
fn classify_missing_file_is_deleted() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("does_not_exist.txt");
    assert_eq!(classify(&path), FsChangeKind::Deleted);
}

#[test]
fn classify_directory_path_is_modified() {
    // Existing path that's a directory still classifies as Modified —
    // the watcher filters dir events at the repo root, but other
    // directory paths in the tree fall through with the existing-path
    // verdict.
    let tmp = tempfile::tempdir().expect("tempdir");
    assert_eq!(classify(tmp.path()), FsChangeKind::Modified);
}

#[test]
fn debounce_window_matches_spec() {
    assert_eq!(
        DEBOUNCE_WINDOW,
        Duration::from_millis(200),
        "Session 5 spec locks the debounce window at 200ms"
    );
}

#[test]
fn inotify_limit_hint_is_actionable() {
    // The hint must mention the actual sysctl knob; otherwise users
    // can't act on the SensorWarning. Regression test against future
    // copy edits that drop the path.
    assert!(
        INOTIFY_LIMIT_HINT.contains("max_user_watches"),
        "hint must reference fs.inotify.max_user_watches: {}",
        INOTIFY_LIMIT_HINT
    );
}

#[test]
#[cfg(unix)]
fn inotify_limit_detection_recognizes_enospc() {
    // Synthesize an Io error with errno = 28 (ENOSPC) + run it through
    // the detector.
    let io_err = std::io::Error::from_raw_os_error(28);
    let notify_err = notify::Error::io(io_err);
    assert!(
        is_watch_limit_error(&notify_err),
        "ENOSPC must be classified as a watch limit hit"
    );
}

#[test]
#[cfg(unix)]
fn inotify_limit_detection_recognizes_emfile() {
    let io_err = std::io::Error::from_raw_os_error(24);
    let notify_err = notify::Error::io(io_err);
    assert!(is_watch_limit_error(&notify_err));
}

#[test]
fn unrelated_io_error_is_not_a_watch_limit() {
    // Any other errno must NOT trigger the SensorWarning.
    let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "eperm");
    let notify_err = notify::Error::io(io_err);
    assert!(!is_watch_limit_error(&notify_err));
}

// Suppress unused-import warning on non-unix platforms where the
// errno tests are gated out.
#[allow(dead_code)]
fn _force_path_use(_: &Path) {}
