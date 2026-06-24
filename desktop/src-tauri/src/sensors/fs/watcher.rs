//! FS sensor actor — owns one `notify-debouncer-mini` watcher per
//! attached repo plus the rayon-spawned initial walker.
//!
//! Lifecycle:
//!
//! 1. [`super::spawn_fs_sensor`] increments the daemon `sensor_count`
//!    and starts the actor on a dedicated `std::thread`.
//! 2. The actor blocks on its command channel for `Attach` / `Detach`.
//!    Every 150ms (max command-wait timeout) it also drains the daemon
//!    bus looking for `Shutdown` so we never sit forever after the
//!    daemon has asked everyone to drain.
//! 3. On `Attach`, the actor:
//!     - Spawns a rayon walker that emits `RepoIndexed` when done.
//!     - Constructs a `notify-debouncer-mini` debouncer whose
//!       callback publishes `FsChange` for each debounced delivery.
//!     - Stores the debouncer in `active` keyed by `repo_id` so
//!       `Detach` can drop it (which stops the watch).
//! 4. On `Detach`, the actor drops the `RepoWatcher`, releasing
//!    the OS-level watch handles.
//! 5. On `Shutdown` (or channel disconnect), the actor drops every
//!    active watcher in one go and decrements `sensor_count`.
//!
//! The actor is intentionally synchronous + std-thread based: no tokio
//! runtime requirement, no async coloring of the FS sensor's tiny
//! command surface. Tests instantiate `EventBus` + `SharedDaemonState`
//! directly and drive the actor via the public handle.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

use crate::daemon::{DaemonEvent, EventBus, FsChangeKind, SharedDaemonState};

use super::debouncer::{classify, is_watch_limit_error, DEBOUNCE_WINDOW, INOTIFY_LIMIT_HINT};
use super::error::FsSensorError;
use super::walker::{walk_repo, WalkResult};

/// Cadence at which the actor wakes up to check the daemon bus for
/// `Shutdown`. Trades shutdown latency for thread CPU; 150ms keeps
/// shutdown well under the daemon's 5s grace window with negligible
/// overhead.
const ACTOR_TICK: Duration = Duration::from_millis(150);

/// Sensor name surfaced in `SensorWarning` events. Single source of
/// truth so `lib.rs::setup_tray` and tests can match on it.
pub const SENSOR_NAME: &str = "fs";

/// Wrapper holding one repo's debouncer. Dropping the wrapper stops
/// the underlying watch.
struct RepoWatcher {
    /// Owned debouncer. Drop = stop watching. The type parameter is
    /// `notify::RecommendedWatcher` (the platform-default backend).
    _debouncer: Debouncer<notify::RecommendedWatcher>,
}

/// Commands the actor processes from the public handle.
pub(super) enum FsSensorCmd {
    /// Start watching `path` and walking it; emits `RepoIndexed` +
    /// subsequent `FsChange` events. Idempotent — re-attaching the
    /// same `repo_id` is a no-op (drops the prior watcher first to
    /// keep one watch per repo).
    Attach { repo_id: String, path: PathBuf },
    /// Stop watching `repo_id` and release its OS-level watch handle.
    /// Idempotent — detaching an unknown id is a no-op.
    Detach { repo_id: String },
}

/// Public handle returned by [`super::spawn_fs_sensor`]. Cloneable so
/// IPC commands can attach/detach from any task.
#[derive(Clone)]
pub struct FsSensorHandle {
    cmd_tx: flume::Sender<FsSensorCmd>,
}

impl FsSensorHandle {
    /// Tell the actor to start watching `path` under `repo_id`.
    /// Returns immediately — the walk + watch start happen on the
    /// actor thread. Errors only fire when the actor has already
    /// shut down.
    pub fn attach(&self, repo_id: String, path: PathBuf) -> Result<(), FsSensorError> {
        self.cmd_tx
            .send(FsSensorCmd::Attach { repo_id, path })
            .map_err(|_| FsSensorError::Shutdown)
    }

    /// Tell the actor to release `repo_id`'s watcher. Idempotent.
    pub fn detach(&self, repo_id: String) -> Result<(), FsSensorError> {
        self.cmd_tx
            .send(FsSensorCmd::Detach { repo_id })
            .map_err(|_| FsSensorError::Shutdown)
    }
}

/// Spawn the actor. Increments the daemon sensor counter; the actor
/// decrements it on exit.
///
/// The returned handle is `Clone`. Drop *all* clones to shut the
/// sensor down deterministically — the actor's `flume::Receiver`
/// observes `Disconnected` and exits. Alternatively, the actor exits
/// when it sees `DaemonEvent::Shutdown` on the bus.
pub fn spawn_fs_sensor(bus: EventBus, state: SharedDaemonState) -> FsSensorHandle {
    let (cmd_tx, cmd_rx) = flume::unbounded::<FsSensorCmd>();
    state.inc_sensors();
    let bus_for_actor   = bus.clone();
    let state_for_actor = state.clone();

    std::thread::Builder::new()
        .name("inari-fs-sensor".to_string())
        .spawn(move || {
            run_actor(bus_for_actor, state_for_actor, cmd_rx);
        })
        .expect("spawn fs sensor actor thread");

    FsSensorHandle { cmd_tx }
}

fn run_actor(
    bus:    EventBus,
    state:  SharedDaemonState,
    cmd_rx: flume::Receiver<FsSensorCmd>,
) {
    let mut active: HashMap<String, RepoWatcher> = HashMap::new();
    let bus_rx = bus.subscribe();
    tracing::info!(sensor = SENSOR_NAME, "fs sensor started");

    'outer: loop {
        match cmd_rx.recv_timeout(ACTOR_TICK) {
            Ok(FsSensorCmd::Attach { repo_id, path }) => {
                handle_attach(&bus, &mut active, repo_id, path);
            }
            Ok(FsSensorCmd::Detach { repo_id }) => {
                if active.remove(&repo_id).is_some() {
                    tracing::info!(sensor = SENSOR_NAME, %repo_id, "detached");
                }
            }
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => {
                tracing::info!(sensor = SENSOR_NAME, "command channel closed — shutting down");
                break 'outer;
            }
        }

        // Drain bus for Shutdown. We don't react to other events; the
        // bus is just a "sensors should drain" signal.
        while let Ok(ev) = bus_rx.try_recv() {
            if matches!(ev, DaemonEvent::Shutdown) {
                tracing::info!(sensor = SENSOR_NAME, "Shutdown observed — draining");
                break 'outer;
            }
        }
    }

    drop(active); // drops every debouncer, releasing OS handles.
    state.dec_sensors();
    tracing::info!(sensor = SENSOR_NAME, "fs sensor stopped");
}

fn handle_attach(
    bus:     &EventBus,
    active:  &mut HashMap<String, RepoWatcher>,
    repo_id: String,
    path:    PathBuf,
) {
    if !path.is_dir() {
        bus.publish(DaemonEvent::SensorWarning {
            sensor:  SENSOR_NAME.to_string(),
            message: format!("attach refused — not a directory: {}", path.display()),
        });
        return;
    }

    // Re-attach: drop the old watcher first so we don't hold two
    // handles on the same path.
    if active.remove(&repo_id).is_some() {
        tracing::debug!(sensor = SENSOR_NAME, %repo_id, "re-attaching — replacing existing watcher");
    }

    // Spawn the initial walker on rayon. The walk + emit are independent
    // of the watcher startup so we don't gate `RepoIndexed` on inotify
    // resources.
    spawn_initial_walk(bus.clone(), repo_id.clone(), path.clone());

    // Build the debouncer. The closure is `Send + 'static` and gets
    // invoked on the debouncer's own thread.
    let bus_for_cb  = bus.clone();
    let repo_for_cb = repo_id.clone();
    let path_for_cb = path.clone();

    let mut debouncer = match new_debouncer(
        DEBOUNCE_WINDOW,
        move |res: DebounceEventResult| {
            handle_debounced(&bus_for_cb, &repo_for_cb, &path_for_cb, res);
        },
    ) {
        Ok(d) => d,
        Err(err) => {
            warn_about(bus, &err, "debouncer construction failed");
            return;
        }
    };

    // Watching the path can fail with the inotify limit on Linux even
    // when construction succeeded — surface that as a SensorWarning,
    // not a panic.
    if let Err(err) = debouncer.watcher().watch(&path, RecursiveMode::Recursive) {
        warn_about(bus, &err, "watch attach failed");
        return;
    }

    active.insert(repo_id.clone(), RepoWatcher { _debouncer: debouncer });
    tracing::info!(sensor = SENSOR_NAME, %repo_id, path = %path.display(), "attached");
}

/// Run the initial walk on a rayon worker so the actor thread stays
/// responsive to commands.
fn spawn_initial_walk(bus: EventBus, repo_id: String, path: PathBuf) {
    rayon::spawn(move || {
        let WalkResult { file_count, duration_ms, truncated, .. } = walk_repo(&path);
        if truncated {
            bus.publish(DaemonEvent::SensorWarning {
                sensor:  SENSOR_NAME.to_string(),
                message: format!(
                    "walker truncated at {} files for {} — add a .gitignore for large directories",
                    file_count,
                    path.display()
                ),
            });
        }
        bus.publish(DaemonEvent::RepoIndexed {
            repo_id,
            file_count,
            duration_ms,
        });
    });
}

/// Common error handler for both debouncer construction and watch
/// attach. Detects the inotify limit and emits a typed warning;
/// everything else just logs.
fn warn_about(bus: &EventBus, err: &notify::Error, ctx: &str) {
    if is_watch_limit_error(err) {
        bus.publish(DaemonEvent::SensorWarning {
            sensor:  SENSOR_NAME.to_string(),
            message: INOTIFY_LIMIT_HINT.to_string(),
        });
    }
    tracing::warn!(sensor = SENSOR_NAME, error = %err, ctx = ctx, "fs sensor: error");
}

/// Translate one debouncer delivery into a batch of `FsChange` events.
fn handle_debounced(
    bus:     &EventBus,
    repo_id: &str,
    repo_root: &Path,
    res:     DebounceEventResult,
) {
    let events = match res {
        Ok(evs) => evs,
        Err(err) => {
            // notify-debouncer-mini 0.4 surfaces one notify::Error per
            // delivery (newer -full versions return a Vec; we'd
            // re-evaluate when upgrading). Inotify-limit hits collapse
            // into a single SensorWarning and we return rather than
            // crashing the callback.
            if is_watch_limit_error(&err) {
                bus.publish(DaemonEvent::SensorWarning {
                    sensor:  SENSOR_NAME.to_string(),
                    message: INOTIFY_LIMIT_HINT.to_string(),
                });
            } else {
                tracing::warn!(sensor = SENSOR_NAME, error = %err, "debouncer error");
            }
            return;
        }
    };

    for ev in events {
        // Filter out events that target the repo root itself — those
        // fire on macOS FSEvents when a child changes and are noisy.
        if ev.path == repo_root {
            continue;
        }

        let kind: FsChangeKind = classify(&ev.path);
        bus.publish(DaemonEvent::FsChange {
            repo_id: repo_id.to_string(),
            path:    ev.path.display().to_string(),
            kind,
        });
    }
}

// ── Public re-exports for the sensor's tiny test surface ───────────────────

/// Manual entry-point that constructs a single `RepoWatcher` synchronously.
/// Production code does **not** call this — go through [`spawn_fs_sensor`]
/// + [`FsSensorHandle::attach`] instead. Lives outside `#[cfg(test)]` so
/// the integration tests in `tests/fs_*.rs` (which link against the lib
/// as a downstream crate, where `cfg(test)` is false) can use it.
///
/// Returns the held watcher to the caller; dropping it stops the watch.
#[doc(hidden)]
pub fn watch_for_test(
    bus:     EventBus,
    repo_id: String,
    path:    PathBuf,
) -> Result<Debouncer<notify::RecommendedWatcher>, notify::Error> {
    let bus_for_cb  = bus.clone();
    let repo_for_cb = repo_id.clone();
    let path_for_cb = path.clone();

    let mut debouncer = new_debouncer(
        DEBOUNCE_WINDOW,
        move |res: DebounceEventResult| {
            handle_debounced(&bus_for_cb, &repo_for_cb, &path_for_cb, res);
        },
    )?;
    debouncer.watcher().watch(&path, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

/// Synchronous walk + publish helper for tests. Production callers go
/// through [`spawn_fs_sensor`] + the rayon-spawned walk inside
/// `handle_attach`.
#[doc(hidden)]
pub fn walk_and_publish(bus: EventBus, repo_id: String, path: PathBuf) {
    let WalkResult { file_count, duration_ms, .. } = walk_repo(&path);
    bus.publish(DaemonEvent::RepoIndexed {
        repo_id,
        file_count,
        duration_ms,
    });
}

/// Re-export of [`walk_repo`] specifically for the indexer (Session 6).
/// Lives behind a doc(hidden) function so the indexer can re-walk a
/// repo on bootstrap / `ReindexRequested` without having to depend on
/// `super::walker` directly. Keeps the FS sensor's public surface
/// (`spawn_fs_sensor`/`FsSensorHandle`) frozen.
#[doc(hidden)]
pub fn walk_for_indexer(path: &Path) -> WalkResult {
    walk_repo(path)
}

// Silence "unused" warnings for `Arc` etc on Windows where some cfgs
// thin out. Keeps the production build clean.
#[allow(dead_code)]
fn _arc_send_marker() -> Arc<()> {
    Arc::new(())
}
