//! Hand-rolled migration runner.
//!
//! Why hand-rolled instead of refinery: 3 migrations, no rollback story
//! required, and refinery 0.8 + rusqlite 0.31 pairing requires extra
//! feature gymnastics (`tokio-postgres` default features pull in async
//! transitively). A 60-line runner with a `schema_versions` table is
//! easier to audit and ships zero new transitive deps.
//!
//! Each migration runs inside a transaction so a failed mid-script
//! statement leaves the DB at the previous version. Idempotency is
//! ensured by checking `schema_versions(version)` before applying.

use rusqlite::{params, Connection};

use super::error::{Result, StoreError};

/// One ordered migration. The SQL body is loaded at compile time via
/// `include_str!` so the migrations directory ships in the binary.
pub struct Migration {
    pub version: u32,
    pub name:    &'static str,
    pub sql:     &'static str,
}

/// All migrations, in apply order. Adding a new migration: append a
/// new entry — never re-order, never edit a shipped one. Versions
/// are u32 so we have headroom for thousands of migrations.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name:    "initial",
        sql:     include_str!("migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        name:    "embeddings",
        sql:     include_str!("migrations/0002_embeddings.sql"),
    },
    Migration {
        version: 3,
        name:    "memory",
        sql:     include_str!("migrations/0003_memory.sql"),
    },
    Migration {
        version: 4,
        name:    "replay_enabled",
        sql:     include_str!("migrations/0004_replay_enabled.sql"),
    },
    Migration {
        version: 5,
        name:    "ai_spend",
        sql:     include_str!("migrations/0005_ai_spend.sql"),
    },
    Migration {
        version: 6,
        name:    "events_indices",
        sql:     include_str!("migrations/0006_events_indices.sql"),
    },
    Migration {
        version: 7,
        name:    "remediation_sessions",
        sql:     include_str!("migrations/0007_remediation_sessions.sql"),
    },
    Migration {
        version: 8,
        name:    "gate_runs",
        sql:     include_str!("migrations/0008_gate_runs.sql"),
    },
];

/// Apply any migrations that have not yet run on `conn`. Idempotent.
///
/// The `schema_versions` table is created on first run. Each migration
/// runs in its own transaction; a partial failure rolls back without
/// recording the version, so re-running picks up from the same point.
pub fn apply_all(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_versions (
             version    INTEGER PRIMARY KEY,
             name       TEXT    NOT NULL,
             applied_at INTEGER NOT NULL
         )",
    )?;

    for m in MIGRATIONS {
        let already: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_versions WHERE version = ?1)",
            params![m.version],
            |row| row.get(0),
        )?;
        if already {
            continue;
        }

        let tx = conn.transaction()?;
        tx.execute_batch(m.sql).map_err(|e| StoreError::Migration {
            version: m.version,
            name:    m.name,
            source:  e,
        })?;
        let now_ms: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        tx.execute(
            "INSERT INTO schema_versions (version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![m.version, m.name, now_ms],
        )
        .map_err(|e| StoreError::Migration {
            version: m.version,
            name:    m.name,
            source:  e,
        })?;
        tx.commit().map_err(|e| StoreError::Migration {
            version: m.version,
            name:    m.name,
            source:  e,
        })?;

        tracing::info!(
            version = m.version,
            name    = m.name,
            "migration applied"
        );
    }

    Ok(())
}

/// Number of successfully-applied migrations. Used by tests to assert
/// the runner's effect without poking the schema_versions table from
/// outside the module.
pub fn applied_count(conn: &Connection) -> Result<u32> {
    let count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM schema_versions",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}
