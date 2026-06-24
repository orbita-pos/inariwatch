//! Debouncer + classification helpers for raw notify events.
//!
//! The actor wires `notify-debouncer-mini` directly in
//! [`super::watcher`]; this module owns the small pieces that are
//! convenient to unit-test without spinning up a full watcher: the
//! debounce window constant, the after-the-fact stat-based
//! classification of a coarse `Any` event into a `FsChangeKind`, and
//! the inotify-limit detection on the platforms it can fire.

use std::path::Path;
use std::time::Duration;

use crate::daemon::FsChangeKind;

/// Debounce window. 200ms collapses VS Code / JetBrains save bursts
/// (which fire create / modify / temp-file dance in <50ms) into a
/// single delivery.
pub const DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);

/// Classify a coarse `Any` debouncer event into a [`FsChangeKind`].
///
/// `notify-debouncer-mini` does not preserve the `created` /
/// `modified` / `deleted` distinction — every event arrives as
/// `DebouncedEventKind::Any` (or `AnyContinuous` when the file is
/// still being written). We recover the verb by stat-ing the path
/// after the debounce window: existing → Modified, missing → Deleted.
///
/// We default to `Modified` rather than `Created` because:
/// 1. Modify is dominant for active dev (>95% of events on a hot repo).
/// 2. Distinguishing Created requires tracking the previous file set,
///    which is the indexer's job (Session 6) — not the watcher's.
/// 3. Tests fs_emit_change / fs_delete cover the two modes that matter.
pub fn classify(path: &Path) -> FsChangeKind {
    if path.exists() {
        FsChangeKind::Modified
    } else {
        FsChangeKind::Deleted
    }
}

/// Detect whether a `notify::Error` is actually a Linux inotify limit
/// hit (ENOSPC) or per-process file-descriptor exhaustion (EMFILE).
/// Either condition needs a system tunable raised; we emit a
/// `DaemonEvent::SensorWarning` rather than crashing.
///
/// On macOS / Windows this always returns false — those platforms use
/// FSEvents / `ReadDirectoryChangesW` and don't have the same kernel
/// quota.
pub fn is_watch_limit_error(err: &notify::Error) -> bool {
    use notify::ErrorKind;
    match &err.kind {
        ErrorKind::MaxFilesWatch => true,
        ErrorKind::Io(io_err) => {
            // ENOSPC = 28, EMFILE = 24 on every Unix. Windows path
            // never hits this branch (raw_os_error returns Win32
            // codes that don't collide).
            #[cfg(unix)]
            {
                matches!(io_err.raw_os_error(), Some(28) | Some(24))
            }
            #[cfg(not(unix))]
            {
                let _ = io_err;
                false
            }
        }
        _ => false,
    }
}

/// User-facing message attached to a `SensorWarning` when the inotify
/// limit hits. Captures the exact knob to raise so the user can fix it
/// without leaving the dock.
pub const INOTIFY_LIMIT_HINT: &str =
    "FS watcher hit the inotify limit. Raise fs.inotify.max_user_watches \
     to 524288 — `echo 524288 | sudo tee /proc/sys/fs/inotify/max_user_watches`. \
     Persist via /etc/sysctl.d/.";
