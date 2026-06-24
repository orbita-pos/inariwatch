//! User memory IPC — the Tauri command surface for the Jarvis-layer
//! personal memory system.
//!
//! Commands:
//!   - `user_memory_list`    — all non-expired facts
//!   - `user_memory_upsert`  — add or update a fact (dedup by type+content)
//!   - `user_memory_delete`  — remove one fact by id
//!   - `user_memory_wipe`    — clear all facts (Settings → "Clear memory")
//!   - `user_memory_rendered`— render facts to a markdown profile string
//!   - `user_memory_extract` — extract facts from a user chat message
//!     (rule-based, < 1ms, called fire-and-forget from chat-stream.ts)

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::store::memory_facts::{self, FactRow, FactSource, FactType, UpsertFact};
use crate::store::Store;
use crate::memory::user_profile;

use super::error::IpcError;

// ── DTOs ──────────────────────────────────────────────────────────────

pub use crate::store::memory_facts::{FactRow as MemoryFactDto};

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct UpsertFactInput {
    pub fact_type:  FactType,
    pub content:    String,
    pub confidence: f64,
    pub source:     FactSource,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct MemoryStats {
    pub total_facts:    i64,
    pub by_identity:    usize,
    pub by_preference:  usize,
    pub by_pattern:     usize,
    pub by_context:     usize,
    pub by_skill:       usize,
}

// ── Commands ──────────────────────────────────────────────────────────

/// All non-expired facts ordered by type, then recency.
#[tauri::command]
pub fn user_memory_list(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<Vec<FactRow>, IpcError> {
    memory_facts::list_all(&state).map_err(IpcError::from)
}

/// Insert or update a fact. Dedup key = (fact_type, trimmed content).
#[tauri::command]
pub fn user_memory_upsert(
    state: tauri::State<'_, Arc<Store>>,
    input: UpsertFactInput,
) -> Result<FactRow, IpcError> {
    let fact = UpsertFact {
        fact_type:  input.fact_type,
        content:    input.content,
        confidence: input.confidence.clamp(0.0, 1.0),
        source:     input.source,
        expires_at: input.expires_at,
    };
    memory_facts::upsert(&state, &fact).map_err(IpcError::from)
}

/// Delete one fact by id.
#[tauri::command]
pub fn user_memory_delete(
    state: tauri::State<'_, Arc<Store>>,
    id:    i64,
) -> Result<bool, IpcError> {
    memory_facts::delete(&state, id).map_err(IpcError::from)
}

/// Wipe all facts. Irreversible.
#[tauri::command]
pub fn user_memory_wipe(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<usize, IpcError> {
    memory_facts::delete_all(&state).map_err(IpcError::from)
}

/// Render all facts to a markdown profile string.
/// Returns `None` when there are no facts yet.
#[tauri::command]
pub fn user_memory_rendered(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<Option<String>, IpcError> {
    let facts = memory_facts::list_all(&state).map_err(IpcError::from)?;
    Ok(user_profile::render(&facts))
}

/// Extract facts from a user chat message (rule-based, synchronous).
/// Persists any extracted facts and returns the new/updated rows.
/// Called fire-and-forget from `chat-stream.ts` after each user turn.
#[tauri::command]
pub fn user_memory_extract(
    state:   tauri::State<'_, Arc<Store>>,
    message: String,
) -> Result<Vec<FactRow>, IpcError> {
    let candidates = user_profile::extract_from_message(&message);
    let mut results = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        match memory_facts::upsert(&state, &candidate) {
            Ok(row)  => results.push(row),
            Err(err) => tracing::warn!(error = %err, "memory_facts upsert failed"),
        }
    }
    Ok(results)
}

/// Stats snapshot for the Settings panel.
#[tauri::command]
pub fn user_memory_stats(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<MemoryStats, IpcError> {
    let facts = memory_facts::list_all(&state).map_err(IpcError::from)?;
    let total = memory_facts::count(&state).map_err(IpcError::from)?;
    Ok(MemoryStats {
        total_facts:   total,
        by_identity:   facts.iter().filter(|f| f.fact_type == FactType::Identity).count(),
        by_preference: facts.iter().filter(|f| f.fact_type == FactType::Preference).count(),
        by_pattern:    facts.iter().filter(|f| f.fact_type == FactType::Pattern).count(),
        by_context:    facts.iter().filter(|f| f.fact_type == FactType::Context).count(),
        by_skill:      facts.iter().filter(|f| f.fact_type == FactType::Skill).count(),
    })
}
