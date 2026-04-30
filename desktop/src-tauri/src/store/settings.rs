//! SQL-backed settings store. Replaces the pre-Session-4 TOML reader.
//!
//! All keys live in the `settings` table from migration 0001. Values are
//! stored as strings; callers serialize/deserialize their own types
//! (booleans → "true"/"false", integers → decimal, etc.). The full set
//! of well-known keys lives in [`KnownKey`] so the IPC layer can compose
//! a typed snapshot without leaking arbitrary keys.
//!
//! Token-shaped keys (`*_token`, `*_auth`) are NOT exposed by
//! [`safe_snapshot`] — only their *presence* is reported as a boolean.
//! This matches the pre-Session-4 redaction contract that prevented
//! tokens from round-tripping through the JS bridge.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::error::Result;
use super::Store;

/// Snapshot of every well-known setting key. Tokens collapse to a
/// boolean. Mirrors the historical `SafeSettings` shape so the dock
/// frontend code that already exists keeps working.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SafeSettings {
    pub watch_dir:               Option<String>,
    pub replay_url:              Option<String>,
    pub recording_url:           Option<String>,
    pub recording_auth_present:  bool,
    pub dashboard_url:           Option<String>,
    pub dashboard_token_present: bool,
    pub project_id:              Option<String>,
    pub repo_url:                Option<String>,
    pub fix_branch:              Option<String>,
    pub replay_command:          Option<String>,
    pub replay_token_present:    bool,
    pub notifications_enabled:   bool,
    pub sounds_enabled:          bool,
    pub theme:                   String,
}

/// Read a single value by key. Returns `None` if absent.
pub fn get(store: &Store, key: &str) -> Result<Option<String>> {
    let conn = store.conn()?;
    let value = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(value)
}

/// Upsert a single value. Empty string is treated as "delete".
pub fn set(store: &Store, key: &str, value: &str) -> Result<()> {
    let now_ms = now_ms();
    let conn = store.conn()?;
    if value.is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    } else {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_ms],
        )?;
    }
    Ok(())
}

/// Delete a key. No-op if it does not exist.
pub fn delete(store: &Store, key: &str) -> Result<()> {
    let conn = store.conn()?;
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

/// Build a redacted snapshot from the well-known keys. Tokens are not
/// returned — only their presence as a boolean.
pub fn safe_snapshot(store: &Store) -> Result<SafeSettings> {
    Ok(SafeSettings {
        watch_dir:               get(store, "watch_dir")?,
        replay_url:              get(store, "replay_url")?,
        recording_url:           get(store, "recording_url")?,
        recording_auth_present:  get(store, "recording_auth")?.map(|v| !v.is_empty()).unwrap_or(false),
        dashboard_url:           get(store, "dashboard_url")?,
        dashboard_token_present: get(store, "dashboard_token")?.map(|v| !v.is_empty()).unwrap_or(false),
        project_id:              get(store, "project_id")?,
        repo_url:                get(store, "repo_url")?,
        fix_branch:              get(store, "fix_branch")?,
        replay_command:          get(store, "replay_command")?,
        replay_token_present:    get(store, "replay_token")?.map(|v| !v.is_empty()).unwrap_or(false),
        notifications_enabled:   read_bool(store, "notifications_enabled", true)?,
        sounds_enabled:          read_bool(store, "sounds_enabled", true)?,
        theme:                   read_theme(store)?,
    })
}

/// Convenience for callers that only care whether desktop notifications
/// are enabled (e.g. the alert poller). Defaults to `true`.
pub fn notifications_enabled(store: &Store) -> bool {
    read_bool(store, "notifications_enabled", true).unwrap_or(true)
}

fn read_bool(store: &Store, key: &str, default: bool) -> Result<bool> {
    let raw = get(store, key)?;
    Ok(match raw.as_deref() {
        Some("false") | Some("0") | Some("no")  => false,
        Some("true")  | Some("1") | Some("yes") => true,
        _ => default,
    })
}

fn read_theme(store: &Store) -> Result<String> {
    let raw = get(store, "theme")?;
    let theme = match raw.as_deref() {
        Some(t @ ("auto" | "light" | "dark")) => t.to_string(),
        _                                     => "auto".to_string(),
    };
    Ok(theme)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
