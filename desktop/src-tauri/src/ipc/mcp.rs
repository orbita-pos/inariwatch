//! Tauri command shells for the local MCP server (Session 7).
//!
//! Light, typed payloads only — heavy data (codebase search results,
//! AST traversals) flows through the MCP HTTP transport itself, not
//! through these IPC commands. Per `ARCHITECTURE.md` § *Heavy-data
//! IPC rule*.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::sensors::mcp::install::{self, McpClient};
use crate::sensors::mcp::McpServerHandle;

use super::error::IpcError;

/// What the Settings UI shows beside "Inari Live MCP" — a port and a
/// Bearer token. Token is the raw value; UI is responsible for the
/// "Copy" button + masking. Port is read-only (server picks at boot
/// via fallback).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct McpAuthDto {
    pub token:      String,
    pub port:       u16,
    pub created_at: i64,
}

#[tauri::command]
pub fn get_mcp_token(
    handle: tauri::State<'_, Arc<McpServerHandle>>,
) -> Result<McpAuthDto, IpcError> {
    let snap = handle.auth.snapshot();
    Ok(McpAuthDto {
        token:      snap.token,
        port:       handle.port,
        created_at: snap.created_at,
    })
}

#[tauri::command]
pub fn regenerate_mcp_token(
    handle: tauri::State<'_, Arc<McpServerHandle>>,
) -> Result<McpAuthDto, IpcError> {
    let fresh = handle.auth.regenerate().map_err(IpcError::from)?;
    Ok(McpAuthDto {
        token:      fresh.token,
        port:       handle.port,
        created_at: fresh.created_at,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct ClientStatusDto {
    pub client:          String,
    pub installed:       bool,
    pub path:            String,
    pub matches_current: bool,
}

#[tauri::command]
pub fn list_mcp_clients_status(app: AppHandle) -> Result<Vec<ClientStatusDto>, IpcError> {
    let home = home_dir(&app)?;
    let sidecar = sidecar_path(&app);
    let clients = [
        McpClient::ClaudeCode,
        McpClient::Codex,
        McpClient::Cursor,
        McpClient::Zed,
    ];
    let out = clients
        .iter()
        .map(|c| {
            let s = install::status_for(&home, *c, &sidecar);
            ClientStatusDto {
                client:          s.client,
                installed:       s.installed,
                path:            s.path,
                matches_current: s.matches_current,
            }
        })
        .collect();
    Ok(out)
}

#[tauri::command]
pub fn install_mcp_for(app: AppHandle, client: String) -> Result<serde_json::Value, IpcError> {
    let parsed = McpClient::parse(&client).ok_or_else(|| IpcError::invalid_path(
        &client,
        "unknown MCP client (expected: claude-code | codex | cursor | zed)",
    ))?;
    let home = home_dir(&app)?;
    let sidecar = sidecar_path(&app);
    let outcome = install::install_for(&home, parsed, &sidecar).map_err(IpcError::from)?;
    serde_json::to_value(outcome).map_err(|e| IpcError::internal(e.to_string()))
}

#[tauri::command]
pub fn uninstall_mcp_for(app: AppHandle, client: String) -> Result<serde_json::Value, IpcError> {
    let parsed = McpClient::parse(&client).ok_or_else(|| IpcError::invalid_path(
        &client,
        "unknown MCP client (expected: claude-code | codex | cursor | zed)",
    ))?;
    let home = home_dir(&app)?;
    let outcome = install::uninstall_for(&home, parsed).map_err(IpcError::from)?;
    serde_json::to_value(outcome).map_err(|e| IpcError::internal(e.to_string()))
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    app.path()
        .home_dir()
        .map_err(|e| IpcError::internal(format!("could not resolve home_dir: {e}")))
}

/// Resolve the sidecar binary path. In production the sidecar ships
/// next to the main binary in the bundle; in dev / tests we point at
/// the cargo target directory or a $PATH lookup. We prefer
/// `<exe_dir>/inari-mcp-stdio[.exe]` and fall back to the literal name
/// (which lets the user put it on PATH if needed).
fn sidecar_path(app: &AppHandle) -> PathBuf {
    let exe_name = if cfg!(windows) { "inari-mcp-stdio.exe" } else { "inari-mcp-stdio" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(exe_name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    let _ = app; // reserved for resource_dir lookup once Tauri bundles the sidecar
    PathBuf::from(exe_name)
}
