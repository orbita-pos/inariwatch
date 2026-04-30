//! Tauri-command shells for the settings UI.
//!
//! Storage IMPL lives in [`crate::store::settings`] (SQL-backed).
//! Window-open helper lives in [`crate::window::settings`].

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::store::{settings, Store};

#[derive(Deserialize, Default)]
pub struct SettingsPatch {
    pub watch_dir:             Option<String>,
    pub replay_url:            Option<String>,
    pub recording_url:         Option<String>,
    pub dashboard_url:         Option<String>,
    pub project_id:            Option<String>,
    pub repo_url:              Option<String>,
    pub fix_branch:            Option<String>,
    pub replay_command:        Option<String>,
    pub notifications_enabled: Option<bool>,
    pub sounds_enabled:        Option<bool>,
    pub theme:                 Option<String>,
}

#[tauri::command]
pub fn desktop_get_settings(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<settings::SafeSettings, String> {
    settings::safe_snapshot(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_save_settings(
    state: tauri::State<'_, Arc<Store>>,
    patch: SettingsPatch,
) -> Result<settings::SafeSettings, String> {
    let map_apply = |key: &str, val: Option<String>| -> Result<(), String> {
        if let Some(v) = val {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                settings::delete(&state, key).map_err(|e| e.to_string())?;
            } else {
                settings::set(&state, key, trimmed).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    };

    map_apply("watch_dir",      patch.watch_dir)?;
    map_apply("replay_url",     patch.replay_url)?;
    map_apply("recording_url",  patch.recording_url)?;
    map_apply("dashboard_url",  patch.dashboard_url)?;
    map_apply("project_id",     patch.project_id)?;
    map_apply("repo_url",       patch.repo_url)?;
    map_apply("fix_branch",     patch.fix_branch)?;
    map_apply("replay_command", patch.replay_command)?;
    if let Some(b) = patch.notifications_enabled {
        settings::set(&state, "notifications_enabled", &b.to_string())
            .map_err(|e| e.to_string())?;
    }
    if let Some(b) = patch.sounds_enabled {
        settings::set(&state, "sounds_enabled", &b.to_string())
            .map_err(|e| e.to_string())?;
    }
    if let Some(t) = patch.theme {
        if matches!(t.as_str(), "auto" | "light" | "dark") {
            settings::set(&state, "theme", &t).map_err(|e| e.to_string())?;
        }
    }

    settings::safe_snapshot(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_logout(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<settings::SafeSettings, String> {
    settings::delete(&state, "dashboard_url").map_err(|e| e.to_string())?;
    settings::delete(&state, "dashboard_token").map_err(|e| e.to_string())?;
    settings::safe_snapshot(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_open_settings(app: AppHandle) -> Result<(), String> {
    crate::window::settings::open(&app)
}

#[derive(Serialize)]
pub struct AppVersion {
    pub version: String,
    pub commit:  Option<String>,
}

#[tauri::command]
pub fn desktop_app_version() -> AppVersion {
    AppVersion {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit:  option_env!("GIT_SHA").map(|s| s.to_string()),
    }
}
