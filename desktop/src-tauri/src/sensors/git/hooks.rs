//! HTTP handlers for `POST /sensors/git/event`.
//!
//! This module owns:
//!   * The Bearer auth check against the git-hook-token (NOT the MCP
//!     Bearer — see `token.rs` for the rationale).
//!   * Deserialising the payload (`{ kind, repo_id, ref, sha,
//!     diff_size }`).
//!   * Publishing fire-and-forget events to the daemon bus
//!     (`pre_commit`, `post_commit`, `post_merge`).
//!   * Running the local pre-push gate synchronously and returning
//!     `{ allow, reason, verdicts }`.
//!   * Publishing `DaemonEvent::ReindexRequested` after `post_merge`.
//!
//! The state struct is intentionally tiny — we hold an `Arc<DaemonHandle>`
//! (for the bus), an `Arc<Store>` (for the gate), and a `String` token.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::daemon::{DaemonEvent, DaemonHandle, GitEventKind};
use crate::store::{queries, Store};

use super::gate;

/// Mounted at `/sensors/git/event`. The MCP HTTP listener merges this
/// router via `axum::Router::merge` so we don't open a second port.
pub const ROUTE_PATH: &str = "/sensors/git/event";

#[derive(Clone)]
pub struct GitHookState {
    pub daemon: Arc<DaemonHandle>,
    pub store:  Arc<Store>,
    pub token:  String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GitEventPayload {
    pub kind:      String,
    pub repo_id:   String,
    #[serde(rename = "ref")]
    pub ref_name:  String,
    pub sha:       String,
    #[serde(default)]
    pub diff_size: usize,
}

#[derive(Debug, Clone, Serialize)]
struct PrePushResponse {
    pub allow:    bool,
    pub reason:   Option<String>,
    pub verdicts: Vec<gate::GateVerdict>,
}

/// Build the router fragment to merge into the MCP HTTP listener.
/// Tests mount this on an ephemeral listener and POST against it.
pub fn router(state: GitHookState) -> Router {
    Router::new()
        .route(ROUTE_PATH, post(handle_event))
        .with_state(Arc::new(state))
}

async fn handle_event(
    headers: HeaderMap,
    State(state): State<Arc<GitHookState>>,
    body: String,
) -> impl IntoResponse {
    if !verify_bearer(&headers, &state.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({
            "error": "missing or wrong git_hook_token"
        }))).into_response();
    }

    let payload: GitEventPayload = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({
            "error": format!("invalid payload: {e}"),
        }))).into_response(),
    };

    // Repo must be opened; 404 (not 401) so the hook script can
    // distinguish "I forgot to add this repo" from "wrong token".
    match queries::find_repo_path_by_id(&state.store, &payload.repo_id) {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({
            "error": format!("repo not registered: {}", payload.repo_id),
        }))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("store: {e}"),
        }))).into_response(),
    }

    let kind_lower = payload.kind.to_ascii_lowercase();
    match kind_lower.as_str() {
        "pre_commit" | "pre-commit" => {
            publish_git_event(&state, GitEventKind::PreCommit, &payload);
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        "post_commit" | "post-commit" => {
            publish_git_event(&state, GitEventKind::PostCommit, &payload);
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        "post_merge" | "post-merge" => {
            publish_git_event(&state, GitEventKind::PostMerge, &payload);
            // Wake the indexer so a `git pull`/`git merge` re-walks
            // the repo. The indexer is the only subscriber for this
            // variant today (Sesión 6 wired it).
            state.daemon.bus.publish(DaemonEvent::ReindexRequested {
                repo_id: payload.repo_id.clone(),
            });
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        "pre_push" | "pre-push" => {
            publish_git_event(&state, GitEventKind::PrePush, &payload);
            let decision = gate::evaluate(&state.store, gate::GateInput {
                repo_id:   &payload.repo_id,
                diff_size: payload.diff_size,
            });
            let body = PrePushResponse {
                allow:    decision.allow,
                reason:   decision.reason,
                verdicts: decision.verdicts,
            };
            (StatusCode::OK, Json(body)).into_response()
        }
        _ => (StatusCode::BAD_REQUEST, Json(json!({
            "error": format!("unknown kind: {}", payload.kind),
        }))).into_response(),
    }
}

fn publish_git_event(state: &GitHookState, kind: GitEventKind, payload: &GitEventPayload) {
    state.daemon.bus.publish(DaemonEvent::GitEvent {
        kind,
        repo_id:  payload.repo_id.clone(),
        ref_name: payload.ref_name.clone(),
        sha:      payload.sha.clone(),
    });
}

fn verify_bearer(headers: &HeaderMap, expected: &str) -> bool {
    let raw = match headers.get("authorization") {
        Some(v) => v,
        None    => return false,
    };
    let s = match raw.to_str() {
        Ok(s)  => s,
        Err(_) => return false,
    };
    let presented = match s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")) {
        Some(t) => t.trim(),
        None    => return false,
    };
    if presented.len() != expected.len() {
        return false;
    }
    let a = presented.as_bytes();
    let b = expected.as_bytes();
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}
