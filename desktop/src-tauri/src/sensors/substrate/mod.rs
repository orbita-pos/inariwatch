//! Sensor 6 — Substrate replay correlation (Sesión 10).
//!
//! Subscribes to [`crate::daemon::DaemonEvent::FsChange`] and, for every
//! source-file edit on a repo with `replay_enabled` set, finds the
//! most-recent recording in `<repo>/.inari/recordings/<id>/` and asks
//! the configured [`replay_client::ReplayBackend`] whether the change
//! preserves recorded behaviour. The verdict is published as
//! [`crate::daemon::DaemonEvent::ReplayResult`] and persisted to the
//! `events` table.
//!
//! Track 2 closer: this is the last sensor in Track 2 of the dock
//! plan. Sensors 1-5 shipped in Sesiones 5/8/9/etc; Sensor 6 wires
//! the substrate piece end-to-end.
//!
//! ## Lifecycle
//!
//! - [`spawn`] increments `sensor_count`, resolves the default
//!   backend (local binary preferred, remote fallback), spawns the
//!   bus-driver task and the hourly retention task, and returns.
//! - The bus-driver loop yields on `tokio::select!` between the bus
//!   subscription and a `Shutdown`. Each `FsChange::Modified` for a
//!   replay-enabled repo dispatches into [`spawn_blocking`] so the
//!   replay binary / HTTP call doesn't stall the loop.
//! - The retention task runs `prune_old_recordings` every hour and
//!   deletes recording dirs older than 7 days. Pruning is best-effort
//!   — `tracing::warn!` on IO error, never panic.
//! - On `DaemonEvent::Shutdown` BOTH tasks exit and `sensor_count` is
//!   decremented.
//!
//! ## Privacy
//!
//! - Recording paths NEVER leave the bus / events table — only the
//!   bare recording id (UUID v4) goes on the wire.
//! - The full divergence payload (including any recorded body data)
//!   is persisted to `<repo>/.inari/replays/<recording_id>.json` for
//!   the dock UI (Sesión 17) to read on demand. The `events` row only
//!   carries the same metadata the bus saw.
//! - User content from the modified source file is sent to the
//!   replay backend (which may be remote). Users opt into this
//!   explicitly via the per-repo `replay_enabled` toggle (migration
//!   0004) — default is OFF.

pub mod replay_client;
pub mod wrapper;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::async_runtime::JoinHandle;

use crate::daemon::{
    DaemonEvent, DaemonHandle, DivergenceSummary, EventBus, FsChangeKind, SharedDaemonState,
};
use crate::store::{queries, Store};

pub use replay_client::{
    auto_backend, LocalReplayBackend, RemoteReplayBackend, ReplayBackend, ReplayOutcome,
    DEFAULT_LOCAL_BINARY,
};
pub use wrapper::{
    compose_wrapped_dev, is_wrapped, offer_wrap_or_cli, unwrap_dev_script, wrap_dev_script,
    UnwrapOutcome, WrapOption, WrapOutcome, BACKUP_SUFFIX, INARI_NODE_OPTIONS_MARKER,
};

/// Sensor name — surfaced in `tracing::*` events and (eventually) in
/// `SensorWarning`. Single source of truth so installer + tests can
/// match on it.
pub const SUBSTRATE_SENSOR_NAME: &str = "substrate";

/// Source-file extensions the sensor reacts to. Matches the
/// Sesión-10 spec exactly. Hard-coded for now; Sesión 17 wires it
/// behind a per-repo allowlist in the dock settings panel.
pub const SOURCE_FILE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py",
];

/// Time window for "recent" recordings. An `FsChange::Modified` on a
/// source file only triggers replay if the most-recent recording is
/// inside this window. Older recordings are too stale to be a fair
/// reflection of current code.
pub const RECENT_WINDOW: Duration = Duration::from_secs(60);

/// Recording retention. The hourly task deletes recording dirs whose
/// directory mtime is older than this.
pub const RECORDING_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Cadence of the retention sweep task.
pub const RETENTION_TICK: Duration = Duration::from_secs(60 * 60);

/// Spawn the substrate sensor with the auto-resolved backend. Production
/// entry point — the Tauri `setup` hook calls this.
pub fn spawn(daemon: Arc<DaemonHandle>, store: Arc<Store>) -> JoinHandle<()> {
    spawn_with_backend(replay_client::auto_backend(), daemon, store)
}

/// Spawn the substrate sensor with an explicit backend. `None` means
/// "no backend available" — the actor still runs (so `sensor_count` is
/// honoured) but never publishes a `ReplayResult`. Public for the
/// integration tests that inject a mock backend.
pub fn spawn_with_backend(
    backend: Option<Box<dyn ReplayBackend>>,
    daemon:  Arc<DaemonHandle>,
    store:   Arc<Store>,
) -> JoinHandle<()> {
    daemon.state.inc_sensors();
    let bus_for_actor:   EventBus            = daemon.bus.clone();
    let state_for_actor: SharedDaemonState   = daemon.state.clone();

    tauri::async_runtime::spawn(async move {
        let backend = backend.map(Arc::<dyn ReplayBackend>::from);

        match backend.as_ref() {
            Some(b) => tracing::info!(
                sensor  = SUBSTRATE_SENSOR_NAME,
                backend = b.name(),
                "substrate sensor running",
            ),
            None    => tracing::info!(
                sensor = SUBSTRATE_SENSOR_NAME,
                "substrate sensor running INERT (no backend)",
            ),
        }

        let bus_rx       = bus_for_actor.subscribe();
        // Retention runs as a sibling task — it only needs the bus to
        // observe Shutdown, so it owns its own subscription.
        let retention_h  = spawn_retention_task(bus_for_actor.clone());

        loop {
            match bus_rx.recv_async().await {
                Ok(DaemonEvent::FsChange { repo_id, path, kind: FsChangeKind::Modified }) => {
                    let Some(b) = backend.clone() else { continue };
                    let bus    = bus_for_actor.clone();
                    let store  = store.clone();
                    handle_fs_change(b, bus, store, repo_id, path).await;
                }
                Ok(DaemonEvent::Shutdown) => {
                    tracing::info!(sensor = SUBSTRATE_SENSOR_NAME, "shutdown observed");
                    break;
                }
                Ok(_)  => continue,
                Err(_) => break,
            }
        }

        retention_h.abort();
        state_for_actor.dec_sensors();
        tracing::info!(sensor = SUBSTRATE_SENSOR_NAME, "substrate sensor stopped");
    })
}

/// Pure helper — does the path's extension qualify as a source file?
/// Public for the integration tests so they can assert filter parity
/// without spinning up the actor.
pub fn is_source_file(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let Some(e) = ext else { return false };
    SOURCE_FILE_EXTENSIONS.iter().any(|s| *s == e.as_str())
}

/// Compute the recordings root for a repo. Public so the integration
/// tests can write fixtures without depending on private layout.
pub fn recordings_root(repo_path: &Path) -> PathBuf {
    repo_path.join(".inari").join("recordings")
}

/// Compute the replays root for a repo. Public for the dock — the
/// payload-on-disk that subscribers DON'T see lives here.
pub fn replays_root(repo_path: &Path) -> PathBuf {
    repo_path.join(".inari").join("replays")
}

/// Find the most-recent recording directory inside `recordings_root`.
/// Returns `None` when no recording exists OR when the newest is
/// older than `window`. Each immediate subdirectory of the root is
/// considered one recording; we use the directory mtime as the
/// freshness signal.
pub fn find_recent_recording(
    recordings_root: &Path,
    window: Duration,
) -> std::io::Result<Option<PathBuf>> {
    if !recordings_root.exists() {
        return Ok(None);
    }
    let now = SystemTime::now();
    let mut best: Option<(PathBuf, SystemTime)> = None;

    for entry in std::fs::read_dir(recordings_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let mtime = entry.metadata()?.modified()?;
        if let Ok(elapsed) = now.duration_since(mtime) {
            if elapsed > window {
                continue;
            }
        }
        match best {
            Some((_, ref t)) if mtime <= *t => {}
            _ => best = Some((entry.path(), mtime)),
        }
    }
    Ok(best.map(|(p, _)| p))
}

/// Bus-publish + DB-persist the verdict. Public for integration tests.
pub fn publish_replay_result(
    bus: &EventBus,
    store: &Store,
    repo_id: &str,
    recording_id: &str,
    outcome: &ReplayOutcome,
) {
    let event = DaemonEvent::ReplayResult {
        repo_id:      repo_id.to_string(),
        recording_id: recording_id.to_string(),
        matched:      outcome.matched,
        divergence:   outcome.divergence.clone(),
    };
    bus.publish(event);

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "recording_id": recording_id,
        "match":        outcome.matched,
        "divergence":   outcome.divergence.as_ref().map(summarize_divergence),
    });
    if let Err(e) = queries::insert_event(
        store,
        now_ms,
        "replay_result",
        Some(repo_id),
        &payload.to_string(),
    ) {
        tracing::warn!(
            sensor  = SUBSTRATE_SENSOR_NAME,
            error   = %e,
            repo_id,
            "replay_result persistence failed",
        );
    }
}

/// Hourly retention sweep: walk every repo's recordings root and
/// delete subdirs older than [`RECORDING_RETENTION`]. Best-effort.
pub fn prune_old_recordings(repo_path: &Path) -> std::io::Result<usize> {
    let root = recordings_root(repo_path);
    if !root.exists() {
        return Ok(0);
    }
    let now = SystemTime::now();
    let mut deleted = 0;
    for entry in std::fs::read_dir(&root)? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, "retention: read_dir entry skipped");
                continue;
            }
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let Ok(elapsed) = now.duration_since(mtime) else { continue };
        if elapsed <= RECORDING_RETENTION {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                tracing::info!(
                    sensor   = SUBSTRATE_SENSOR_NAME,
                    recording = %path.display(),
                    age_secs  = elapsed.as_secs(),
                    "retention: pruned old recording",
                );
                deleted += 1;
            }
            Err(e) => tracing::warn!(
                sensor    = SUBSTRATE_SENSOR_NAME,
                recording = %path.display(),
                error     = %e,
                "retention: prune failed",
            ),
        }
    }
    Ok(deleted)
}

// ── private internals ────────────────────────────────────────────────

/// Handle a single `FsChange::Modified` event. Resolves the repo, runs
/// the backend on a blocking thread, publishes the verdict.
async fn handle_fs_change(
    backend: Arc<dyn ReplayBackend>,
    bus:     EventBus,
    store:   Arc<Store>,
    repo_id: String,
    path:    String,
) {
    if !is_source_file(&path) {
        return;
    }

    // `replay_enabled` flag — silently skip if off. Most repos will
    // be in this branch on launch (default false post-migration).
    let enabled = match queries::find_repo_replay_enabled(&store, &repo_id) {
        Ok(b)  => b,
        Err(e) => {
            tracing::warn!(
                sensor = SUBSTRATE_SENSOR_NAME,
                repo_id,
                error  = %e,
                "find_repo_replay_enabled failed",
            );
            return;
        }
    };
    if !enabled {
        return;
    }

    // Resolve the on-disk repo path.
    let repo_path = match queries::find_repo_path_by_id(&store, &repo_id) {
        Ok(Some(p)) => PathBuf::from(p),
        Ok(None)    => return,
        Err(e) => {
            tracing::warn!(
                sensor = SUBSTRATE_SENSOR_NAME,
                repo_id,
                error  = %e,
                "find_repo_path_by_id failed",
            );
            return;
        }
    };

    let recording_dir = match find_recent_recording(&recordings_root(&repo_path), RECENT_WINDOW) {
        Ok(Some(d)) => d,
        Ok(None)    => return, // silent no-op per spec
        Err(e) => {
            tracing::warn!(
                sensor = SUBSTRATE_SENSOR_NAME,
                repo_id,
                error  = %e,
                "find_recent_recording failed",
            );
            return;
        }
    };

    let recording_id = recording_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    // The change path is what the FS sensor reported; absolute on
    // Linux/macOS, repo-relative on Windows depending on notify
    // backend. We pass it through verbatim — the backend decides how
    // to materialise the overlay.
    let overlay_path = PathBuf::from(&path);

    let backend_for_blocking = backend.clone();
    let recording_for_blocking = recording_dir.clone();
    let outcome_res = tauri::async_runtime::spawn_blocking(move || {
        backend_for_blocking.replay(&recording_for_blocking, &overlay_path)
    }).await;

    let outcome = match outcome_res {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            tracing::warn!(
                sensor       = SUBSTRATE_SENSOR_NAME,
                backend      = backend.name(),
                recording_id,
                error        = %e,
                "replay failed",
            );
            return;
        }
        Err(e) => {
            tracing::warn!(
                sensor = SUBSTRATE_SENSOR_NAME,
                error  = %e,
                "spawn_blocking join failed",
            );
            return;
        }
    };

    publish_replay_result(&bus, &store, &repo_id, &recording_id, &outcome);
}

/// Spawn the hourly retention task. Returns a handle so the actor can
/// abort it on shutdown.
fn spawn_retention_task(bus: EventBus) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let bus_rx = bus.subscribe();
        let mut tick = tokio::time::interval(RETENTION_TICK);
        // Skip the immediate first fire — we want the first sweep to
        // happen one full interval after spawn so quick test runs
        // don't trip on the prune side-effect.
        tick.tick().await;

        // Track which repo paths we've seen via FsChange so we know
        // where to sweep. Using HashSet so re-emits from busy repos
        // don't accumulate duplicates.
        let mut known_repos: HashSet<PathBuf> = HashSet::new();

        loop {
            tokio::select! {
                _ = tick.tick() => {
                    for repo in &known_repos {
                        if let Err(e) = prune_old_recordings(repo) {
                            tracing::warn!(
                                sensor = SUBSTRATE_SENSOR_NAME,
                                repo   = %repo.display(),
                                error  = %e,
                                "retention sweep error",
                            );
                        }
                    }
                }
                ev = bus_rx.recv_async() => {
                    match ev {
                        Ok(DaemonEvent::FsChange { path, .. }) => {
                            // Cheap heuristic: register every repo
                            // root we observe via FsChange's path
                            // by walking up to the recordings dir
                            // ancestor. Misses repos that have NEVER
                            // had a save event, but those have no
                            // recordings to prune anyway.
                            if let Some(repo_root) = repo_root_of_path(Path::new(&path)) {
                                known_repos.insert(repo_root);
                            }
                        }
                        Ok(DaemonEvent::Shutdown) => break,
                        Ok(_)  => continue,
                        Err(_) => break,
                    }
                }
            }
        }
    })
}

/// Walk up from `change_path` to find the repo root (the directory
/// that contains a `.inari` subdir). Returns `None` if no ancestor
/// has it. Used by the retention task to discover repos we should
/// sweep.
fn repo_root_of_path(change_path: &Path) -> Option<PathBuf> {
    let mut cursor = change_path.parent()?;
    loop {
        if cursor.join(".inari").is_dir() {
            return Some(cursor.to_path_buf());
        }
        cursor = cursor.parent()?;
    }
}

/// Strip a [`DivergenceSummary`] down to the JSON payload the events
/// table records. Today this is the same shape that goes on the bus —
/// kept as a function so future-us can easily diverge them (e.g. add
/// a debug field that only appears in SQL but not in IPC).
fn summarize_divergence(d: &DivergenceSummary) -> serde_json::Value {
    serde_json::json!({
        "kind":            d.kind,
        "affected_module": d.affected_module,
        "severity":        d.severity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_source_file_recognises_supported_languages() {
        for ok in [
            "src/handler.ts", "Web/Page.tsx", "lib/index.js", "App.jsx",
            "esm/mod.mjs", "cjs/legacy.cjs", "src/main.rs", "cmd/main.go", "main.py",
        ] {
            assert!(is_source_file(ok), "expected {ok} to count");
        }
        for nope in [
            "README.md", "package.json", "Cargo.toml",
            "src/style.css", "image.png", "noext",
        ] {
            assert!(!is_source_file(nope), "expected {nope} to be filtered");
        }
    }

    #[test]
    fn find_recent_recording_returns_none_when_no_root() {
        let dir = tempfile::tempdir().unwrap();
        // Recordings root doesn't exist — should be Ok(None).
        let out = find_recent_recording(&dir.path().join("none"), Duration::from_secs(60)).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn find_recent_recording_picks_newest_inside_window() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("recordings");
        std::fs::create_dir_all(&root).unwrap();

        // Three subdirs; the test uses sleep + write to set mtimes
        // monotonically increasing (no need for filetime crate).
        for name in &["older", "newer"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("event.json"), b"{}").unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }

        let picked = find_recent_recording(&root, Duration::from_secs(60))
            .unwrap()
            .expect("recording present");
        assert_eq!(picked.file_name().unwrap(), "newer");
    }

    #[test]
    fn find_recent_recording_skips_when_too_old() {
        // Window of 0ms means even the newest dir is outside the window.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("recordings");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir(root.join("only")).unwrap();
        std::fs::write(root.join("only").join("e.json"), b"{}").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let picked = find_recent_recording(&root, Duration::from_millis(1)).unwrap();
        assert!(picked.is_none());
    }

    #[test]
    fn repo_root_of_path_finds_inari_marker() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".inari")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let root = repo_root_of_path(&repo.join("src/handler.ts"));
        assert_eq!(root, Some(repo));
    }
}
