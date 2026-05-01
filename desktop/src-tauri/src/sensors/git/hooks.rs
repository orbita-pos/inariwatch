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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ai::openai::OpenAIClient;
use crate::daemon::{DaemonEvent, DaemonHandle, GitEventKind};
use crate::gates::runner::{
    record_bypass, run_local_subset, GateRunInput, GATE_NAMES,
};
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
    /// Sesión 20 — optional OpenAI client for Gate 5 self-review. When
    /// `None`, the runner skips the AI call and Gate 5 surfaces as
    /// `deferred` (push proceeds). Wired by `lib.rs` to a singleton
    /// resolved from `OpenAIClient::from_store`; tests pass `None` to
    /// keep the runner deterministic.
    pub openai: Option<OpenAIClient>,
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
    /// Sesión 20 — diff body (capped 100KB) so the security scan can
    /// run without re-shelling. The hook script extracts via
    /// `git diff <sha>~..<sha>` and truncates client-side; the server
    /// also re-clamps to `MAX_BODY_BYTES` defensively. Optional for
    /// backwards-compat with older hook scripts (Sesión 8 shipped
    /// without this field — the runner falls back to scanning an
    /// empty body, Gate 9 passes, and the verdict is essentially Gate
    /// 5 + Gate 6 alone).
    #[serde(default)]
    pub diff_body: String,
    /// Sesión 20 — optional commit message for Gate 5's self-review
    /// prompt. The hook script reads it from the `pre-push` stdin
    /// (git already pipes the local refs there). Empty when the
    /// script can't resolve it.
    #[serde(default)]
    pub commit_message: String,
}

/// Sesión 20 — soft cap on the `diff_body` payload size so a
/// pathological diff can't exhaust memory or stall the regex scan.
/// 100 KB covers the vast majority of fix-shaped diffs (the auto-merge
/// gate already caps line-count at 500 by default, which is well
/// under this); larger pushes effectively get Gate 9 skipped via an
/// empty-body scan.
pub const MAX_BODY_BYTES: usize = 100 * 1024;

/// Sesión 20 — wall-clock deadline for the async runner. Beyond this
/// the HTTP handler returns `allow=false` with a "gate runner
/// timeout" reason so the user can retry or bypass. 30s lines up
/// with the substrate replay backend's own ceiling
/// (`replay_client::LOCAL_TIMEOUT`).
pub const RUNNER_DEADLINE: Duration = Duration::from_secs(30);

/// Sesión 20 — header the hook script sets when the user passed
/// `INARI_BYPASS=1`. Authoritative bypass surface; the IPC
/// `request_bypass` only marks the audit row post-hoc (the actual
/// push has already proceeded via the header).
pub const BYPASS_HEADER: &str = "x-inari-bypass";

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

            // Bypass header — the user explicitly chose to push despite
            // local gates. Mark audit row + emit GateBypassUsed +
            // return immediate allow. The async runner is NOT spawned.
            let bypass = headers.get(BYPASS_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim() == "1" || s.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if bypass {
                let run_id = new_run_id();
                record_bypass(
                    &state.daemon,
                    &state.store,
                    &run_id,
                    &payload.repo_id,
                    &payload.sha,
                    &payload.ref_name,
                    None,
                );
                let body = PrePushResponse {
                    allow:    true,
                    reason:   None,
                    verdicts: vec![gate::GateVerdict::deferred(
                        "bypass",
                        "INARI_BYPASS=1 — gates skipped by user",
                    )],
                };
                return (StatusCode::OK, Json(body)).into_response();
            }

            // Sync gates (1 + 4) run inline. If they block we never
            // reach the async runner.
            let inline = gate::evaluate(&state.store, gate::GateInput {
                repo_id:   &payload.repo_id,
                diff_size: payload.diff_size,
            });

            // Gate 1 disabled means auto-merge gating is off — push
            // proceeds without spawning the runner. Same posture as
            // the sync evaluator's deferred behaviour.
            let auto_merge_enabled = inline.verdicts.iter()
                .find(|v| v.name == "auto_merge_enabled")
                .map(|v| v.passed)
                .unwrap_or(true);
            if !auto_merge_enabled {
                let body = PrePushResponse {
                    allow:    false,
                    reason:   inline.reason,
                    verdicts: inline.verdicts,
                };
                return (StatusCode::OK, Json(body)).into_response();
            }

            // Gate 4 fails → block immediately, no async work.
            let lines_blocked = inline.verdicts.iter()
                .any(|v| v.name == "lines_changed" && !v.passed && !v.deferred);
            if lines_blocked {
                let body = PrePushResponse {
                    allow:    false,
                    reason:   inline.reason,
                    verdicts: inline.verdicts,
                };
                return (StatusCode::OK, Json(body)).into_response();
            }

            // Async runner: Gates 5 + 6 + 9 in parallel under a 30s
            // deadline. Body is clamped defensively even though the
            // hook script also truncates client-side.
            let mut diff_body = payload.diff_body.clone();
            if diff_body.len() > MAX_BODY_BYTES {
                // Round down to a UTF-8 char boundary so the
                // clip doesn't produce invalid input mid-multibyte.
                let mut end = MAX_BODY_BYTES;
                while end > 0 && !diff_body.is_char_boundary(end) {
                    end -= 1;
                }
                diff_body.truncate(end);
            }

            let run_id = new_run_id();
            let input = GateRunInput {
                run_id:         run_id.clone(),
                repo_id:        payload.repo_id.clone(),
                sha:            payload.sha.clone(),
                ref_:           payload.ref_name.clone(),
                diff_body,
                commit_message: payload.commit_message.clone(),
            };

            let outcome = match tokio::time::timeout(
                RUNNER_DEADLINE,
                run_local_subset(&state.daemon, &state.store, state.openai.as_ref(), &input),
            ).await {
                Ok(o)  => o,
                Err(_) => {
                    tracing::warn!(run_id = %run_id, "gate runner timed out — failing closed");
                    let timeout_verdicts: Vec<gate::GateVerdict> = GATE_NAMES.iter().map(|g| {
                        gate::GateVerdict::fail(g, "gate runner timeout (>30s) — try again or use [Push anyway]")
                    }).collect();
                    let body = PrePushResponse {
                        allow:    false,
                        reason:   Some("gate runner timeout — try again or use [Push anyway]".to_string()),
                        verdicts: stitch_inline_with_async(&inline.verdicts, timeout_verdicts),
                    };
                    return (StatusCode::OK, Json(body)).into_response();
                }
            };

            let body = PrePushResponse {
                allow:    outcome.allowed,
                reason:   outcome.reason,
                verdicts: stitch_inline_with_async(&inline.verdicts, outcome.individual),
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

/// Sesión 20 — generate a UUID-shaped run id without pulling in the
/// `uuid` crate. The audit table only needs a unique-per-process key,
/// not RFC 4122 strict guarantees, so timestamp + counter is enough.
fn new_run_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("gr_{now:x}_{n:x}")
}

/// Sesión 20 — merge inline gate verdicts (1, 4) with the async
/// runner's output (5, 6, 9). Order matches the original spec
/// numbering so the dock can render the timeline naturally. The
/// inline verdicts retain their `name`s from `gate::evaluate`; the
/// runner's verdicts are appended.
fn stitch_inline_with_async(
    inline: &[gate::GateVerdict],
    async_verdicts: Vec<gate::GateVerdict>,
) -> Vec<gate::GateVerdict> {
    // Drop the inline `deferred` placeholders for self_review /
    // substrate_simulate / security_scan — the async runner replaces
    // them with the real verdicts.
    let mut out: Vec<gate::GateVerdict> = inline.iter()
        .filter(|v| !matches!(v.name.as_str(), "self_review" | "substrate_simulate" | "security_scan"))
        .cloned()
        .collect();
    out.extend(async_verdicts);
    out
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
