//! Session 11 — Tauri commands for the declarative memory layer.
//!
//! Five commands surface `memory.md` lifecycle to the dock:
//!
//! | Command                    | Purpose                                        |
//! |----------------------------|------------------------------------------------|
//! | `read_memory_md`           | Return the on-disk `memory.md` for a repo      |
//! | `propose_memory_md_update` | Persist an AI proposal + emit a review request |
//! | `commit_memory_md`         | Approve a proposal — write disk + record merge |
//! | `get_context_stack`        | Build the precedence stack for a repo          |
//! | `wipe_memory`              | Drop the SQL audit trail (file kept on disk)   |
//!
//! Heavy-data IPC rule still applies: `memory.md` is capped at 1 MB by
//! [`crate::memory::declarative::MAX_MEMORY_MD_BYTES`]; the precedence
//! gather caps at [`crate::memory::declarative::precedence::MAX_TOTAL_BYTES`].

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::daemon::{DaemonEvent, DaemonHandle, MemoryKind};
use crate::memory::declarative::{
    self, atomic_write, latest_memory_version_row, memory_md_path, record_memory_version,
    wipe_memory_versions, MAX_MEMORY_MD_BYTES,
};
use crate::memory::declarative::precedence::{ContextLayer, ContextStack};
use crate::memory::MemoryError;
use crate::store::{queries, Store};

use super::error::IpcError;

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct MemoryMdDto {
    pub content:    String,
    /// Bytes on disk at read time. Cheap consistency check for the UI.
    pub size_bytes: u64,
    /// Provenance of the latest persisted version (`ai`, `merge`, …),
    /// or `None` when no version row exists yet.
    pub written_by: Option<String>,
    pub written_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct ContextLayerDto {
    pub kind:       String,
    pub byte_size:  usize,
    pub preview:    String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct ContextStackDto {
    pub layers:      Vec<ContextLayerDto>,
    pub total_bytes: usize,
    pub truncated:   bool,
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Resolve the on-disk path of an opened repo. Same lookup the indexer
/// uses; centralized here so memory commands report `RepoNotFound`
/// consistently with the rest of the IPC surface.
fn resolve_repo_path(store: &Store, repo_id: &str) -> Result<PathBuf, IpcError> {
    match queries::find_repo_path_by_id(store, repo_id)? {
        Some(p) => Ok(PathBuf::from(p)),
        None    => Err(IpcError::RepoNotFound { id: repo_id.to_string() }),
    }
}

fn map_memory_err(err: MemoryError) -> IpcError {
    match err {
        MemoryError::Io(e)              => IpcError::Io { message: e.to_string() },
        MemoryError::Store(e)           => IpcError::from(e),
        MemoryError::Parse(msg)         => IpcError::Internal { message: format!("parse: {msg}") },
        MemoryError::PinnedProtected(s) => IpcError::Internal { message: format!("pinned: {s}") },
        MemoryError::ConcurrentWrite    => IpcError::Internal { message: "concurrent write".into() },
        MemoryError::TooLarge(n)        => IpcError::Internal { message: format!("memory.md exceeds 1MB cap (got {n} bytes)") },
        MemoryError::UnknownRepo(id)    => IpcError::RepoNotFound { id },
        MemoryError::Internal(msg)      => IpcError::Internal { message: msg },
    }
}

fn unix_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Return the current on-disk `memory.md` for `repo_id`. `Ok(None)`
/// when the file does not exist yet (fresh repo before the watcher
/// wrote the template). Augments with the latest persisted version's
/// provenance (`written_by`, `written_at`) when available.
#[tauri::command]
pub fn read_memory_md(
    store:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<Option<MemoryMdDto>, IpcError> {
    let store_inner = store.inner().as_ref();
    let repo_path   = resolve_repo_path(store_inner, &repo_id)?;
    let md_path     = memory_md_path(&repo_path);

    let bytes = match std::fs::metadata(&md_path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(IpcError::Io { message: e.to_string() }),
    };
    if bytes > MAX_MEMORY_MD_BYTES {
        return Err(IpcError::Internal {
            message: format!("memory.md exceeds 1MB cap (got {bytes} bytes)"),
        });
    }

    let content = std::fs::read_to_string(&md_path)
        .map_err(|e| IpcError::Io { message: e.to_string() })?;

    let row = latest_memory_version_row(store_inner, &repo_id).map_err(map_memory_err)?;
    let (written_by, written_at) = match row {
        Some(v) => (Some(v.written_by), Some(v.written_at)),
        None    => (None, None),
    };

    Ok(Some(MemoryMdDto {
        content,
        size_bytes: bytes,
        written_by,
        written_at,
    }))
}

/// Persist an AI-proposed update as a new version row and publish a
/// review request on the bus. The proposal does NOT write to disk —
/// `commit_memory_md` does that after the user approves.
#[tauri::command]
pub fn propose_memory_md_update(
    store:   tauri::State<'_, Arc<Store>>,
    daemon:  tauri::State<'_, Arc<DaemonHandle>>,
    repo_id: String,
    content: String,
    kind:    MemoryKind,
) -> Result<i64, IpcError> {
    if (content.len() as u64) > MAX_MEMORY_MD_BYTES {
        return Err(IpcError::Internal {
            message: format!(
                "proposal exceeds 1MB cap (got {} bytes)",
                content.len()
            ),
        });
    }

    let store_inner = store.inner().as_ref();
    // resolve_repo_path returns RepoNotFound when the id is unknown so
    // the dock can surface a clean error before we mutate any rows.
    let _ = resolve_repo_path(store_inner, &repo_id)?;

    let id = record_memory_version(store_inner, &repo_id, &content, "ai_proposed")
        .map_err(map_memory_err)?;

    daemon.bus.publish(DaemonEvent::MemoryReviewRequested {
        repo_id: repo_id.clone(),
        kind,
    });

    Ok(id)
}

/// Approve a proposal: atomic-write the new content to `memory.md`,
/// record a `merge` version row, and broadcast the approval so any
/// open dock surfaces refresh.
#[tauri::command]
pub fn commit_memory_md(
    store:   tauri::State<'_, Arc<Store>>,
    daemon:  tauri::State<'_, Arc<DaemonHandle>>,
    repo_id: String,
    content: String,
) -> Result<(), IpcError> {
    if (content.len() as u64) > MAX_MEMORY_MD_BYTES {
        return Err(IpcError::Internal {
            message: format!(
                "memory.md exceeds 1MB cap (got {} bytes)",
                content.len()
            ),
        });
    }

    let store_inner = store.inner().as_ref();
    let repo_path   = resolve_repo_path(store_inner, &repo_id)?;
    let md_path     = memory_md_path(&repo_path);

    atomic_write(&md_path, &content).map_err(map_memory_err)?;
    record_memory_version(store_inner, &repo_id, &content, "merge")
        .map_err(map_memory_err)?;

    daemon.bus.publish(DaemonEvent::MemoryReviewApproved {
        repo_id: repo_id.clone(),
        content: content.clone(),
    });

    Ok(())
}

/// Build the precedence context stack for a repo (CLAUDE.md → AGENTS.md
/// → .cursorrules → memory.md `[pinned]` → memory.md rest → patterns →
/// semantic). Returns DTO-shaped layers with previews so the dock can
/// render "what does Inari see for this repo?" without re-implementing
/// the gather rules in TS.
///
/// `_unused` reserves the per-query weighting hook for Session 12+ —
/// today the gather is query-agnostic.
#[tauri::command]
pub fn get_context_stack(
    store:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<ContextStackDto, IpcError> {
    let store_inner = store.inner().as_ref();
    let repo_path   = resolve_repo_path(store_inner, &repo_id)?;

    let memory_doc = match declarative::ensure_memory_md(&repo_path) {
        Ok(o)  => Some(o.doc),
        Err(_) => None,
    };
    let user_profile = crate::store::memory_facts::list_all(store_inner)
        .ok()
        .and_then(|facts| crate::memory::user_profile::render(&facts));
    let stack = declarative::gather_context("", &repo_path, memory_doc.as_ref(), user_profile);
    Ok(stack_to_dto(&stack))
}

/// Wipe the SQL audit trail for `repo_id`. The on-disk `memory.md` is
/// preserved (per the dock spec — humans curated it, the wipe only
/// drops Inari's history). Returns the number of rows actually removed.
#[tauri::command]
pub fn wipe_memory(
    store:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<usize, IpcError> {
    let store_inner = store.inner().as_ref();
    let _ = resolve_repo_path(store_inner, &repo_id)?;
    wipe_memory_versions(store_inner, &repo_id).map_err(map_memory_err)
}

// ── DTO conversion ───────────────────────────────────────────────────────────

const PREVIEW_MAX_BYTES: usize = 256;

fn stack_to_dto(stack: &ContextStack) -> ContextStackDto {
    let layers = stack
        .layers
        .iter()
        .map(layer_to_dto)
        .collect();
    ContextStackDto {
        layers,
        total_bytes: stack.total_bytes,
        truncated:   stack.truncated,
    }
}

fn layer_to_dto(layer: &ContextLayer) -> ContextLayerDto {
    let (kind, byte_size, preview) = match layer {
        ContextLayer::UserProfile  { content } => ("user_profile",  content.len(),       truncate(content)),
        ContextLayer::ClaudeMd     { content } => ("claude_md",     content.len(),       truncate(content)),
        ContextLayer::AgentsMd     { content } => ("agents_md",     content.len(),       truncate(content)),
        ContextLayer::CursorRules  { content } => ("cursorrules",   content.len(),       truncate(content)),
        ContextLayer::MemoryPinned { sections } => {
            let bytes: usize = sections.iter().map(|(h, b)| h.len() + b.len() + 4).sum();
            let preview = first_section_preview(sections);
            ("memory_pinned", bytes, preview)
        }
        ContextLayer::MemoryRest   { sections } => {
            let bytes: usize = sections.iter().map(|(h, b)| h.len() + b.len() + 4).sum();
            let preview = first_section_preview(sections);
            ("memory_rest", bytes, preview)
        }
        ContextLayer::PatternsJson { content } => ("patterns_json", content.len(),       truncate(content)),
        ContextLayer::SemanticHits { hits }    => {
            let bytes: usize = hits.iter().map(|h| h.len() + 1).sum();
            let preview = hits.first().cloned().unwrap_or_default();
            ("semantic_hits", bytes, truncate(&preview))
        }
    };
    ContextLayerDto { kind: kind.to_string(), byte_size, preview }
}

fn truncate(s: &str) -> String {
    if s.len() <= PREVIEW_MAX_BYTES {
        return s.to_string();
    }
    let mut end = PREVIEW_MAX_BYTES;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

fn first_section_preview(sections: &[(String, String)]) -> String {
    match sections.first() {
        Some((heading, body)) => truncate(&format!("## {heading}\n{body}")),
        None => String::new(),
    }
}

// silence the dead-code warning for now-unused helpers when commands
// that touch them are gated behind feature flags in future sessions
#[allow(dead_code)]
fn now_ms_for_tests() -> i64 {
    unix_now_ms()
}
