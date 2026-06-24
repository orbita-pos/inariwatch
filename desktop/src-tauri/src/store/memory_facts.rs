//! Typed CRUD layer for the `memory_facts` table.
//!
//! Facts are the structured knowledge store behind the user-memory system.
//! The renderer in `memory::user_profile` reads these and produces the
//! markdown string injected as Layer 0 in the context stack.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::error::Result;
use super::Store;

// ── Types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/types/")]
pub enum FactType {
    Identity,
    Preference,
    Pattern,
    Context,
    Skill,
}

impl FactType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FactType::Identity   => "identity",
            FactType::Preference => "preference",
            FactType::Pattern    => "pattern",
            FactType::Context    => "context",
            FactType::Skill      => "skill",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "identity"   => Some(FactType::Identity),
            "preference" => Some(FactType::Preference),
            "pattern"    => Some(FactType::Pattern),
            "context"    => Some(FactType::Context),
            "skill"      => Some(FactType::Skill),
            _            => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/types/")]
pub enum FactSource {
    Explicit,
    Inferred,
    Observed,
}

impl FactSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            FactSource::Explicit  => "explicit",
            FactSource::Inferred  => "inferred",
            FactSource::Observed  => "observed",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "explicit"  => Some(FactSource::Explicit),
            "inferred"  => Some(FactSource::Inferred),
            "observed"  => Some(FactSource::Observed),
            _           => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct FactRow {
    pub id:           i64,
    pub fact_type:    FactType,
    pub content:      String,
    pub confidence:   f64,
    pub source:       FactSource,
    pub created_at:   i64,
    pub last_seen_at: i64,
    pub expires_at:   Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertFact {
    pub fact_type:  FactType,
    pub content:    String,
    pub confidence: f64,
    pub source:     FactSource,
    /// None = permanent.
    pub expires_at: Option<i64>,
}

// ── Helpers ──────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FactRow> {
    let type_str: String  = row.get(1)?;
    let src_str:  String  = row.get(4)?;
    Ok(FactRow {
        id:           row.get(0)?,
        fact_type:    FactType::from_str(&type_str).unwrap_or(FactType::Context),
        content:      row.get(2)?,
        confidence:   row.get(3)?,
        source:       FactSource::from_str(&src_str).unwrap_or(FactSource::Explicit),
        created_at:   row.get(5)?,
        last_seen_at: row.get(6)?,
        expires_at:   row.get(7)?,
    })
}

// ── Public API ───────────────────────────────────────────────────────

/// Insert or update a fact. Dedup key = (fact_type, trimmed content).
/// If an identical (type, content) already exists it just bumps
/// `last_seen_at` and updates `confidence`. Otherwise inserts a new row.
pub fn upsert(store: &Store, input: &UpsertFact) -> Result<FactRow> {
    let now = now_ms();
    let content = input.content.trim().to_string();
    let type_str = input.fact_type.as_str();
    let src_str  = input.source.as_str();

    let conn = store.conn()?;

    let existing_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM memory_facts WHERE fact_type = ?1 AND content = ?2",
            params![type_str, content],
            |r| r.get(0),
        )
        .optional()?;

    if let Some(id) = existing_id {
        conn.execute(
            "UPDATE memory_facts SET confidence = ?1, last_seen_at = ?2, expires_at = ?3 WHERE id = ?4",
            params![input.confidence, now, input.expires_at, id],
        )?;
    } else {
        conn.execute(
            "INSERT INTO memory_facts
             (fact_type, content, confidence, source, created_at, last_seen_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                type_str, content, input.confidence, src_str,
                now, now, input.expires_at
            ],
        )?;
    }

    let id: i64 = conn.query_row(
        "SELECT id FROM memory_facts WHERE fact_type = ?1 AND content = ?2",
        params![type_str, content],
        |r| r.get(0),
    )?;

    get_by_id(store, id)?.ok_or_else(|| super::error::StoreError::Sqlite(
        rusqlite::Error::QueryReturnedNoRows
    ))
}

/// Fetch a single fact by id.
pub fn get_by_id(store: &Store, id: i64) -> Result<Option<FactRow>> {
    let conn = store.conn()?;
    conn.query_row(
        "SELECT id, fact_type, content, confidence, source, created_at, last_seen_at, expires_at
         FROM memory_facts WHERE id = ?1",
        params![id],
        row_from_row,
    )
    .optional()
    .map_err(Into::into)
}

/// All non-expired facts ordered by type then last_seen DESC.
pub fn list_all(store: &Store) -> Result<Vec<FactRow>> {
    let now = now_ms();
    let conn = store.conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, fact_type, content, confidence, source, created_at, last_seen_at, expires_at
         FROM memory_facts
         WHERE expires_at IS NULL OR expires_at > ?1
         ORDER BY fact_type, last_seen_at DESC",
    )?;
    let rows = stmt.query_map(params![now], row_from_row)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

/// Delete a fact by id. Returns true if a row was removed.
pub fn delete(store: &Store, id: i64) -> Result<bool> {
    let conn = store.conn()?;
    let n = conn.execute("DELETE FROM memory_facts WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

/// Delete all facts. Used by the "Clear memory" action in Settings.
pub fn delete_all(store: &Store) -> Result<usize> {
    let conn = store.conn()?;
    let n = conn.execute("DELETE FROM memory_facts", [])?;
    Ok(n)
}

/// Count of all non-expired facts.
pub fn count(store: &Store) -> Result<i64> {
    let now = now_ms();
    let conn = store.conn()?;
    conn.query_row(
        "SELECT COUNT(*) FROM memory_facts WHERE expires_at IS NULL OR expires_at > ?1",
        params![now],
        |r| r.get(0),
    )
    .map_err(Into::into)
}
