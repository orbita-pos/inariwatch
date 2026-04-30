//! One-shot Settings TOML → SQL migration.
//!
//! Pre-Session-4 the desktop persisted user settings in
//! `~/.config/inari/desktop.toml`. Session 4 moves the source of truth
//! into the `settings` table. Several legacy modules (`inari_watcher.rs`,
//! Session 5+ owns the rewrite) still read the TOML directly, so the
//! migration is **non-destructive**: we copy keys into SQL and leave
//! the TOML in place. Idempotency is tracked via a marker row in the
//! `settings` table, NOT a file rename, so legacy code keeps working
//! through the transition window.
//!
//! Each TOML key becomes one row in `settings(key, value, updated_at)`.
//! In addition, the entire legacy file content is stored under
//! `legacy_settings` as a JSON object for forensic recovery.
//!
//! This deviates from the Session 4 spec's "rename TOML to .migrated"
//! step on purpose — see `INARI_LIVE_DECISIONS.md` Sesión 4 entry.

use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::Serialize;
use tauri::AppHandle;

use super::error::{Result, StoreError};
use super::Store;

const MARKER_KEY: &str = "__legacy_toml_migrated_at";

/// Result of `migrate_toml_settings_once`. Surfaced via `tracing::info`
/// so users can see which path the migration took on each boot.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// A previous boot already ran the migration. No work this time.
    AlreadyMigrated,
    /// First-time migration ran successfully. `keys_migrated` is the
    /// count of TOML keys copied into SQL (excludes the marker row).
    Migrated { keys_migrated: usize },
    /// No legacy TOML file present on disk. Nothing to migrate.
    NoLegacyFile,
}

/// Resolve the canonical legacy TOML path. Mirrors what
/// `desktop_auth.rs` / `settings.rs` historically used:
/// `<config_dir>/inari/desktop.toml`.
///
/// We deliberately keep using the platform config dir (NOT the Tauri
/// `app_config_dir`) so existing user files are picked up. Once
/// Session 5 migrates `inari_watcher.rs` away from `dirs`, this helper
/// can be retired.
fn legacy_toml_path() -> Option<PathBuf> {
    let cfg = dirs::config_dir()?;
    Some(cfg.join("inari").join("desktop.toml"))
}

/// Run the one-shot TOML → SQL migration. Idempotent — calling repeatedly
/// is safe (subsequent calls return `AlreadyMigrated`).
///
/// On error, the SQL transaction rolls back so partial state cannot
/// leak into the new schema.
pub fn migrate_toml_settings_once(_app: &AppHandle, store: &Store) -> Result<MigrationOutcome> {
    let path = match legacy_toml_path() {
        Some(p) => p,
        None    => return Ok(MigrationOutcome::NoLegacyFile),
    };
    migrate_at(store, &path)
}

/// Internal entry point that takes an explicit path so tests can drive
/// it without the platform config dir.
pub fn migrate_at(store: &Store, path: &Path) -> Result<MigrationOutcome> {
    // Idempotency check (cheap — single point lookup).
    if has_marker(store)? {
        return Ok(MigrationOutcome::AlreadyMigrated);
    }

    if !path.exists() {
        return Ok(MigrationOutcome::NoLegacyFile);
    }

    let contents = match std::fs::read_to_string(path) {
        Ok(s)  => s,
        Err(e) => return Err(StoreError::Io(e)),
    };

    let pairs = parse_simple_toml(&contents);
    let now_ms = now_ms();

    let mut conn = store.conn()?;
    let tx = conn.transaction()?;

    for (k, v) in &pairs {
        tx.execute(
            "INSERT INTO settings (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![k, v, now_ms],
        )?;
    }

    let legacy_json = serde_json::to_string(&pairs).unwrap_or_else(|_| "{}".to_string());
    tx.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES ('legacy_settings', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![legacy_json, now_ms],
    )?;

    tx.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![MARKER_KEY, now_ms.to_string(), now_ms],
    )?;

    tx.commit()?;

    tracing::info!(
        keys = pairs.len(),
        path = %path.display(),
        "legacy settings TOML migrated to SQL"
    );

    Ok(MigrationOutcome::Migrated { keys_migrated: pairs.len() })
}

fn has_marker(store: &Store) -> Result<bool> {
    let conn = store.conn()?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key = ?1",
        params![MARKER_KEY],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Tiny key-only TOML reader matching the historical scaffold's
/// behaviour. The legacy files only ever contained `key = "value"`
/// lines and `# comments`; pulling in the full `toml` crate just to
/// re-parse them would be overkill and would diverge from how
/// `inari_watcher.rs` reads the same file today.
fn parse_simple_toml(contents: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let key = k.trim().to_string();
        let val = v.trim().trim_matches('"').to_string();
        if key.is_empty() {
            continue;
        }
        out.push((key, val));
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
