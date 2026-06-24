//! SQLite storage for `pending_pairings` + `paired_entities`.
//!
//! Schema lives in migration `0012_pairing.sql`. Tests use
//! [`PairingStore::ensure_schema`] for in-memory pools the same way
//! [`crate::agent::audit::AuditLog::ensure_schema`] does.
//!
//! ## Concurrency
//!
//! All writes go through `BEGIN IMMEDIATE` transactions so two simultaneous
//! `generate` calls on the same workspace serialise on the SQLite write
//! lock — the 3-pending-max enforcement runs inside that transaction so
//! we can't race past the cap. Reads use a fresh pooled connection
//! without explicit locking; SQLite's WAL gives us readers-during-writer
//! consistency for free.
//!
//! ## Time
//!
//! All timestamps are unix epoch milliseconds. The store accepts a
//! [`Clock`] so tests can pin time for TTL assertions without sleeping.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use uuid::Uuid;

use crate::store::SqlitePool;

use super::code::PairingCode;

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("sqlite: {0}")]
    Sql(String),
    #[error("pool: {0}")]
    Pool(String),
    #[error("decode: {0}")]
    Decode(String),
}

impl StorageError {
    fn sql(e: rusqlite::Error) -> Self {
        Self::Sql(e.to_string())
    }
    fn pool(e: r2d2::Error) -> Self {
        Self::Pool(e.to_string())
    }
}

// ── Domain types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityKind {
    Phone,
    Device,
}

impl EntityKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EntityKind::Phone => "phone",
            EntityKind::Device => "device",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "phone" => Some(EntityKind::Phone),
            "device" => Some(EntityKind::Device),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPairing {
    pub id: Uuid,
    pub code: PairingCode,
    pub kind: EntityKind,
    pub workspace_id: Uuid,
    pub initiator: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedEntity {
    pub id: Uuid,
    pub kind: EntityKind,
    pub display_name: String,
    /// E.164 phone (with leading `+`) for `Phone`; base58 device pubkey
    /// for `Device`. Free-form below the storage layer — both consumers
    /// (messenger adapters, S12 mobile pairing) round-trip the column
    /// without further parsing.
    pub identifier: String,
    pub workspace_id: Uuid,
    pub paired_at_ms: i64,
    pub last_seen_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
}

// ── Clock seam ──────────────────────────────────────────────────────────────

pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> i64;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

#[cfg(any(test, feature = "agent-test-utils"))]
pub mod test_clock {
    use super::Clock;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// Test clock that advances on demand. Use [`Self::set`] to pin time
    /// at a specific epoch ms; [`Self::advance`] for relative jumps.
    pub struct TestClock {
        now: AtomicI64,
    }

    impl TestClock {
        pub fn new(now_ms: i64) -> Self {
            Self {
                now: AtomicI64::new(now_ms),
            }
        }

        pub fn set(&self, now_ms: i64) {
            self.now.store(now_ms, Ordering::SeqCst);
        }

        pub fn advance(&self, delta_ms: i64) {
            self.now.fetch_add(delta_ms, Ordering::SeqCst);
        }
    }

    impl Clock for TestClock {
        fn now_ms(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
    }
}

// ── Constants ───────────────────────────────────────────────────────────────

/// Hard expiry for a pending code.
pub const PENDING_TTL_MS: i64 = 60 * 60 * 1000;

/// At most this many pending rows per workspace. The 4th `generate`
/// invalidates the oldest.
pub const MAX_PENDING_PER_WORKSPACE: usize = 3;

// ── Store ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct PairingStore {
    pool: SqlitePool,
    clock: Arc<dyn Clock>,
}

impl PairingStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            clock: Arc::new(SystemClock),
        }
    }

    pub fn with_clock(pool: SqlitePool, clock: Arc<dyn Clock>) -> Self {
        Self { pool, clock }
    }

    /// Apply the schema in-process (test convenience). Idempotent. Safe
    /// to call after the migrator has already run — `CREATE TABLE IF NOT
    /// EXISTS` covers it.
    pub fn ensure_schema(&self) -> Result<(), StorageError> {
        let conn = self.pool.get().map_err(StorageError::pool)?;
        conn.execute_batch(include_str!("../store/migrations/0012_pairing.sql"))
            .map_err(StorageError::sql)?;
        Ok(())
    }

    /// Insert a fresh pending row. Caller is responsible for code
    /// uniqueness (random Crockford collisions are vanishingly rare,
    /// but the UNIQUE constraint catches the impossible case). Enforces
    /// the 3-pending cap by evicting the oldest pending row when the
    /// cap is hit, all inside one IMMEDIATE transaction.
    pub fn insert_pending(
        &self,
        kind: EntityKind,
        workspace_id: Uuid,
        initiator: &str,
        code: &PairingCode,
    ) -> Result<PendingPairing, StorageError> {
        let id = Uuid::new_v4();
        let now = self.clock.now_ms();
        let expires_at = now + PENDING_TTL_MS;

        let mut conn = self.pool.get().map_err(StorageError::pool)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(StorageError::sql)?;

        // Evict expired rows for this workspace (best-effort cleanup
        // every time we mutate). Reduces the noise that the
        // 3-pending cap sees.
        tx.execute(
            "DELETE FROM pending_pairings
             WHERE workspace_id = ?1 AND expires_at_ms <= ?2",
            params![workspace_id.simple().to_string(), now],
        )
        .map_err(StorageError::sql)?;

        // Enforce the cap: if we're already at `MAX_PENDING_PER_WORKSPACE`,
        // evict the oldest by `created_at_ms`. Doing it in two SQL
        // statements keeps this readable; the IMMEDIATE tx serialises us.
        let active: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM pending_pairings WHERE workspace_id = ?1",
                params![workspace_id.simple().to_string()],
                |row| row.get(0),
            )
            .map_err(StorageError::sql)?;

        if active as usize >= MAX_PENDING_PER_WORKSPACE {
            // Evict only enough rows to make room — usually 1, but if
            // we're called after a manual DB tweak with N over-cap rows
            // we still land at MAX_PENDING_PER_WORKSPACE - 1 rows post-evict.
            let to_evict = (active as usize - MAX_PENDING_PER_WORKSPACE) + 1;
            tx.execute(
                "DELETE FROM pending_pairings
                 WHERE id IN (
                     SELECT id FROM pending_pairings
                     WHERE workspace_id = ?1
                     ORDER BY created_at_ms ASC
                     LIMIT ?2
                 )",
                params![workspace_id.simple().to_string(), to_evict as i64],
            )
            .map_err(StorageError::sql)?;
        }

        tx.execute(
            "INSERT INTO pending_pairings
                 (id, code, kind, workspace_id, initiator, created_at_ms, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id.simple().to_string(),
                code.as_str(),
                kind.as_str(),
                workspace_id.simple().to_string(),
                initiator,
                now,
                expires_at,
            ],
        )
        .map_err(StorageError::sql)?;

        tx.commit().map_err(StorageError::sql)?;

        Ok(PendingPairing {
            id,
            code: code.clone(),
            kind,
            workspace_id,
            initiator: initiator.to_string(),
            created_at_ms: now,
            expires_at_ms: expires_at,
        })
    }

    /// Look up a pending row by code. Returns `Ok(None)` when the code
    /// is unknown OR has expired (callers don't need to distinguish in
    /// the redeem path — both yield "not found").
    pub fn lookup_pending_active(
        &self,
        code: &PairingCode,
    ) -> Result<Option<PendingPairing>, StorageError> {
        let now = self.clock.now_ms();
        let conn = self.pool.get().map_err(StorageError::pool)?;
        let row = conn.query_row(
            "SELECT id, code, kind, workspace_id, initiator, created_at_ms, expires_at_ms
             FROM pending_pairings
             WHERE code = ?1 AND expires_at_ms > ?2",
            params![code.as_str(), now],
            row_to_pending,
        );
        match row {
            Ok(p) => Ok(Some(p)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::sql(e)),
        }
    }

    /// Delete a pending row (after consuming or explicit reject). No-op
    /// if the row was already evicted by TTL or cap.
    pub fn delete_pending(&self, id: Uuid) -> Result<(), StorageError> {
        let conn = self.pool.get().map_err(StorageError::pool)?;
        conn.execute(
            "DELETE FROM pending_pairings WHERE id = ?1",
            params![id.simple().to_string()],
        )
        .map_err(StorageError::sql)?;
        Ok(())
    }

    /// Insert a paired-entity row. Caller has already executed the
    /// SAS-confirm flow and consumed the matching pending row (callers
    /// usually delete the pending row in the same logical operation —
    /// but we don't tie that into a single tx here because the pending
    /// row may not exist if the test path bypasses generate/redeem).
    pub fn insert_paired(
        &self,
        kind: EntityKind,
        display_name: &str,
        identifier: &str,
        workspace_id: Uuid,
    ) -> Result<PairedEntity, StorageError> {
        let id = Uuid::new_v4();
        let now = self.clock.now_ms();
        let conn = self.pool.get().map_err(StorageError::pool)?;
        conn.execute(
            "INSERT INTO paired_entities
                 (id, kind, display_name, identifier, workspace_id,
                  paired_at_ms, last_seen_at_ms, revoked_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL)",
            params![
                id.simple().to_string(),
                kind.as_str(),
                display_name,
                identifier,
                workspace_id.simple().to_string(),
                now,
            ],
        )
        .map_err(StorageError::sql)?;

        Ok(PairedEntity {
            id,
            kind,
            display_name: display_name.to_string(),
            identifier: identifier.to_string(),
            workspace_id,
            paired_at_ms: now,
            last_seen_at_ms: now,
            revoked_at_ms: None,
        })
    }

    /// Look up an active (non-revoked) paired entity by `(workspace,
    /// kind, identifier)`. The hot path on every inbound DM.
    pub fn lookup_paired_active(
        &self,
        workspace_id: Uuid,
        kind: EntityKind,
        identifier: &str,
    ) -> Result<Option<PairedEntity>, StorageError> {
        let conn = self.pool.get().map_err(StorageError::pool)?;
        let row = conn.query_row(
            "SELECT id, kind, display_name, identifier, workspace_id,
                    paired_at_ms, last_seen_at_ms, revoked_at_ms
             FROM paired_entities
             WHERE workspace_id = ?1 AND kind = ?2 AND identifier = ?3
                   AND revoked_at_ms IS NULL
             ORDER BY paired_at_ms DESC LIMIT 1",
            params![workspace_id.simple().to_string(), kind.as_str(), identifier],
            row_to_paired,
        );
        match row {
            Ok(p) => Ok(Some(p)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::sql(e)),
        }
    }

    /// List active paired entities for a workspace, newest first.
    pub fn list_active(&self, workspace_id: Uuid) -> Result<Vec<PairedEntity>, StorageError> {
        let conn = self.pool.get().map_err(StorageError::pool)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, display_name, identifier, workspace_id,
                        paired_at_ms, last_seen_at_ms, revoked_at_ms
                 FROM paired_entities
                 WHERE workspace_id = ?1 AND revoked_at_ms IS NULL
                 ORDER BY paired_at_ms DESC",
            )
            .map_err(StorageError::sql)?;
        let rows = stmt
            .query_map(params![workspace_id.simple().to_string()], row_to_paired)
            .map_err(StorageError::sql)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(StorageError::sql)?);
        }
        Ok(out)
    }

    /// Mark a paired entity as revoked. No-op if already revoked or
    /// missing — the API is idempotent on revoke (callers shouldn't have
    /// to distinguish "already gone" from "just revoked it").
    pub fn revoke(&self, entity_id: Uuid) -> Result<(), StorageError> {
        let now = self.clock.now_ms();
        let conn = self.pool.get().map_err(StorageError::pool)?;
        conn.execute(
            "UPDATE paired_entities
                SET revoked_at_ms = ?1
              WHERE id = ?2 AND revoked_at_ms IS NULL",
            params![now, entity_id.simple().to_string()],
        )
        .map_err(StorageError::sql)?;
        Ok(())
    }

    /// Update `last_seen_at_ms` for a paired entity. Best-effort — used
    /// by the messenger gateway to surface "active in the last 5 min" UI.
    pub fn touch_last_seen(&self, entity_id: Uuid) -> Result<(), StorageError> {
        let now = self.clock.now_ms();
        let conn = self.pool.get().map_err(StorageError::pool)?;
        conn.execute(
            "UPDATE paired_entities SET last_seen_at_ms = ?1 WHERE id = ?2",
            params![now, entity_id.simple().to_string()],
        )
        .map_err(StorageError::sql)?;
        Ok(())
    }

    /// Sweep expired pending rows. Returns count deleted. Idempotent —
    /// safe to call from a periodic timer.
    pub fn cleanup_expired(&self) -> Result<usize, StorageError> {
        let now = self.clock.now_ms();
        let conn = self.pool.get().map_err(StorageError::pool)?;
        let n = conn
            .execute(
                "DELETE FROM pending_pairings WHERE expires_at_ms <= ?1",
                params![now],
            )
            .map_err(StorageError::sql)?;
        Ok(n)
    }

    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }
}

// ── Row helpers ─────────────────────────────────────────────────────────────

fn row_to_pending(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingPairing> {
    let id_s: String = row.get(0)?;
    let code_s: String = row.get(1)?;
    let kind_s: String = row.get(2)?;
    let ws_s: String = row.get(3)?;
    let initiator: String = row.get(4)?;
    let created_at_ms: i64 = row.get(5)?;
    let expires_at_ms: i64 = row.get(6)?;
    let id = Uuid::parse_str(&id_s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let workspace_id = Uuid::parse_str(&ws_s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let kind = EntityKind::parse(&kind_s).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            format!("unknown kind {kind_s:?}").into(),
        )
    })?;
    Ok(PendingPairing {
        id,
        code: PairingCode::from_canonical(code_s),
        kind,
        workspace_id,
        initiator,
        created_at_ms,
        expires_at_ms,
    })
}

fn row_to_paired(row: &rusqlite::Row<'_>) -> rusqlite::Result<PairedEntity> {
    let id_s: String = row.get(0)?;
    let kind_s: String = row.get(1)?;
    let display_name: String = row.get(2)?;
    let identifier: String = row.get(3)?;
    let ws_s: String = row.get(4)?;
    let paired_at_ms: i64 = row.get(5)?;
    let last_seen_at_ms: i64 = row.get(6)?;
    let revoked_at_ms: Option<i64> = row.get(7)?;
    let id = Uuid::parse_str(&id_s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let workspace_id = Uuid::parse_str(&ws_s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let kind = EntityKind::parse(&kind_s).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            format!("unknown kind {kind_s:?}").into(),
        )
    })?;
    Ok(PairedEntity {
        id,
        kind,
        display_name,
        identifier,
        workspace_id,
        paired_at_ms,
        last_seen_at_ms,
        revoked_at_ms,
    })
}
