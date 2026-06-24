//! Indexer (Session 6).
//!
//! Subscribes to the daemon bus and consumes:
//!   * [`crate::daemon::DaemonEvent::RepoIndexed`] — after the FS
//!     sensor's initial walk lands, the indexer bootstraps embeddings
//!     for every supported file.
//!   * [`crate::daemon::DaemonEvent::FsChange`] — incremental
//!     re-index of one file (Created / Modified / Deleted / Renamed).
//!   * [`crate::daemon::DaemonEvent::ReindexRequested`] — published
//!     by the MCP `reindex_codebase` tool.
//!
//! Emits [`crate::daemon::DaemonEvent::SymbolsIndexed`] on the bus
//! after every bootstrap completes.
//!
//! Architectural choice (Decision: re-walk vs path cache, see
//! `INARI_LIVE_DECISIONS.md`): the bootstrap path re-walks the repo
//! using the same `ignore::WalkBuilder` config as the FS sensor.
//! Paying the IO twice is acceptable (the walk is fast — ~150ms for a
//! 5k-file repo) and removes a coupling between the two sensors.
//!
//! All embedder calls run on `tokio::task::spawn_blocking` so the
//! event-bus consumer stays responsive.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::async_runtime::JoinHandle;

use crate::daemon::{DaemonEvent, DaemonHandle, FsChangeKind};
use crate::store::{queries, Store};

pub mod batcher;
pub mod embeddings;
pub mod error;
pub mod lang;
pub mod parser;
pub mod semantic;

pub use embeddings::{set_cache_dir, EMBEDDING_DIM};
pub use error::{IndexerError, Result};
pub use lang::{detect_from_path, Lang};
pub use parser::{compute_ast_hash, parse_file, Symbol, SymbolKind};
pub use semantic::{search, Hit, MAX_K};

/// Label used for `SensorWarning.sensor` and structured logging.
pub const INDEXER_NAME: &str = "indexer";

/// Spawn the indexer task on the current tokio runtime. Increments
/// the daemon `sensor_count` so the dock's "Sensors: N" counter
/// includes the indexer in its tally. The returned handle keeps the
/// task alive — drop it (or `Shutdown` on the bus) to stop.
pub fn spawn_indexer(
    daemon: Arc<DaemonHandle>,
    store:  Arc<Store>,
) -> JoinHandle<()> {
    daemon.state.inc_sensors();
    let bus_rx       = daemon.bus.subscribe();
    let bus_pub      = daemon.bus.clone();
    let state_handle = daemon.state.clone();

    tauri::async_runtime::spawn(async move {
        tracing::info!(sensor = INDEXER_NAME, "indexer started");
        loop {
            let ev = match bus_rx.recv_async().await {
                Ok(e)  => e,
                Err(_) => break,
            };
            match ev {
                DaemonEvent::Shutdown => {
                    tracing::info!(sensor = INDEXER_NAME, "shutdown observed");
                    break;
                }
                DaemonEvent::RepoIndexed { repo_id, .. } => {
                    handle_bootstrap(&store, &bus_pub, repo_id).await;
                }
                DaemonEvent::ReindexRequested { repo_id } => {
                    handle_bootstrap(&store, &bus_pub, repo_id).await;
                }
                DaemonEvent::FsChange { repo_id, path, kind } => {
                    handle_fs_change(&store, repo_id, path, kind).await;
                }
                _ => {}
            }
        }
        state_handle.dec_sensors();
        tracing::info!(sensor = INDEXER_NAME, "indexer stopped");
    })
}

async fn handle_bootstrap(
    store:   &Arc<Store>,
    bus_pub: &crate::daemon::EventBus,
    repo_id: String,
) {
    let store_clone = store.clone();
    let repo_id_for_task = repo_id.clone();
    let result = tokio::task::spawn_blocking(move || -> error::Result<batcher::BootstrapResult> {
        let repo_path = match queries::find_repo_path_by_id(&store_clone, &repo_id_for_task)? {
            Some(p) => p,
            None    => {
                return Err(IndexerError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("repo not registered: {repo_id_for_task}"),
                )));
            }
        };
        batcher::bootstrap_repo(&store_clone, &repo_id_for_task, Path::new(&repo_path))
    })
    .await;

    match result {
        Ok(Ok(out)) => {
            tracing::info!(
                sensor       = INDEXER_NAME,
                repo_id      = %repo_id,
                symbol_count = out.symbol_count,
                duration_ms  = out.duration_ms,
                "bootstrap complete"
            );
            bus_pub.publish(DaemonEvent::SymbolsIndexed {
                repo_id,
                symbol_count: out.symbol_count,
                duration_ms:  out.duration_ms,
            });
        }
        Ok(Err(e)) => {
            tracing::warn!(sensor = INDEXER_NAME, repo_id = %repo_id, error = %e, "bootstrap failed");
            // Surface the model-load failure mode specifically — the
            // dock can prompt for an internet connection.
            if matches!(e, IndexerError::ModelLoad(_)) {
                bus_pub.publish(DaemonEvent::SensorWarning {
                    sensor:  INDEXER_NAME.to_string(),
                    message: format!("indexer running in degraded mode (no embeddings): {e}"),
                });
            }
        }
        Err(join_err) => {
            tracing::warn!(sensor = INDEXER_NAME, error = %join_err, "bootstrap task panicked");
        }
    }
}

async fn handle_fs_change(
    store:   &Arc<Store>,
    repo_id: String,
    path:    String,
    kind:    FsChangeKind,
) {
    let store_clone = store.clone();
    let repo_id_for_task = repo_id.clone();
    let path_for_task    = path.clone();
    let kind_for_task    = kind.clone();
    let result = tokio::task::spawn_blocking(move || -> error::Result<()> {
        let repo_root = match queries::find_repo_path_by_id(&store_clone, &repo_id_for_task)? {
            Some(p) => PathBuf::from(p),
            None    => return Ok(()), // repo unknown — drop event
        };
        let abs_path = PathBuf::from(&path_for_task);
        match kind_for_task {
            FsChangeKind::Created | FsChangeKind::Modified => {
                let _ = batcher::reindex_file(&store_clone, &repo_id_for_task, &repo_root, &abs_path)?;
            }
            FsChangeKind::Deleted => {
                let _ = batcher::delete_file(&store_clone, &repo_id_for_task, &repo_root, &abs_path)?;
            }
            FsChangeKind::Renamed { from } => {
                // Best effort: update file_path; the indexer doesn't
                // know whether content changed yet so it queues a
                // re-parse afterwards.
                let from_rel = from.strip_prefix(&repo_root).unwrap_or(&from)
                    .to_string_lossy()
                    .replace('\\', "/");
                let to_rel = abs_path.strip_prefix(&repo_root).unwrap_or(&abs_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let _ = queries::rename_file_path(&store_clone, &repo_id_for_task, &from_rel, &to_rel)?;
                let _ = batcher::reindex_file(&store_clone, &repo_id_for_task, &repo_root, &abs_path)?;
            }
        }
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(()))  => {}
        Ok(Err(e))  => tracing::debug!(sensor = INDEXER_NAME, repo_id = %repo_id, path = %path, error = %e, "fs_change skipped"),
        Err(j)      => tracing::warn!(sensor = INDEXER_NAME, error = %j, "fs_change task panicked"),
    }
}
