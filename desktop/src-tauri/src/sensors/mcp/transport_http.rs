//! HTTP transport — axum router on `127.0.0.1:<port>`.
//!
//! - `POST /mcp`         — JSON-RPC 2.0 (single + batch). Bearer auth.
//! - `GET  /mcp/health`  — liveness ping (no auth, returns the server
//!                         version + tool count).
//! - `GET  /mcp/auth`    — current Bearer token (auth-required:
//!                         protect against drive-by reads from other
//!                         localhost processes).
//!
//! Port fallback policy (Sesión 7 decision): try the configured port,
//! then 9876 → 9877 → 9878 → … → MAX_FALLBACK. Whichever binds first
//! wins; the chosen port is logged + persisted back to the SQL
//! settings store under key `mcp_port` so subsequent boots reuse it.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::auth::AuthState;
use super::server::Server;

pub const DEFAULT_PORT:        u16 = 9876;
pub const FALLBACK_PORT_RANGE: u16 = 16;     // try 9876..=9891
pub const MAX_FALLBACK:        u16 = DEFAULT_PORT + FALLBACK_PORT_RANGE;
pub const BIND_HOST:           &str = "127.0.0.1";

#[derive(Clone)]
pub struct HttpState {
    pub server: Server,
    pub auth:   AuthState,
}

/// Build the axum router for the MCP HTTP transport. Exposed publicly
/// so integration tests can mount it onto an in-process listener.
pub fn router(state: HttpState) -> Router {
    Router::new()
        .route("/mcp",        post(handle_mcp))
        .route("/mcp/health", get(handle_health))
        .route("/mcp/auth",   get(handle_auth))
        .with_state(Arc::new(state))
}

async fn handle_health(State(state): State<Arc<HttpState>>) -> impl IntoResponse {
    Json(json!({
        "ok":         true,
        "name":       "inari-live",
        "version":    env!("CARGO_PKG_VERSION"),
        "tool_count": state.server.tool_count(),
    }))
}

async fn handle_auth(
    headers: HeaderMap,
    State(state): State<Arc<HttpState>>,
) -> impl IntoResponse {
    if !verify_bearer(&headers, &state.auth) {
        return (StatusCode::UNAUTHORIZED, Json(json!({
            "error": "missing or wrong Bearer token"
        }))).into_response();
    }
    Json(json!({
        "token":      state.auth.token(),
        "created_at": state.auth.snapshot().created_at,
    })).into_response()
}

async fn handle_mcp(
    headers: HeaderMap,
    State(state): State<Arc<HttpState>>,
    body: String,
) -> impl IntoResponse {
    if !verify_bearer(&headers, &state.auth) {
        return (StatusCode::UNAUTHORIZED, Json(json!({
            "jsonrpc": "2.0",
            "id":      Value::Null,
            "error": {
                "code":    -32001,
                "message": "Unauthorized: provide Authorization: Bearer <ilive_…>",
            }
        }))).into_response();
    }

    let response = state.server.handle_raw(&body);
    (StatusCode::OK, Json(response)).into_response()
}

fn verify_bearer(headers: &HeaderMap, auth: &AuthState) -> bool {
    let raw = match headers.get("authorization") {
        Some(v) => v,
        None    => return false,
    };
    let s = match raw.to_str() {
        Ok(s)  => s,
        Err(_) => return false,
    };
    let token = match s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")) {
        Some(t) => t.trim(),
        None    => return false,
    };
    auth.validate(token)
}

/// Resolve the port to bind on. Tries `requested` first; if that's
/// taken (or `None`), walks `DEFAULT_PORT..=MAX_FALLBACK` and returns
/// the first that binds. Returns `(socket, port)` so the caller can
/// log + persist.
pub fn bind_with_fallback(
    requested: Option<u16>,
) -> std::io::Result<(std::net::TcpListener, u16)> {
    let attempts: Vec<u16> = std::iter::once(requested.unwrap_or(DEFAULT_PORT))
        .chain((DEFAULT_PORT..=MAX_FALLBACK).filter(|p| Some(*p) != requested))
        .collect();
    let mut last_err: Option<std::io::Error> = None;
    for port in attempts {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        match std::net::TcpListener::bind(addr) {
            Ok(sock) => {
                sock.set_nonblocking(true)?;
                return Ok((sock, port));
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::new(
        std::io::ErrorKind::AddrInUse,
        "no port available in fallback range",
    )))
}

/// Spawn the axum listener as a tokio task and return the bound port.
/// Used by `spawn_mcp_server`. Tests use [`router`] directly — they
/// don't need the listener.
pub async fn serve(
    state: HttpState,
    requested: Option<u16>,
) -> std::io::Result<u16> {
    let (std_listener, port) = bind_with_fallback(requested)?;
    let listener = tokio::net::TcpListener::from_std(std_listener)?;
    let app = router(state);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "MCP HTTP listener exited");
        }
    });
    Ok(port)
}
