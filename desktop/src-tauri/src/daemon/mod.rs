//! Daemon core: event bus + lifecycle + shared state.
//!
//! This module is the ambient, tray-resident process that owns all
//! cross-sensor coordination. Sensors (Sessions 5-10) publish events to
//! [`bus::EventBus`]; the lifecycle task (this module) emits a
//! `Heartbeat` every 30s and handles graceful shutdown drain.
//!
//! Event taxonomy starts intentionally tiny (`Heartbeat` + `Shutdown`).
//! Sensors append their own variants in their own session — the
//! `non_exhaustive` attribute means downstream `match` arms must keep a
//! `_ =>` fallback so future variants don't break the build.

pub mod bus;
pub mod lifecycle;
pub mod state;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Classification of a single filesystem change reported by the FS sensor.
///
/// Lives under `daemon` so all consumers (sensors, IPC bridge, indexer,
/// remediator) can pattern-match without an `sensors::*` import. The
/// debouncer-mini we use only emits coarse Any/AnyContinuous categories
/// — the watcher classifies into [`Created`/`Modified`/`Deleted`] by
/// stat-checking the path post-debounce. [`Renamed`] is reserved for a
/// future debouncer-full upgrade or platform-specific event paths
/// (FSEvents on macOS already gives us the rename pair; we just don't
/// surface it in v0.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed { from: PathBuf },
}

/// Cross-sensor event broadcast on [`bus::EventBus`].
///
/// Initial variants are minimal by design — each sensor session adds its
/// own variant when it lands. `#[non_exhaustive]` forces consumers to
/// handle the unknown-variant case so adding events is non-breaking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum DaemonEvent {
    /// Liveness signal emitted every 30s by the lifecycle task.
    Heartbeat { uptime_secs: u64 },
    /// Cooperative shutdown signal. Sensors drain remaining work and exit.
    Shutdown,
    /// Initial walk of an attached repo finished. `file_count` excludes
    /// directories and entries the walker filtered via `.gitignore` /
    /// `.git/info/exclude` / global git ignore. `duration_ms` is wall
    /// clock for the walk on the rayon thread pool.
    RepoIndexed {
        repo_id:     String,
        file_count:  u64,
        duration_ms: u64,
    },
    /// A debounced filesystem change. `path` is canonicalized relative
    /// to the repo when the file still exists, otherwise it's whatever
    /// path the kernel gave us at delete-time (notify reports the path
    /// that was being watched).
    ///
    /// Field-level `#[serde(rename = "change")]` on `kind` is a serde
    /// requirement: the outer enum is internally-tagged on `"kind"`,
    /// and serde rejects a variant field of the same name. The Rust
    /// API keeps `kind` per Session-5 spec; the JSON wire field is
    /// `change` instead — see `INARI_LIVE_DECISIONS.md` 2026-04-29
    /// "Sesión 5 — DaemonEvent::FsChange field rename".
    FsChange {
        repo_id: String,
        path:    String,
        #[serde(rename = "change")]
        kind:    FsChangeKind,
    },
    /// Non-fatal sensor degradation. Carries a sensor name + a
    /// human-readable hint. Surfaced in the dock as a Nivel 1 toast,
    /// never crashes. Today emitted by the FS sensor on inotify
    /// limit hits (Linux ENOSPC / EMFILE).
    SensorWarning {
        sensor:  String,
        message: String,
    },
    /// Manual reindex request. Published by the MCP `reindex_codebase`
    /// tool (Session 7) and consumed by the indexer (Session 6). The
    /// indexer re-walks the repo, re-parses, and re-embeds — see
    /// `crate::indexer::spawn_indexer` for the consumer side.
    ReindexRequested { repo_id: String },
    /// Indexer finished a batch (initial bootstrap or manual reindex).
    /// `symbol_count` is the number of `code_symbols` rows that exist
    /// for this repo after the run; `duration_ms` is wall-clock for
    /// the entire bootstrap (including parse + embed + DB upsert).
    SymbolsIndexed {
        repo_id:      String,
        symbol_count: u64,
        duration_ms:  u64,
    },
}

pub use bus::EventBus;
pub use lifecycle::{start_daemon, DaemonHandle};
pub use state::{DaemonStatus, SharedDaemonState};
