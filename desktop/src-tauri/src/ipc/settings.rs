//! Tauri-command shells for the settings UI.
//!
//! Storage IMPL lives in [`crate::store::settings`] (SQL-backed).
//! Window-open helper lives in [`crate::window::settings`].
//!
//! Sesión 17 extends this surface: the legacy `desktop_get_settings` /
//! `desktop_save_settings` family stays (legacy callers untouched per the
//! "no breaking changes" rule). New `general` / `notifications` / `ai` /
//! `privacy` / `about` / `repos` / `wipe_repo_memory` commands fronted
//! the React Settings + Onboarding screens land alongside.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;

use crate::store::{queries, settings, Store};

use super::error::IpcError;

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

// ─────────────────────────────────────────────────────────────────────
// Sesión 17 — Settings screen DTOs + commands
// ─────────────────────────────────────────────────────────────────────
//
// All seven Settings sections back onto the same SQL `settings` KV
// table (migration 0001) — no per-section schema. Each `get_*` reads
// the well-known keys and returns a typed snapshot; each `set_*` runs
// through `apply_optional_string` so empty strings collapse to deletes.
//
// **BYOK key redaction.** The OpenAI key is stored under `openai_byok_key`
// in the same settings table the legacy auth tokens already live in.
// `get_ai_settings` returns the redacted preview only (`sk-***...***xyz`)
// so the IPC bridge never round-trips the raw key. See DECISIONS
// 2026-05-01 — Sesión 17 "BYOK encryption strategy" for why we did NOT
// add `keyring`/`aes-gcm` here (desktop app — local OS already gates the
// settings DB; redaction at the IPC bridge is the actionable security).

const SETTINGS_KEY_LANGUAGE:           &str = "language";
const SETTINGS_KEY_SOUND_ON_CRITICAL:  &str = "sound_on_critical";
const SETTINGS_KEY_NOTIFICATION_LEVEL: &str = "notification_level";
const SETTINGS_KEY_SOUND_VOLUME:       &str = "sound_volume";
const SETTINGS_KEY_QUIET_HOURS_START:  &str = "quiet_hours_start";
const SETTINGS_KEY_QUIET_HOURS_END:    &str = "quiet_hours_end";
const SETTINGS_KEY_QUIET_HOURS_TZ:     &str = "quiet_hours_tz";
const SETTINGS_KEY_RESPECT_FOCUS:      &str = "respect_focus_mode";
const SETTINGS_KEY_OPENAI_BYOK:        &str = "openai_byok_key";
const SETTINGS_KEY_AI_MODEL:           &str = "ai_model_routing";
const SETTINGS_KEY_TELEMETRY_OPTOUT:   &str = "telemetry_optout";
const SETTINGS_KEY_LOCAL_ONLY:         &str = "local_only_mode";
const SETTINGS_KEY_RELEASE_CHANNEL:    &str = "release_channel";
const SETTINGS_KEY_LAST_UPDATE_CHECK:  &str = "last_update_check_ms";
const SETTINGS_KEY_USER_ONBOARDED:     &str = "user_onboarded";
const SETTINGS_KEY_HTTP_PROXY_PORT:    &str = "http_proxy_port";
const SETTINGS_KEY_HTTP_PROXY_ENABLED: &str = "http_proxy_enabled";
const SETTINGS_KEY_FS_SENSOR_ENABLED:  &str = "fs_sensor_enabled";
/// Sesión 25 — toggle that gates the Kortix FastApply-7B local path
/// inside `run_single_shot`. Mirrored at
/// `crate::ipc::remediation::SETTINGS_KEY_LOCAL_APPLY_ENABLED`. Keep
/// the two constants byte-identical: future renames must touch both.
const SETTINGS_KEY_LOCAL_APPLY_ENABLED: &str = "local_apply_enabled";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct GeneralSettings {
    /// `auto` / `light` / `dark`.
    pub theme:              String,
    /// `en` / `es` (initial). Forward-compat: arbitrary BCP-47 string.
    pub language:           String,
    pub sound_on_critical:  bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GeneralSettingsPatch {
    pub theme:             Option<String>,
    pub language:          Option<String>,
    pub sound_on_critical: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct NotificationsSettings {
    /// `silent` / `important` / `all`.
    pub notification_level: String,
    /// 0–100.
    pub sound_volume:       u8,
    /// "HH:MM" — empty when quiet hours are off.
    pub quiet_hours_start:  String,
    pub quiet_hours_end:    String,
    /// IANA tz, e.g. `America/Mexico_City`. Empty = system default.
    pub quiet_hours_tz:     String,
    pub respect_focus_mode: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NotificationsSettingsPatch {
    pub notification_level: Option<String>,
    pub sound_volume:       Option<u8>,
    pub quiet_hours_start:  Option<String>,
    pub quiet_hours_end:    Option<String>,
    pub quiet_hours_tz:     Option<String>,
    pub respect_focus_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct AiSettings {
    /// Truthy when a BYOK key is on disk. Raw key NEVER returned.
    pub byok_present:    bool,
    /// Last 4 chars of the BYOK key for "still configured" affordances.
    /// Empty when no key is set.
    pub byok_preview:    String,
    /// `auto` / `always_mini` / `always_full`. Defaults to `auto`.
    pub model_routing:   String,
    /// Hardcoded read-only display today; Sesión 18 wires real billing.
    pub spend_today_usd: f32,
    pub spend_cap_usd:   f32,
    /// Sesión 25 — Fast Apply via local Kortix FastApply-7B. False by
    /// default. Reading the toggle is cheap (a settings table lookup);
    /// writing requires the hardware tier ≥ 2 + the GGUF pre-downloaded.
    /// Both prerequisites are validated inside `run_single_shot`'s local
    /// branch, NOT here — the toggle just expresses user intent.
    pub local_apply_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AiSettingsPatch {
    /// Raw key. Empty string deletes. `None` keeps prior value.
    pub openai_key:    Option<String>,
    pub model_routing: Option<String>,
    /// Sesión 25 — flip the Kortix FastApply-7B routing on/off. None
    /// keeps the prior value.
    pub local_apply_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct PrivacySettings {
    pub telemetry_optout: bool,
    pub local_only_mode:  bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PrivacySettingsPatch {
    pub telemetry_optout: Option<bool>,
    pub local_only_mode:  Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct AboutInfo {
    pub version:               String,
    pub commit:                Option<String>,
    /// `stable` / `beta`.
    pub channel:               String,
    /// Unix ms of the last update check (0 = never).
    pub last_update_check_ms:  i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct AboutChannelPatch {
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct UpdateCheckResult {
    /// `idle` (no update), `pending` (download in flight), `ready` (apply on restart).
    pub status:        String,
    pub message:       String,
    pub checked_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct RepoSummaryDto {
    pub id:                  String,
    pub path:                String,
    pub name:                String,
    pub opened_at_ms:        i64,
    pub last_indexed_at_ms:  Option<i64>,
    pub indexed_file_count:  i64,
    pub symbol_count:        i64,
    pub replay_enabled:      bool,
}

impl From<queries::RepoSummary> for RepoSummaryDto {
    fn from(s: queries::RepoSummary) -> Self {
        Self {
            id:                 s.id,
            path:               s.path,
            name:               s.name,
            opened_at_ms:       s.opened_at_ms,
            last_indexed_at_ms: s.last_indexed_at_ms,
            indexed_file_count: s.indexed_file_count,
            symbol_count:       s.symbol_count,
            replay_enabled:     s.replay_enabled,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct WipeRepoMemoryResult {
    pub repo_id:    String,
    pub symbols:    i64,
    pub embeddings: i64,
    pub events:     i64,
    pub patterns:   i64,
}

// ── General ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_general_settings(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<GeneralSettings, IpcError> {
    Ok(GeneralSettings {
        theme:              read_theme_or_auto(&state)?,
        language:           read_string_or(&state, SETTINGS_KEY_LANGUAGE, "en")?,
        sound_on_critical:  read_bool_or(&state, SETTINGS_KEY_SOUND_ON_CRITICAL, true)?,
    })
}

#[tauri::command]
pub fn set_general_settings(
    state: tauri::State<'_, Arc<Store>>,
    patch: GeneralSettingsPatch,
) -> Result<GeneralSettings, IpcError> {
    if let Some(t) = patch.theme {
        if matches!(t.as_str(), "auto" | "light" | "dark") {
            settings::set(&state, "theme", &t)?;
        }
    }
    if let Some(lang) = patch.language {
        let trimmed = lang.trim();
        if !trimmed.is_empty() {
            settings::set(&state, SETTINGS_KEY_LANGUAGE, trimmed)?;
        }
    }
    if let Some(b) = patch.sound_on_critical {
        settings::set(&state, SETTINGS_KEY_SOUND_ON_CRITICAL, &b.to_string())?;
    }
    get_general_settings(state)
}

// ── Notifications ────────────────────────────────────────────────────

#[tauri::command]
pub fn get_notifications_settings(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<NotificationsSettings, IpcError> {
    Ok(NotificationsSettings {
        notification_level: read_string_or(&state, SETTINGS_KEY_NOTIFICATION_LEVEL, "important")?,
        sound_volume:       read_u8_or(&state, SETTINGS_KEY_SOUND_VOLUME, 70)?,
        quiet_hours_start:  read_string_or(&state, SETTINGS_KEY_QUIET_HOURS_START, "")?,
        quiet_hours_end:    read_string_or(&state, SETTINGS_KEY_QUIET_HOURS_END, "")?,
        quiet_hours_tz:     read_string_or(&state, SETTINGS_KEY_QUIET_HOURS_TZ, "")?,
        respect_focus_mode: read_bool_or(&state, SETTINGS_KEY_RESPECT_FOCUS, true)?,
    })
}

#[tauri::command]
pub fn set_notifications_settings(
    state: tauri::State<'_, Arc<Store>>,
    patch: NotificationsSettingsPatch,
) -> Result<NotificationsSettings, IpcError> {
    if let Some(level) = patch.notification_level {
        if matches!(level.as_str(), "silent" | "important" | "all") {
            settings::set(&state, SETTINGS_KEY_NOTIFICATION_LEVEL, &level)?;
        }
    }
    if let Some(v) = patch.sound_volume {
        let v = v.min(100);
        settings::set(&state, SETTINGS_KEY_SOUND_VOLUME, &v.to_string())?;
    }
    apply_optional_string(&state, SETTINGS_KEY_QUIET_HOURS_START, patch.quiet_hours_start)?;
    apply_optional_string(&state, SETTINGS_KEY_QUIET_HOURS_END,   patch.quiet_hours_end)?;
    apply_optional_string(&state, SETTINGS_KEY_QUIET_HOURS_TZ,    patch.quiet_hours_tz)?;
    if let Some(b) = patch.respect_focus_mode {
        settings::set(&state, SETTINGS_KEY_RESPECT_FOCUS, &b.to_string())?;
    }
    get_notifications_settings(state)
}

// ── AI / BYOK ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_ai_settings(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<AiSettings, IpcError> {
    let raw = settings::get(&state, SETTINGS_KEY_OPENAI_BYOK)?;
    let (present, preview) = match raw.as_deref() {
        Some(s) if !s.is_empty() => (true, redact_byok(s)),
        _                        => (false, String::new()),
    };
    Ok(AiSettings {
        byok_present:    present,
        byok_preview:    preview,
        model_routing:   read_string_or(&state, SETTINGS_KEY_AI_MODEL, "auto")?,
        spend_today_usd: 0.0,
        spend_cap_usd:   300.0,
        local_apply_enabled: read_bool_or(&state, SETTINGS_KEY_LOCAL_APPLY_ENABLED, false)?,
    })
}

#[tauri::command]
pub fn set_ai_settings(
    state: tauri::State<'_, Arc<Store>>,
    patch: AiSettingsPatch,
) -> Result<AiSettings, IpcError> {
    if let Some(key) = patch.openai_key {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            settings::delete(&state, SETTINGS_KEY_OPENAI_BYOK)?;
        } else {
            // Light validation — reject obvious garbage but accept any
            // OpenAI-looking key (sk-... or sk-proj-...). The platform
            // does the real auth check.
            if !looks_like_openai_key(trimmed) {
                return Err(IpcError::Internal {
                    message: "BYOK key must start with 'sk-' (OpenAI format)".to_string(),
                });
            }
            settings::set(&state, SETTINGS_KEY_OPENAI_BYOK, trimmed)?;
        }
    }
    if let Some(routing) = patch.model_routing {
        if matches!(routing.as_str(), "auto" | "always_mini" | "always_full") {
            settings::set(&state, SETTINGS_KEY_AI_MODEL, &routing)?;
        }
    }
    if let Some(b) = patch.local_apply_enabled {
        settings::set(&state, SETTINGS_KEY_LOCAL_APPLY_ENABLED, &b.to_string())?;
    }
    get_ai_settings(state)
}

// ── Privacy ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_privacy_settings(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<PrivacySettings, IpcError> {
    Ok(PrivacySettings {
        telemetry_optout: read_bool_or(&state, SETTINGS_KEY_TELEMETRY_OPTOUT, false)?,
        local_only_mode:  read_bool_or(&state, SETTINGS_KEY_LOCAL_ONLY, false)?,
    })
}

#[tauri::command]
pub fn set_privacy_settings(
    state: tauri::State<'_, Arc<Store>>,
    patch: PrivacySettingsPatch,
) -> Result<PrivacySettings, IpcError> {
    if let Some(b) = patch.telemetry_optout {
        settings::set(&state, SETTINGS_KEY_TELEMETRY_OPTOUT, &b.to_string())?;
    }
    if let Some(b) = patch.local_only_mode {
        settings::set(&state, SETTINGS_KEY_LOCAL_ONLY, &b.to_string())?;
    }
    get_privacy_settings(state)
}

// ── About ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_about_info(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<AboutInfo, IpcError> {
    Ok(AboutInfo {
        version:              env!("CARGO_PKG_VERSION").to_string(),
        commit:               option_env!("GIT_SHA").map(|s| s.to_string()),
        channel:              read_string_or(&state, SETTINGS_KEY_RELEASE_CHANNEL, "stable")?,
        last_update_check_ms: read_i64_or(&state, SETTINGS_KEY_LAST_UPDATE_CHECK, 0)?,
    })
}

#[tauri::command]
pub fn set_release_channel(
    state: tauri::State<'_, Arc<Store>>,
    patch: AboutChannelPatch,
) -> Result<AboutInfo, IpcError> {
    if matches!(patch.channel.as_str(), "stable" | "beta") {
        settings::set(&state, SETTINGS_KEY_RELEASE_CHANNEL, &patch.channel)?;
    }
    get_about_info(state)
}

#[tauri::command]
pub fn check_for_updates(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<UpdateCheckResult, IpcError> {
    // Stub for Sesión 17. The real Tauri updater plugin lands a future
    // session — calling its `check` requires `tauri::Manager` + an
    // event loop, which we don't have here. Mark the moment so the UI
    // shows "Last checked" and return idle.
    let now = now_ms();
    settings::set(&state, SETTINGS_KEY_LAST_UPDATE_CHECK, &now.to_string())?;
    Ok(UpdateCheckResult {
        status:        "idle".to_string(),
        message:       "You're up to date.".to_string(),
        checked_at_ms: now,
    })
}

// ── Repos ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_repos_list(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<Vec<RepoSummaryDto>, IpcError> {
    let rows = queries::list_repos_with_metrics(&state)?;
    Ok(rows.into_iter().map(RepoSummaryDto::from).collect())
}

#[tauri::command]
pub fn wipe_repo_memory(
    state:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<WipeRepoMemoryResult, IpcError> {
    let counts = queries::wipe_repo_index(&state, &repo_id)?;
    Ok(WipeRepoMemoryResult {
        repo_id,
        symbols:    counts.symbols    as i64,
        embeddings: counts.embeddings as i64,
        events:     counts.events     as i64,
        patterns:   counts.patterns   as i64,
    })
}

// ── helpers ─────────────────────────────────────────────────────────

fn apply_optional_string(
    store: &Store,
    key:   &str,
    val:   Option<String>,
) -> Result<(), IpcError> {
    if let Some(v) = val {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            settings::delete(store, key)?;
        } else {
            settings::set(store, key, trimmed)?;
        }
    }
    Ok(())
}

fn read_string_or(
    store:    &Store,
    key:      &str,
    fallback: &str,
) -> Result<String, IpcError> {
    Ok(settings::get(store, key)?
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_string()))
}

fn read_bool_or(
    store:    &Store,
    key:      &str,
    fallback: bool,
) -> Result<bool, IpcError> {
    Ok(match settings::get(store, key)?.as_deref() {
        Some("true")  | Some("1") | Some("yes") => true,
        Some("false") | Some("0") | Some("no")  => false,
        _ => fallback,
    })
}

fn read_u8_or(store: &Store, key: &str, fallback: u8) -> Result<u8, IpcError> {
    Ok(settings::get(store, key)?
        .as_deref()
        .and_then(|s| s.parse::<u8>().ok())
        .unwrap_or(fallback))
}

fn read_i64_or(store: &Store, key: &str, fallback: i64) -> Result<i64, IpcError> {
    Ok(settings::get(store, key)?
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(fallback))
}

fn read_theme_or_auto(store: &Store) -> Result<String, IpcError> {
    let raw = settings::get(store, "theme")?;
    Ok(match raw.as_deref() {
        Some(t @ ("auto" | "light" | "dark")) => t.to_string(),
        _                                     => "auto".to_string(),
    })
}

fn looks_like_openai_key(s: &str) -> bool {
    // OpenAI keys: `sk-...` (legacy) or `sk-proj-...`. Length sanity 20+.
    s.starts_with("sk-") && s.len() >= 20 && s.chars().all(|c| !c.is_whitespace())
}

fn redact_byok(s: &str) -> String {
    if s.len() <= 8 {
        return "sk-***".to_string();
    }
    let tail: String = s.chars().rev().take(4).collect::<String>().chars().rev().collect();
    format!("sk-***...***{}", tail)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Exported for cross-module use — onboarding completion + sensors KV.
pub const KEY_USER_ONBOARDED:     &str = SETTINGS_KEY_USER_ONBOARDED;
pub const KEY_HTTP_PROXY_PORT:    &str = SETTINGS_KEY_HTTP_PROXY_PORT;
pub const KEY_HTTP_PROXY_ENABLED: &str = SETTINGS_KEY_HTTP_PROXY_ENABLED;
pub const KEY_FS_SENSOR_ENABLED:  &str = SETTINGS_KEY_FS_SENSOR_ENABLED;
