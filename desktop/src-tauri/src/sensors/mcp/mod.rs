//! Sensor 3 — local MCP server (Session 7).
//!
//! Exposes the 26 InariWatch tools (the SSOT registry at
//! `web/app/api/mcp/registry.ts` includes `rollback_vercel` as a
//! legacy alias of `rollback_deploy` in addition to the canonical 25)
//! over JSON-RPC 2.0:
//!
//!   * HTTP transport — `127.0.0.1:<port>/mcp`, Bearer auth, used by
//!     editors that read the host/port from a config snippet.
//!   * stdio transport — sidecar binary `inari-mcp-stdio` that
//!     forwards stdin frames to the HTTP listener. Spawned by Claude
//!     Code / Codex / Cursor / Zed when the user runs the install
//!     command.
//!
//! The 5 tools with real local implementations are documented in
//! `tools::registry()`. The other 21 are `Stub`s that return an
//! actionable "not yet wired" envelope so MCP clients show useful
//! text instead of an opaque error.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::daemon::DaemonHandle;
use crate::store::{self, Store};

pub mod auth;
pub mod error;
pub mod install;
pub mod jsonrpc;
pub mod server;
pub mod tools;
pub mod transport_http;
pub mod transport_stdio;

pub use auth::{AuthState, McpAuth};
pub use install::{ClientStatus, InstallOutcome, McpClient};
pub use server::Server;

/// In-process handle to the running MCP server. Held in `tauri::State`
/// so the Tauri command surface can surface `port` + `token` to the
/// Settings UI without re-deriving them.
#[derive(Clone)]
pub struct McpServerHandle {
    pub port: u16,
    pub auth: AuthState,
}

/// Resolve the on-disk parent for `auth.json`. Mirrors
/// `Store::resolve_db_path` so production paths are consistent.
pub fn resolve_state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("inari-live"))
        .map_err(|e| format!("could not resolve app_local_data_dir: {e}"))
}

/// Spawn the MCP server. Called once from `lib.rs::setup` after the
/// daemon is up. Returns the handle so `lib.rs` can `app.manage(...)`
/// it.
///
/// Steps:
///   1. Resolve `auth.json` directory + load/create the Bearer token.
///   2. Read `mcp_port` from SQL settings (Sesión 4 store) — None on
///      first boot.
///   3. Bind 9876, falling back through 9876..=9891 until something
///      sticks.
///   4. Persist the chosen port back to SQL settings so the next boot
///      starts from there (avoids surprising port shuffles).
///   5. Spawn the axum listener as a tokio task.
pub async fn spawn_mcp_server(
    app:    &AppHandle,
    daemon: Arc<DaemonHandle>,
    store:  Arc<Store>,
) -> Result<McpServerHandle, String> {
    let state_dir = resolve_state_dir(app)?;
    let auth = AuthState::from_dir(state_dir).map_err(|e| {
        format!("mcp auth init failed: {e}")
    })?;

    let requested = store::settings::get(&store, "mcp_port")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u16>().ok());

    let server = Server::new(tools::ToolContext {
        store:  store.clone(),
        daemon: daemon.clone(),
    });

    let state = transport_http::HttpState {
        server,
        auth: auth.clone(),
    };

    let port = transport_http::serve(state, requested).await.map_err(|e| {
        format!("mcp http listener failed to bind: {e}")
    })?;

    if let Err(e) = store::settings::set(&store, "mcp_port", &port.to_string()) {
        tracing::warn!(error = %e, "failed to persist mcp_port to settings");
    }
    // Sidecar binary `inari-mcp-stdio` reads `port.txt` next to
    // `auth.json` so it can resolve the running port without depending
    // on the SQL store. Writing failure is non-fatal — env-var
    // override still works.
    if let Some(state_dir) = app.path().app_local_data_dir().ok().map(|p| p.join("inari-live")) {
        let port_file = state_dir.join("port.txt");
        if let Err(e) = std::fs::write(&port_file, port.to_string()) {
            tracing::warn!(error = %e, path = %port_file.display(), "failed to write port.txt");
        }
    }
    daemon.state.inc_sensors();
    tracing::info!(port = port, tool_count = 26, "MCP HTTP listener up");

    Ok(McpServerHandle { port, auth })
}
