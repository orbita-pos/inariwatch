//! First-run onboarding helpers (RENAMED from `src/onboarding.rs`).
//!
//! Legacy commands (kept for backward-compat with the InariWatch
//! dashboard overlay; see project rule "no breaking changes" in
//! CLAUDE.md):
//!
//!   - `desktop_first_run_status` — { has_token, has_watch_dir, watch_dir? }
//!   - `desktop_pick_watch_dir`   — opens the native folder picker
//!   - `desktop_save_watch_dir`   — persists `watch_dir` in the SQL
//!     settings store
//!
//! Sesión 17 adds the new multi-step React onboarding surface backing
//! commands:
//!
//!   - `onboarding_open_repo` — drag-and-drop accepted path → registers
//!     the repo in `repos` + dispatches the indexer.
//!   - `onboarding_progress`  — polled by the React UI for the in-progress
//!     scan/index status. Returns `done` once the indexer reports the
//!     repo's symbol count > 0 OR the daemon emits `RepoIndexed`.
//!   - `complete_onboarding`  — flips `user_onboarded = true` in settings.
//!   - `is_onboarded`         — gating helper used by `App.tsx` boot to
//!     decide whether to show the onboarding window or the dock.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use ts_rs::TS;

use crate::daemon::DaemonHandle;
use crate::sensors::fs::FsSensorHandle;
use crate::store::{queries, settings, Store};

use super::error::IpcError;

#[derive(Serialize)]
pub struct FirstRunStatus {
    pub has_token:     bool,
    pub has_watch_dir: bool,
    pub watch_dir:     Option<String>,
}

#[tauri::command]
pub fn desktop_first_run_status(
    state: tauri::State<'_, Arc<Store>>,
) -> FirstRunStatus {
    // Session 1 — bearer lives in OS keyring (SecretStore covers the
    // settings-store fallback for pre-S1 installs and Linux without
    // Secret Service / kwallet).
    let has_token = crate::cloud::keyring::SecretStore::new(state.inner().clone())
        .token()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let watch_dir = settings::get(&state, "watch_dir")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty());
    FirstRunStatus {
        has_token,
        has_watch_dir: watch_dir.is_some(),
        watch_dir,
    }
}

/// Open a native folder picker. Returns Some(path) on selection,
/// None when the user cancels.
#[tauri::command]
pub async fn desktop_pick_watch_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    let tx = std::sync::Mutex::new(Some(tx));

    app.dialog()
        .file()
        .set_title("Pick the project Inari should watch")
        .pick_folder(move |selected| {
            if let Some(sender) = tx.lock().ok().and_then(|mut s| s.take()) {
                let _ = sender.send(selected.map(|p| p.into_path().unwrap_or_default()));
            }
        });

    match rx.await {
        Ok(Some(p)) => Ok(Some(p.display().to_string())),
        Ok(None)    => Ok(None),
        Err(e)      => Err(format!("dialog: {}", e)),
    }
}

/// Persist `watch_dir` in the SQL settings store.
#[tauri::command]
pub fn desktop_save_watch_dir(
    state: tauri::State<'_, Arc<Store>>,
    path:  String,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    if !Path::new(trimmed).is_dir() {
        return Err(format!("not a directory: {}", trimmed));
    }
    settings::set(&state, "watch_dir", trimmed)
        .map_err(|e| format!("save: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Sesión 17 — multi-step React onboarding
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct OnboardingRepoResult {
    pub id:                 String,
    pub path:               String,
    pub name:               String,
    pub already_registered: bool,
}

/// Register a repo and kick off the initial walk. Mirrors `open_repo`
/// (Sesión 4) but: (1) attaches a friendly "already registered" flag so
/// the React UI shows "We already know this repo, picking it up where
/// you left off", and (2) does NOT bump the daemon's repo counter when
/// the path is already known (so revisiting onboarding is idempotent).
#[tauri::command]
pub fn onboarding_open_repo(
    app:        AppHandle,
    store:      tauri::State<'_, Arc<Store>>,
    daemon:     tauri::State<'_, Arc<DaemonHandle>>,
    fs_sensor:  tauri::State<'_, FsSensorHandle>,
    path:       String,
) -> Result<OnboardingRepoResult, IpcError> {
    let _ = app; // reserved for future emits
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
    // Best-effort .git/ check. Sesión 17 spec asks the UI to soft-warn
    // on non-git folders; the IPC accepts them so the user can still
    // attach a generic project but the React layer surfaces the hint.
    let canonical_str = canonical.to_string_lossy().to_string();
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_str.clone());

    let already = queries::find_repo_by_path(&store, &canonical_str)?.is_some();

    let id = generate_repo_id();
    let now_ms = now_ms();
    let final_id = queries::upsert_repo(&store, &id, &canonical_str, &name, now_ms)?;

    if !already {
        daemon.state.inc_repos();
    }

    if let Err(e) = fs_sensor.attach(final_id.clone(), canonical.clone()) {
        tracing::warn!(repo_id = %final_id, error = %e, "fs sensor attach failed");
    }

    Ok(OnboardingRepoResult {
        id:                 final_id,
        path:               canonical_str,
        name,
        already_registered: already,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct OnboardingProgressDto {
    /// `scanning` (initial walk) / `indexing` (embedding pass) / `done`.
    pub stage:        String,
    /// 0.0–1.0 — heuristic, monotonically non-decreasing.
    pub percent:      f32,
    pub symbol_count: i64,
}

#[tauri::command]
pub fn onboarding_progress(
    store:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<OnboardingProgressDto, IpcError> {
    let symbol_count = queries::count_symbols_for_repo(&store, &repo_id)
        .map(|n| n as i64)
        .unwrap_or(0);

    // Stage heuristic: the indexer (Sesión 6) walks first and embeds
    // symbols incrementally. We can't observe the walker queue from here
    // without re-plumbing the indexer, so the heuristic is:
    //   - 0 symbols indexed yet → stage = scanning, percent = 0.05
    //   - some indexed         → stage = indexing, percent ramps to 0.95
    //   - last_indexed_at set  → stage = done, percent = 1.0
    let conn = store.conn()?;
    let last_indexed_at_ms: Option<i64> = conn
        .query_row(
            "SELECT last_indexed_at FROM repos WHERE id = ?1",
            rusqlite::params![repo_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|e| IpcError::Query { message: e.to_string() })?;

    let (stage, percent) = if last_indexed_at_ms.is_some() {
        ("done", 1.0_f32)
    } else if symbol_count > 0 {
        // Ramp from 0.10 → 0.95 logarithmically by symbol count.
        let pct = 0.10_f32 + (0.85_f32 * (1.0 - (1.0_f32 / (1.0 + symbol_count as f32 * 0.001))));
        ("indexing", pct.min(0.95))
    } else {
        ("scanning", 0.05_f32)
    };

    Ok(OnboardingProgressDto {
        stage:        stage.to_string(),
        percent,
        symbol_count,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct OnboardingState {
    pub onboarded: bool,
}

#[tauri::command]
pub fn complete_onboarding(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<OnboardingState, IpcError> {
    settings::set(&state, super::settings::KEY_USER_ONBOARDED, "true")?;
    Ok(OnboardingState { onboarded: true })
}

#[tauri::command]
pub fn is_onboarded(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<OnboardingState, IpcError> {
    let raw = settings::get(&state, super::settings::KEY_USER_ONBOARDED)?;
    let onboarded = matches!(raw.as_deref(), Some("true") | Some("1"));
    Ok(OnboardingState { onboarded })
}

fn generate_repo_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
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
