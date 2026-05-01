//! Sensor toggles surfaced in Settings → Sensors (Sesión 17).
//!
//! Six sensors are visible to the user; one (MCP) is always on by
//! design and rejects toggle attempts at the IPC layer with a benign
//! result that mirrors the on-disk state. The other five (FS / Shell /
//! Git / HTTP / Substrate) accept toggles.
//!
//! Some sensors store their state in the SQL `settings` KV, others on
//! per-repo flags (Substrate uses `repos.replay_enabled` from migration
//! 0004). The DTOs returned here are flat so the React layer never
//! needs to peek at storage.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;

use crate::sensors::shell::installer as shell_installer;
use crate::sensors::shell::installer::ShellKind;
use crate::store::{queries, settings, Store};

use super::error::IpcError;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct SensorsState {
    pub fs_enabled:        bool,
    /// MCP server is always-on by design (Sesión 7). Reported here so
    /// the UI can render an immutable "Always on" badge without an
    /// additional round-trip.
    pub mcp_always_on:     bool,
    pub shell_installed:   Vec<String>,
    pub git_hooks_count:   u32,
    pub http_proxy_enabled: bool,
    pub http_proxy_port:   u16,
    /// Aggregate replay flag — true when at least one repo has
    /// `replay_enabled = true`.
    pub substrate_any_repo: bool,
}

#[tauri::command]
pub fn get_sensors_state(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<SensorsState, IpcError> {
    let fs_enabled = match settings::get(&state, super::settings::KEY_FS_SENSOR_ENABLED)? {
        Some(s) => matches!(s.as_str(), "true" | "1"),
        None    => true,
    };
    let http_proxy_enabled = match settings::get(&state, super::settings::KEY_HTTP_PROXY_ENABLED)? {
        Some(s) => matches!(s.as_str(), "true" | "1"),
        None    => false,
    };
    let http_proxy_port = settings::get(&state, super::settings::KEY_HTTP_PROXY_PORT)?
        .as_deref()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(9876);
    let shell_installed = shell_install_status();
    let substrate_any_repo = repos_any_replay_enabled(&state)?;

    Ok(SensorsState {
        fs_enabled,
        mcp_always_on: true,
        shell_installed,
        git_hooks_count: 0,
        http_proxy_enabled,
        http_proxy_port,
        substrate_any_repo,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct SensorTogglePatch {
    pub sensor_kind: String,
    pub enabled:     bool,
}

#[tauri::command]
pub fn set_sensor_enabled(
    state:  tauri::State<'_, Arc<Store>>,
    patch:  SensorTogglePatch,
) -> Result<SensorsState, IpcError> {
    match patch.sensor_kind.as_str() {
        "fs" => {
            settings::set(&state, super::settings::KEY_FS_SENSOR_ENABLED, &patch.enabled.to_string())?;
        }
        "http" => {
            settings::set(
                &state,
                super::settings::KEY_HTTP_PROXY_ENABLED,
                &patch.enabled.to_string(),
            )?;
        }
        "mcp" => {
            // Always-on per design. Accept the call so the React layer
            // doesn't have to special-case the toggle, but no-op the
            // write — UI shows the immutable badge from `get_sensors_state`.
        }
        other => {
            return Err(IpcError::Internal {
                message: format!("unknown sensor_kind '{}' (use install_shell_hooks / install_git_hooks / set_replay_enabled)", other),
            });
        }
    }
    get_sensors_state(state)
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct ShellHooksStatusDto {
    pub installed_for:    Vec<String>,
    pub daemon_listening: bool,
}

#[tauri::command]
pub fn shell_hooks_status() -> Result<ShellHooksStatusDto, IpcError> {
    let installed_for = shell_install_status();
    // The shell sensor binds its socket lazily; we report the listener
    // status best-effort here. False is a safe default — the UI shows
    // a "checking" spinner until the daemon's heartbeat confirms.
    Ok(ShellHooksStatusDto {
        installed_for,
        daemon_listening: false,
    })
}

#[tauri::command]
pub fn install_shell_hooks(
    shell_kind: String,
) -> Result<ShellHooksStatusDto, IpcError> {
    let kind = parse_shell_kind(&shell_kind)?;
    let home = shell_installer::resolve_home()
        .map_err(|e| IpcError::internal(format!("home dir: {}", e)))?;
    shell_installer::install(kind, &home)
        .map_err(|e| IpcError::internal(format!("install shell hook: {}", e)))?;
    shell_hooks_status()
}

#[tauri::command]
pub fn uninstall_shell_hooks(
    shell_kind: String,
) -> Result<ShellHooksStatusDto, IpcError> {
    let kind = parse_shell_kind(&shell_kind)?;
    let home = shell_installer::resolve_home()
        .map_err(|e| IpcError::internal(format!("home dir: {}", e)))?;
    shell_installer::uninstall(kind, &home)
        .map_err(|e| IpcError::internal(format!("uninstall shell hook: {}", e)))?;
    shell_hooks_status()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct ReplayEnabledDto {
    pub repo_id: String,
    pub enabled: bool,
}

#[tauri::command]
pub fn get_replay_enabled(
    state:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
) -> Result<ReplayEnabledDto, IpcError> {
    let enabled = queries::find_repo_replay_enabled(&state, &repo_id)?;
    Ok(ReplayEnabledDto { repo_id, enabled })
}

#[tauri::command]
pub fn set_replay_enabled(
    state:   tauri::State<'_, Arc<Store>>,
    repo_id: String,
    enabled: bool,
) -> Result<ReplayEnabledDto, IpcError> {
    queries::set_repo_replay_enabled(&state, &repo_id, enabled)?;
    Ok(ReplayEnabledDto { repo_id, enabled })
}

// ── Power-up stubs (Sesión 19/20/22 wires real impls) ────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct PowerUpResult {
    pub success: bool,
    pub message: String,
}

/// Stub for the VS Code extension installer. Sesión 22 wires the real
/// detection + extension push. Until then we accept the call so the
/// onboarding UI can record user intent without a dead-end error.
#[tauri::command]
pub fn install_vscode_extension(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<PowerUpResult, IpcError> {
    settings::set(&state, "powerup_vscode_pending", "true")?;
    Ok(PowerUpResult {
        success: true,
        message: "VS Code extension queued — finishing setup in Sesión 22".to_string(),
    })
}

/// Stub for the HTTP proxy configuration. Sesión 19/20 wires the real
/// proxy bootstrap. Today it just persists the user's preference so the
/// settings screen and onboarding agree on the toggle state.
#[tauri::command]
pub fn configure_http_proxy(
    state: tauri::State<'_, Arc<Store>>,
    port:  Option<u16>,
) -> Result<PowerUpResult, IpcError> {
    let port = port.unwrap_or(9876);
    if !(1024..=65535).contains(&port) {
        return Err(IpcError::Internal {
            message: format!("port {} out of range (1024..=65535)", port),
        });
    }
    settings::set(&state, super::settings::KEY_HTTP_PROXY_PORT, &port.to_string())?;
    settings::set(&state, super::settings::KEY_HTTP_PROXY_ENABLED, "true")?;
    Ok(PowerUpResult {
        success: true,
        message: format!("HTTP proxy queued on port {} — finishing setup in Sesión 19", port),
    })
}

// ── helpers ─────────────────────────────────────────────────────────

fn parse_shell_kind(raw: &str) -> Result<ShellKind, IpcError> {
    match raw {
        "zsh"  => Ok(ShellKind::Zsh),
        "bash" => Ok(ShellKind::Bash),
        "fish" => Ok(ShellKind::Fish),
        other  => Err(IpcError::Internal {
            message: format!("unknown shell_kind '{}' (zsh|bash|fish)", other),
        }),
    }
}

fn shell_install_status() -> Vec<String> {
    let home = match shell_installer::resolve_home() {
        Ok(h) => h,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for (kind, label) in [
        (ShellKind::Zsh,  "zsh"),
        (ShellKind::Bash, "bash"),
        (ShellKind::Fish, "fish"),
    ] {
        if hook_marker_present(&home, kind) {
            out.push(label.to_string());
        }
    }
    out
}

fn hook_marker_present(home: &PathBuf, shell: ShellKind) -> bool {
    let rc_relpath = match shell {
        ShellKind::Zsh  => ".zshrc",
        ShellKind::Bash => ".bashrc",
        ShellKind::Fish => ".config/fish/config.fish",
    };
    let rc_path = home.join(rc_relpath);
    match std::fs::read_to_string(&rc_path) {
        Ok(contents) => contents.contains(shell_installer::INARI_MARKER),
        Err(_)       => false,
    }
}

fn repos_any_replay_enabled(store: &Store) -> Result<bool, IpcError> {
    let conn = store.conn()?;
    let any: Option<i64> = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM repos WHERE replay_enabled = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| IpcError::Query { message: e.to_string() })?;
    Ok(any.unwrap_or(0) != 0)
}

#[allow(dead_code)]
fn unused_app_handle(_app: &AppHandle) {}
