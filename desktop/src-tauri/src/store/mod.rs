//! Local SQLite store — the durable home for repos, events, embeddings,
//! and memory layers.
//!
//! Layout:
//!
//! - [`pool`]       — r2d2 + r2d2_sqlite pool, sqlite-vec auto-extension,
//!                    per-connection PRAGMA hook (WAL, foreign_keys, …).
//! - [`migrations`] — hand-rolled migration runner. SQL files in
//!                    `store/migrations/` are baked in via `include_str!`.
//! - [`queries`]    — typed helpers (find_repo_by_path / upsert_repo /
//!                    insert_event); future sessions extend this.
//! - [`error`]      — [`StoreError`] + [`Result`].
//!
//! `Store` is held by the app as `tauri::State<Arc<Store>>`. Every
//! IPC command / sensor that needs DB access acquires a connection
//! via `store.conn()` (which returns a pooled `PooledConnection`).
//! The pool itself holds 4 connections (see `pool::POOL_SIZE`).

pub mod error;
pub mod legacy_settings_migration;
pub mod migrations;
pub mod pool;
pub mod queries;
pub mod settings;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

pub use error::{Result, StoreError};
pub use pool::SqlitePool;

/// Owned wrapper around the shared pool. Cloneable, cheap to pass
/// around (`Arc` internally via the inner pool's design).
#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    /// Resolved on-disk path. Useful for diagnostics (logging, settings
    /// UI) — never used to bypass the pool.
    db_path: PathBuf,
}

impl Store {
    /// Open (creating if absent) the store at `db_path`. The parent
    /// directory is created with `create_dir_all`. Migrations run
    /// once on a borrowed connection from the pool.
    ///
    /// Idempotent — calling twice on the same path is a no-op modulo
    /// re-checking schema_versions.
    pub fn open_at(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let pool = pool::build(db_path)?;

        // Run migrations on a single connection. We grab a regular
        // pooled handle (PRAGMAs already applied by the customizer)
        // and use `&mut` to satisfy `Connection::transaction`.
        let mut conn = pool.get()?;
        migrations::apply_all(&mut conn)?;
        drop(conn);

        Ok(Self {
            pool,
            db_path: db_path.to_path_buf(),
        })
    }

    /// Resolve the canonical db path under the Tauri app-local data
    /// directory (`<app_local_data_dir>/inari-live/store.db`).
    /// Same resolution pattern Session 2 used for the log dir, so
    /// dev / prod / installer paths stay consistent.
    pub fn resolve_db_path(app: &AppHandle) -> Result<PathBuf> {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| StoreError::PathResolution(e.to_string()))?;
        Ok(dir.join("inari-live").join("store.db"))
    }

    /// Open against the resolved app-local-data path. Convenience for
    /// the Tauri setup hook.
    pub fn open(app: &AppHandle) -> Result<Self> {
        let path = Self::resolve_db_path(app)?;
        Self::open_at(&path)
    }

    /// Acquire a pooled connection. Returns immediately if the pool
    /// has spare capacity; blocks up to `r2d2`'s default
    /// (~30 s, configurable) otherwise. Per-connection PRAGMAs
    /// (WAL, foreign_keys, busy_timeout) have already been applied
    /// by the customizer before this returns.
    pub fn conn(&self) -> Result<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>> {
        Ok(self.pool.get()?)
    }

    /// On-disk location of the database. Diagnostic use only.
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }
}

/// Open the store at the resolved app-local-data path and register it
/// with the Tauri app so subsequent commands can reach it via
/// `tauri::State<Arc<Store>>`. Returns the `Arc<Store>` for callers
/// (the Session-2-style `setup` hook) that want their own handle.
///
/// Also runs the one-shot legacy TOML → SQL migration so any settings
/// the user already has on disk are visible to the new SQL-backed
/// command surface from the very first boot post-Session-4.
pub fn install(app: &AppHandle) -> Result<Arc<Store>> {
    let store = Arc::new(Store::open(app)?);
    app.manage(store.clone());
    tracing::info!(
        db_path = %store.db_path().display(),
        "store opened"
    );

    match legacy_settings_migration::migrate_toml_settings_once(app, &store) {
        Ok(outcome)  => tracing::info!(?outcome, "legacy settings migration"),
        Err(err)     => tracing::warn!(error = %err, "legacy settings migration failed (continuing)"),
    }

    Ok(store)
}
