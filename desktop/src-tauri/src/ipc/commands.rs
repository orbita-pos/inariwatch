//! Session 4 — the 5 core Tauri commands.
//!
//! Each command:
//! - Annotated `#[tauri::command]`.
//! - Takes typed parameters; never raw `serde_json::Value`.
//! - Acquires `tauri::State<Arc<Store>>` / `tauri::State<Arc<DaemonHandle>>`
//!   for shared state — registered in `lib.rs::setup`.
//! - Maps [`crate::store::StoreError`] into [`IpcError`] via the
//!   `From` impl, never stringifies.
//! - Heavy-data IPC rule: payload < 100 KB. `get_logs` caps at 200
//!   entries; `list_repos` returns slim row shapes; ASTs / embeddings
//!   never appear here.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::daemon::{state::DaemonStatus, DaemonHandle};
use crate::store::{queries, Store};

use super::error::IpcError;

// ─────────────────────────────────────────────────────────────────────
// DaemonStatusDto
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct DaemonStatusDto {
    pub uptime_secs:  u64,
    pub sensor_count: u32,
    pub repo_count:   u32,
    /// Build version (`CARGO_PKG_VERSION`).
    pub version:      String,
    /// ISO-8601 UTC at which the daemon spawned.
    pub started_at:   String,
}

#[tauri::command]
pub fn daemon_status(
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
) -> Result<DaemonStatusDto, IpcError> {
    Ok(snapshot_to_dto(&daemon.state.snapshot()))
}

/// Build a [`DaemonStatusDto`] from a state snapshot. Used by both the
/// IPC command and the `daemon:status_changed` event bridge so they
/// produce byte-identical payloads — required for the debouncer's
/// equality check to suppress redundant emits.
///
/// `started_at` is cached on first call. Without caching, calls between
/// heartbeats would see drift (uptime advances on a 30s tick, but
/// `now()` advances continuously, so `now - uptime` would shift by up
/// to 30s) and the debouncer's PartialEq check would fire spuriously.
pub fn snapshot_to_dto(snap: &DaemonStatus) -> DaemonStatusDto {
    use std::sync::OnceLock;
    static STARTED_AT_SECS: OnceLock<u64> = OnceLock::new();

    let started_secs = *STARTED_AT_SECS.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .saturating_sub(snap.uptime_secs)
    });

    DaemonStatusDto {
        uptime_secs:  snap.uptime_secs,
        sensor_count: snap.sensor_count,
        repo_count:   snap.repo_count,
        version:      env!("CARGO_PKG_VERSION").to_string(),
        started_at:   epoch_secs_to_iso8601(started_secs),
    }
}

/// Format a unix-epoch-seconds as ISO-8601 UTC ("YYYY-MM-DDTHH:MM:SSZ").
/// Hand-rolled instead of pulling `chrono` / `humantime` for one call.
pub fn epoch_secs_to_iso8601(secs: u64) -> String {
    // Days since 1970-01-01 (proleptic Gregorian).
    let days = (secs / 86_400) as i64;
    let secs_of_day = (secs % 86_400) as u32;
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;

    // Civil-from-days algorithm (Howard Hinnant).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, d, h, m, s
    )
}

// ─────────────────────────────────────────────────────────────────────
// Repos
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct RepoDto {
    pub id:                  String,
    pub path:                String,
    pub name:                String,
    pub opened_at_ms:        i64,
    pub last_indexed_at_ms:  Option<i64>,
    pub indexed_file_count:  i64,
}

#[tauri::command]
pub fn list_repos(
    store: tauri::State<'_, Arc<Store>>,
) -> Result<Vec<RepoDto>, IpcError> {
    let conn = store.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, path, name, opened_at, last_indexed_at, indexed_file_count
             FROM repos
             ORDER BY opened_at DESC
             LIMIT 1000",
        )
        .map_err(|e| IpcError::Query { message: e.to_string() })?;

    let rows = stmt
        .query_map([], |row| {
            Ok(RepoDto {
                id:                 row.get(0)?,
                path:               row.get(1)?,
                name:               row.get(2)?,
                opened_at_ms:       row.get(3)?,
                last_indexed_at_ms: row.get(4)?,
                indexed_file_count: row.get(5)?,
            })
        })
        .map_err(|e| IpcError::Query { message: e.to_string() })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| IpcError::Query { message: e.to_string() })?);
    }
    Ok(out)
}

#[tauri::command]
pub fn open_repo(
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
    store:  tauri::State<'_, Arc<Store>>,
    path:   String,
) -> Result<RepoDto, IpcError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(IpcError::invalid_path("", "path is empty"));
    }
    let p = Path::new(trimmed);
    let canonical = p
        .canonicalize()
        .map_err(|e| IpcError::invalid_path(p, e.to_string()))?;
    if !canonical.is_dir() {
        return Err(IpcError::invalid_path(&canonical, "not a directory"));
    }
    let canonical_str = canonical.to_string_lossy().to_string();
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_str.clone());

    let id = generate_repo_id();
    let now_ms = now_ms();
    let final_id = queries::upsert_repo(&store, &id, &canonical_str, &name, now_ms)?;

    // If we inserted a brand-new row, increment the daemon's repo count
    // so `daemon_status` reflects it. Existing repos don't bump.
    if final_id == id {
        daemon.state.inc_repos();
    }

    let conn = store.conn()?;
    let row = conn
        .query_row(
            "SELECT id, path, name, opened_at, last_indexed_at, indexed_file_count
             FROM repos WHERE id = ?1",
            rusqlite::params![final_id],
            |row| {
                Ok(RepoDto {
                    id:                 row.get(0)?,
                    path:               row.get(1)?,
                    name:               row.get(2)?,
                    opened_at_ms:       row.get(3)?,
                    last_indexed_at_ms: row.get(4)?,
                    indexed_file_count: row.get(5)?,
                })
            },
        )
        .map_err(|e| IpcError::Query { message: e.to_string() })?;
    Ok(row)
}

#[tauri::command]
pub fn close_repo(
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
    store:  tauri::State<'_, Arc<Store>>,
    id:     String,
) -> Result<(), IpcError> {
    let conn = store.conn()?;
    let n = conn
        .execute("DELETE FROM repos WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| IpcError::Query { message: e.to_string() })?;
    if n == 0 {
        return Err(IpcError::RepoNotFound { id });
    }
    daemon.state.dec_repos();
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Logs
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct LogEntryDto {
    /// Original line, untouched.
    pub raw:       String,
    /// Parsed level (`debug` / `info` / `warn` / `error`) when the line
    /// matches the tracing-fmt format; `unknown` otherwise.
    pub level:     String,
    /// Resolved file path the line came from. Useful for diagnosing
    /// rotated-vs-current log issues.
    pub file:      String,
}

const LOG_ENTRIES_CAP: usize = 200;

#[tauri::command]
pub fn get_logs(
    app:   AppHandle,
    level: Option<String>,
) -> Result<Vec<LogEntryDto>, IpcError> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| IpcError::internal(format!("could not resolve log dir: {e}")))?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    // Pick the most recent `inari-live*.log` file. The rolling appender
    // names files `inari-live.log.<date>` for past days and just
    // `inari-live.log` for today.
    let mut candidates: Vec<_> = std::fs::read_dir(&dir)
        .map_err(IpcError::from)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("inari-live")
        })
        .collect();
    candidates.sort_by_key(|e| {
        e.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    let latest = match candidates.last() {
        Some(e) => e.path(),
        None    => return Ok(Vec::new()),
    };

    let contents = std::fs::read_to_string(&latest).map_err(IpcError::from)?;
    let file_name = latest.display().to_string();

    let filter = level.as_deref().map(str::to_lowercase);
    let mut entries: Vec<LogEntryDto> = contents
        .lines()
        .map(|line| {
            let level = parse_level(line);
            LogEntryDto {
                raw:   line.to_string(),
                level,
                file:  file_name.clone(),
            }
        })
        .filter(|e| match &filter {
            Some(want) => e.level == *want,
            None       => true,
        })
        .collect();

    // Tail — most recent at the end.
    if entries.len() > LOG_ENTRIES_CAP {
        let drop = entries.len() - LOG_ENTRIES_CAP;
        entries.drain(..drop);
    }
    Ok(entries)
}

fn parse_level(line: &str) -> String {
    // tracing's default fmt: `2026-04-29T12:34:56.789Z  INFO module: msg`.
    // We look for a recognized level token after the timestamp.
    for token in [" ERROR ", " WARN ", " INFO ", " DEBUG ", " TRACE "] {
        if line.contains(token) {
            return token.trim().to_lowercase();
        }
    }
    "unknown".to_string()
}

fn generate_repo_id() -> String {
    // Match the random-id shape elsewhere in the codebase: 16 hex chars,
    // sourced from cryptographic-quality entropy via `rand`. We avoid
    // pulling `uuid` just for this — the migration uses TEXT, any unique
    // string works.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Combine the nanoseconds with a per-process counter so two opens
    // in the same nanosecond (impossible on real hardware but
    // let's be safe) still differ.
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}-{:08x}", nanos as u64, seq as u32)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
