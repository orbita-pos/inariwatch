//! r2d2 + r2d2_sqlite pool wrapper.
//!
//! Two separate concerns live here:
//!
//! 1. **sqlite-vec registration.** `sqlite3_auto_extension` is called
//!    exactly once for the lifetime of the process via `std::sync::Once`.
//!    From that point, every freshly-opened SQLite connection — including
//!    every connection created by r2d2's `SqliteConnectionManager` —
//!    auto-loads the vec0 module. This is the canonical pattern from
//!    upstream sqlite-vec; the alternative (per-connection
//!    `Connection::load_extension`) requires gating the
//!    `LOAD EXTENSION` SQL pragma on each acquire and is strictly more
//!    work for the same effect.
//!
//! 2. **Per-acquire PRAGMAs.** `r2d2::CustomizeConnection::on_acquire`
//!    applies WAL mode, foreign-keys, busy-timeout, mmap_size, etc. on
//!    every connection (not just the first). PRAGMAs that are
//!    connection-local (`foreign_keys`, `temp_store`, `busy_timeout`)
//!    NEED this hook. PRAGMAs that are persisted to the DB header
//!    (`journal_mode = WAL`) only need to be set once but the cost of
//!    asking again is one statement, so we set them every time for
//!    explicitness.

use std::path::Path;
use std::sync::Once;

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;

use super::error::{Result, StoreError};

/// Pool size 4. The store is read-mostly with a sprinkling of
/// background writes (events table). 4 is the rusqlite/r2d2 community
/// default for embedded apps and matches the spec recap perf budget.
pub const POOL_SIZE: u32 = 4;

pub type SqlitePool = Pool<SqliteConnectionManager>;

static SQLITE_VEC_INIT: Once = Once::new();

/// Register sqlite-vec as an auto-extension on every newly-opened
/// SQLite connection. Idempotent — safe to call multiple times. The
/// `Once` guard keeps it side-effect-free under test harness reuse.
fn ensure_sqlite_vec_registered() -> Result<()> {
    let mut outcome: Result<()> = Ok(());
    SQLITE_VEC_INIT.call_once(|| {
        // SAFETY: `sqlite3_vec_init` matches the
        // `Option<unsafe extern "C" fn(...) -> i32>` signature expected
        // by `sqlite3_auto_extension`. The function pointer lives in
        // sqlite-vec for the duration of the process.
        let rc = unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )))
        };
        if rc != rusqlite::ffi::SQLITE_OK {
            outcome = Err(StoreError::ExtensionLoad(format!(
                "sqlite3_auto_extension returned rc={rc}"
            )));
        }
    });
    outcome
}

/// Apply per-connection PRAGMAs. Called by the r2d2 customizer on every
/// fresh acquire. Order matters: `journal_mode=WAL` is durable across
/// reconnects, but `foreign_keys`, `temp_store`, `busy_timeout`, and
/// `mmap_size` are connection-local and would silently revert if we
/// only set them on first open.
pub(super) fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    // WAL: persisted to the DB header. Asking on every connection costs
    // one statement and confirms the DB really is in WAL mode (a future
    // VACUUM could reset it; safer to set explicitly).
    let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // 256 MB. Enough headroom for the embeddings table without paging.
    conn.pragma_update(None, "mmap_size", 268_435_456_i64)?;
    // 5 s busy timeout for writers waiting on a long-running reader.
    conn.pragma_update(None, "busy_timeout", 5_000_i64)?;
    Ok(())
}

#[derive(Copy, Clone, Debug)]
struct PragmaCustomizer;

impl r2d2::CustomizeConnection<Connection, rusqlite::Error> for PragmaCustomizer {
    fn on_acquire(&self, conn: &mut Connection) -> std::result::Result<(), rusqlite::Error> {
        apply_pragmas(conn)
    }
}

/// Build a configured pool against the SQLite database at `path`.
///
/// The parent directory must already exist — callers (`Store::open`)
/// own that responsibility so we surface filesystem errors at the
/// right layer.
pub fn build(path: &Path) -> Result<SqlitePool> {
    ensure_sqlite_vec_registered()?;

    let manager = SqliteConnectionManager::file(path);
    let pool = Pool::builder()
        .max_size(POOL_SIZE)
        .connection_customizer(Box::new(PragmaCustomizer))
        .build(manager)?;

    Ok(pool)
}
