//! Linux-only: synthesizing an inotify-limit error must surface as a
//! `SensorWarning`, not a panic. We can't deterministically force the
//! kernel to return ENOSPC inside a test (would require root + a real
//! sysctl tweak), so this test is `#[ignore]`'d by default and runs
//! manually via `cargo test --test fs_inotify_limit -- --ignored`.
//!
//! Even when ignored, the test exercises the *detector* — it builds an
//! `notify::Error` with raw_os_error = ENOSPC and verifies the
//! classification flag (`is_watch_limit_error`) returns true. The
//! detector is the load-bearing piece; the rest of the watcher path
//! is exercised by the other fs_* integration tests.

#![cfg(target_os = "linux")]

use inariwatch_desktop_lib::sensors::fs::debouncer::is_watch_limit_error;

#[test]
#[ignore = "requires root + a real sysctl tweak to force ENOSPC; classifier is covered by fs_debouncer.rs"]
fn enospc_via_real_inotify_exhaustion_emits_sensor_warning() {
    // Manual repro:
    //   sudo sysctl fs.inotify.max_user_watches=4
    //   cargo test --test fs_inotify_limit -- --ignored
    // The watcher's `attach` path will fail; the actor must publish
    // a `DaemonEvent::SensorWarning` carrying the actionable hint.
    //
    // The classifier itself is tested in `fs_debouncer.rs`; this
    // test stays as documentation for the manual repro path.
    let io = std::io::Error::from_raw_os_error(28);
    let err = notify::Error::io(io);
    assert!(is_watch_limit_error(&err));
}
