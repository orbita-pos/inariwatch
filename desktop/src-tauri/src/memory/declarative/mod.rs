//! Declarative memory layer - memory.md / memory.local.md lifecycle.

pub mod gitignore;
pub mod parser;
pub mod precedence;
pub mod template;
pub mod writer;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::daemon::{DaemonEvent, DaemonHandle, MemoryKind};
use crate::store::{queries, Store};

use super::error::{MemoryError, Result};

pub use gitignore::{augment_gitignore, GitignoreOutcome};
pub use parser::{MemoryDoc, Section, SectionMarker};
pub use precedence::{gather_context, ContextLayer, ContextStack, MAX_TOTAL_BYTES};
pub use template::TEMPLATE_VERSION;
pub use writer::{render as render_with_updates, MemoryDocDiff, SectionUpdate};

pub const MAX_MEMORY_MD_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct EnsureOutcome {
    pub doc: MemoryDoc,
    pub initial_write: bool,
    pub gitignore: GitignoreOutcome,
}

pub fn inari_dir(repo_path: &Path) -> PathBuf {
    repo_path.join(".inari")
}

pub fn memory_md_path(repo_path: &Path) -> PathBuf {
    inari_dir(repo_path).join("memory.md")
}

pub fn memory_local_md_path(repo_path: &Path) -> PathBuf {
    inari_dir(repo_path).join("memory.local.md")
}

pub fn ensure_memory_md(repo_path: &Path) -> Result<EnsureOutcome> {
    let inari = inari_dir(repo_path);
    std::fs::create_dir_all(&inari)?;

    let md_path = memory_md_path(repo_path);
    let local_path = memory_local_md_path(repo_path);

    let gitignore = augment_gitignore(repo_path)?;

    if md_path.exists() {
        let bytes = std::fs::metadata(&md_path)?.len();
        if bytes > MAX_MEMORY_MD_BYTES {
            return Err(MemoryError::TooLarge(bytes));
        }
        let raw = std::fs::read(&md_path)?;
        let text = String::from_utf8(raw)
            .map_err(|e| MemoryError::Parse(format!("memory.md is not valid UTF-8: {e}")))?;
        let doc = MemoryDoc::parse(text);
        Ok(EnsureOutcome { doc, initial_write: false, gitignore })
    } else {
        let content = template::render(repo_path);
        atomic_write(&md_path, &content)?;
        if !local_path.exists() {
            atomic_write(&local_path, "# memory.local.md\n\n_Local-only notes._\n")?;
        }
        let doc = MemoryDoc::parse(content);
        Ok(EnsureOutcome { doc, initial_write: true, gitignore })
    }
}

pub fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| MemoryError::Internal(format!("path has no parent: {}", path.display())))?;
    std::fs::create_dir_all(parent)?;
    // Append `.tmp` to the FULL existing filename (preserving any
    // extension) instead of `with_extension("md.tmp")` which would
    // clobber a non-md extension. `memory.md` → `memory.md.tmp` is
    // unchanged from the Sesión-11 behavior; `patterns.json` →
    // `patterns.json.tmp` is the Sesión-12 generalization so the
    // procedural learner can reuse this helper without forking it.
    let tmp_path = match path.extension().and_then(|s| s.to_str()) {
        Some(ext) => path.with_extension(format!("{ext}.tmp")),
        None      => path.with_extension("tmp"),
    };
    std::fs::write(&tmp_path, content)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

pub fn read_mtime_ms(path: &Path) -> Result<i64> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(MemoryError::Io(e)),
    };
    let mtime = meta
        .modified()
        .map_err(|e| MemoryError::Internal(format!("modified() unsupported: {e}")))?;
    let dur = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| MemoryError::Internal(format!("mtime before epoch: {e}")))?;
    Ok(dur.as_millis() as i64)
}

pub fn record_memory_version(
    store: &Store,
    repo_id: &str,
    content: &str,
    written_by: &str,
) -> Result<i64> {
    let now_ms = unix_now_ms();
    queries::insert_memory_md_version(store, repo_id, content, written_by, now_ms)
        .map_err(MemoryError::from)
}

pub fn latest_memory_version(store: &Store, repo_id: &str) -> Result<Option<String>> {
    queries::latest_memory_md_version(store, repo_id)
        .map(|opt| opt.map(|v| v.content))
        .map_err(MemoryError::from)
}

pub fn latest_memory_version_row(
    store: &Store,
    repo_id: &str,
) -> Result<Option<queries::MemoryMdVersion>> {
    queries::latest_memory_md_version(store, repo_id).map_err(MemoryError::from)
}

pub fn wipe_memory_versions(store: &Store, repo_id: &str) -> Result<usize> {
    queries::wipe_memory_md_versions(store, repo_id).map_err(MemoryError::from)
}

fn unix_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct MemoryWatcherHandle;

pub fn spawn_memory_watcher(daemon: Arc<DaemonHandle>, store: Arc<Store>) -> MemoryWatcherHandle {
    let bus = daemon.bus.clone();
    std::thread::Builder::new()
        .name("inari-memory-watcher".to_string())
        .spawn(move || run_watcher(bus, store))
        .expect("spawn memory watcher thread");
    MemoryWatcherHandle
}

fn run_watcher(bus: crate::daemon::EventBus, store: Arc<Store>) {
    let rx = bus.subscribe();
    tracing::info!("memory watcher started");

    loop {
        let event = match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(ev) => ev,
            Err(flume::RecvTimeoutError::Timeout) => continue,
            Err(flume::RecvTimeoutError::Disconnected) => break,
        };

        match event {
            DaemonEvent::Shutdown => {
                tracing::info!("memory watcher: Shutdown observed - exiting");
                break;
            }
            DaemonEvent::RepoIndexed { repo_id, .. } => {
                handle_repo_indexed(&bus, &store, &repo_id);
            }
            DaemonEvent::MemoryReviewApproved { repo_id, content } => {
                handle_review_approved(&store, &repo_id, &content);
            }
            _ => {}
        }
    }

    tracing::info!("memory watcher stopped");
}

fn handle_repo_indexed(bus: &crate::daemon::EventBus, store: &Arc<Store>, repo_id: &str) {
    let repo_path = match queries::find_repo_path_by_id(store, repo_id) {
        Ok(Some(p)) => PathBuf::from(p),
        Ok(None) => {
            tracing::warn!(repo_id, "memory watcher: repo path not found - skipping");
            return;
        }
        Err(e) => {
            tracing::warn!(repo_id, error = %e, "memory watcher: SQL lookup failed");
            return;
        }
    };

    let outcome = match ensure_memory_md(&repo_path) {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!(repo_id, error = %e, "memory watcher: ensure_memory_md failed");
            return;
        }
    };

    if outcome.initial_write {
        if let Err(e) = record_memory_version(store, repo_id, &outcome.doc.source, "ai") {
            tracing::warn!(repo_id, error = %e, "memory watcher: failed to persist initial version");
        }
        bus.publish(DaemonEvent::MemoryReviewRequested {
            repo_id: repo_id.to_string(),
            kind:    MemoryKind::Initial,
        });
        tracing::info!(repo_id, "memory watcher: wrote initial memory.md template");
    } else {
        tracing::info!(
            repo_id,
            sections = outcome.doc.sections.len(),
            "memory watcher: existing memory.md observed"
        );
    }
}

fn handle_review_approved(store: &Arc<Store>, repo_id: &str, content: &str) {
    if let Err(e) = record_memory_version(store, repo_id, content, "merge") {
        tracing::warn!(repo_id, error = %e, "memory watcher: failed to record approved version");
    } else {
        tracing::info!(repo_id, "memory watcher: recorded approved memory.md merge");
    }
}
