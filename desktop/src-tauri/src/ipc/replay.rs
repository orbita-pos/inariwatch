//! Tauri commands for the in-dock replay-against-patch button (Sesión 27).
//!
//! One write: `replay_against_patch(session_id, alert_id)`. Loads the
//! EAP receipt for the remediation session to resolve the recording
//! id, reads the staging credentials from the settings KV, then POSTs
//! to the existing `/v2/replay` endpoint on `inari-staging.inariwatch.com`.
//! The endpoint already runs each replay inside gVisor, so this IPC
//! adds no new sandboxing surface — it is a thin authenticated proxy.
//!
//! The shape of `/v2/replay` (mirrored from `inari_watcher::ReplayResponse`)
//! is preserved verbatim. The dock surfaces:
//!
//!   * `kind = "ok"`            — replay returned a verdict.
//!   * `kind = "no_recording"`  — receipt has no `recording_id` (the
//!                                spec's "no recording — generate one"
//!                                CTA path).
//!   * `kind = "no_receipt"`    — session has no attestation yet.
//!   * `kind = "config_missing"` — staging credentials absent in
//!                                settings (graceful degradation in
//!                                offline / unconnected dev).
//!   * `kind = "request_failed"` — non-2xx from `/v2/replay`. The dock
//!                                renders the `error` string verbatim.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::store::{queries, settings, Store};

use super::error::IpcError;

/// Default endpoint when `replay_url` is unset in settings. Wired to
/// the same Hetzner staging deploy that owns `/v2/replay` today.
const DEFAULT_REPLAY_URL: &str = "https://inari-staging.inariwatch.com/v2/replay";
/// Default dashboard origin used to resolve `recording_id → recording_url`
/// when the user hasn't pinned a custom one in settings.
const DEFAULT_DASHBOARD_URL: &str = "https://app.inariwatch.com";
/// Hard wall on the round-trip. Matches `inari_watcher::REPLAY_TIMEOUT`.
const REPLAY_TIMEOUT: Duration = Duration::from_secs(75);

#[derive(Debug, Deserialize)]
pub struct ReplayAgainstPatchArgs {
    pub session_id: String,
    pub alert_id:   String,
}

/// Discriminated-union shape the dock branches on. Tagged so a tagged
/// TS union falls out of `serde_json` directly.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayResultDto {
    /// Backend returned a verdict. Frontend renders green ✓ when
    /// `throw_reproduced` is false (the patch prevented the throw),
    /// red ✗ otherwise.
    Ok {
        throw_reproduced: bool,
        throws_after:     i64,
        runner_mode:      Option<String>,
        fix_branch:       Option<String>,
        duration_ms:      Option<i64>,
        head_throw:       Option<HeadThrowDto>,
    },
    /// Receipt exists but has no recording_id — render the "no
    /// recording — generate one" CTA per the Sesión 27 spec.
    NoRecording { receipt_id: String },
    /// Session has not been attested yet.
    NoReceipt,
    /// Settings KV missing `replay_url` + `replay_token` so the IPC
    /// can't even attempt the call. Surface as a hint, never as a
    /// red ✗.
    ConfigMissing { reason: String },
    /// Non-2xx from `/v2/replay` (or transport / parse failure). The
    /// dock renders `error` verbatim under the red ✗.
    RequestFailed { status: Option<u16>, error: String },
}

/// Slimmed `ReplayThrow` for the dock's "first throw" surface — the
/// chip's red-state caption shows the exception name + message + first
/// stack frame. Backend's full `throws[]` stays server-side.
#[derive(Debug, Clone, Serialize)]
pub struct HeadThrowDto {
    pub exception_name:    String,
    pub exception_message: String,
    pub top_frame_function: Option<String>,
    pub top_frame_file:     Option<String>,
    pub top_frame_line:     Option<u32>,
}

#[tauri::command]
pub async fn replay_against_patch(
    state: tauri::State<'_, Arc<Store>>,
    args:  ReplayAgainstPatchArgs,
) -> Result<ReplayResultDto, IpcError> {
    let store_arc: Arc<Store> = state.inner().clone();
    replay_against_patch_with_store(&store_arc, args).await
}

/// Inner — `tauri::State`-free entry point so integration tests can
/// drive the full flow without a Tauri runtime. The `#[tauri::command]`
/// wrapper above is a thin state-extracting shim.
pub async fn replay_against_patch_with_store(
    store_arc: &Arc<Store>,
    args:      ReplayAgainstPatchArgs,
) -> Result<ReplayResultDto, IpcError> {
    // 1. Resolve the receipt for this session — if absent or has no
    //    recording_id, return the discriminated-union variant the
    //    dock branches on. Both are first-class outcomes, NOT errors.
    let receipt = match queries::get_eap_receipt_by_remediation_session(
        store_arc,
        &args.session_id,
    )? {
        Some(r) => r,
        None    => return Ok(ReplayResultDto::NoReceipt),
    };

    let recording_id = match receipt.recording_id.clone() {
        Some(id) => id,
        None     => return Ok(ReplayResultDto::NoRecording {
            receipt_id: receipt.receipt_id,
        }),
    };

    // 2. Read staging credentials from settings. Both must be present;
    //    otherwise we surface a config-missing hint.
    let replay_url = settings::get(store_arc, "replay_url")?
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_REPLAY_URL.to_string());
    let replay_token = match settings::get(store_arc, "replay_token")? {
        Some(t) if !t.trim().is_empty() => t,
        _ => return Ok(ReplayResultDto::ConfigMissing {
            reason: "replay_token not set in settings".to_string(),
        }),
    };

    // Optional — when present we POST a recording_url that points to
    // the dashboard, with the dashboard token forwarded as auth_header.
    let dashboard_url = settings::get(store_arc, "dashboard_url")?
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DASHBOARD_URL.to_string());
    let dashboard_token = settings::get(store_arc, "dashboard_token")?
        .filter(|s| !s.trim().is_empty());

    let recording_url = format!(
        "{}/api/recordings/{}/binary",
        dashboard_url.trim_end_matches('/'),
        urlencode(&recording_id),
    );
    let auth_header = dashboard_token.as_ref().map(|t| format!("Bearer {t}"));

    // 3. Load the session to pull `commit_sha` (the patched HEAD).
    //    /v2/replay's fix_branch field accepts a sha, so we pass the
    //    commit_sha when present. repo_url + github_token are also
    //    optional — without them, the backend falls back to drain-only
    //    mode against the recording (still produces throw_reproduced).
    let session = queries::get_remediation_session(store_arc, &args.session_id)?;
    let fix_branch_or_sha = session.as_ref().and_then(|s| s.commit_sha.clone());

    let repo_url    = settings::get(store_arc, "repo_url")?
        .filter(|s| !s.trim().is_empty());
    let github_token = settings::get(store_arc, "github_token")?
        .filter(|s| !s.trim().is_empty());

    let mut body = serde_json::Map::new();
    body.insert("recording_url".into(), json!(recording_url));
    if let Some(a) = auth_header   { body.insert("auth_header".into(),   json!(a)); }
    if let Some(r) = repo_url      { body.insert("repo_url".into(),      json!(r)); }
    if let Some(b) = fix_branch_or_sha {
        body.insert("fix_branch".into(), json!(b));
    }
    if let Some(g) = github_token  { body.insert("github_token".into(),  json!(g)); }
    body.insert("timeout_seconds".into(), json!(60));

    let http = match reqwest::Client::builder()
        .timeout(REPLAY_TIMEOUT)
        .build()
    {
        Ok(c)  => c,
        Err(e) => return Ok(ReplayResultDto::RequestFailed {
            status: None,
            error:  format!("client builder: {e}"),
        }),
    };

    let res = http
        .post(&replay_url)
        .bearer_auth(&replay_token)
        .json(&body)
        .send()
        .await;

    let res = match res {
        Ok(r) => r,
        Err(e) => return Ok(ReplayResultDto::RequestFailed {
            status: None,
            error:  format!("transport: {e}"),
        }),
    };

    let status = res.status();
    if !status.is_success() {
        // Pull a small body fragment for the dock — bound it so a
        // misbehaving backend can't blow the IPC payload size.
        let snippet = res.text().await.unwrap_or_default();
        let trimmed: String = snippet.chars().take(512).collect();
        return Ok(ReplayResultDto::RequestFailed {
            status: Some(status.as_u16()),
            error:  if trimmed.is_empty() { status.to_string() } else { trimmed },
        });
    }

    let parsed: ReplayResponse = match res.json().await {
        Ok(p)  => p,
        Err(e) => return Ok(ReplayResultDto::RequestFailed {
            status: Some(status.as_u16()),
            error:  format!("body parse: {e}"),
        }),
    };

    let head_throw = parsed.throws.first().cloned().map(|t| {
        let top = t.stack.first().cloned();
        HeadThrowDto {
            exception_name:     t.exception.name,
            exception_message:  t.exception.message,
            top_frame_function: top.as_ref().map(|f| f.function.clone()),
            top_frame_file:     top.as_ref().map(|f| f.file.clone()),
            top_frame_line:     top.as_ref().map(|f| f.line),
        }
    });

    Ok(ReplayResultDto::Ok {
        throw_reproduced: parsed.throw_reproduced,
        throws_after:     parsed.throws.len() as i64,
        runner_mode:      parsed.runner_mode,
        fix_branch:       parsed.fix_branch,
        duration_ms:      parsed.duration_ms,
        head_throw,
    })
}

// ── /v2/replay wire shapes ───────────────────────────────────────────
//
// Mirrors `inari_watcher::ReplayResponse`. We re-declare locally so the
// IPC seam doesn't reach into `inari_watcher`'s private types — that
// module is locked per Sesión-1 ARCHITECTURE.md and any cross-module
// dependency would force its rewrite ahead of S5/S10's plan.

#[derive(Debug, Clone, Deserialize)]
struct ReplayResponse {
    #[serde(default)]
    throw_reproduced: bool,
    #[serde(default)]
    throws:           Vec<ReplayThrow>,
    #[serde(default)]
    runner_mode:      Option<String>,
    #[serde(default)]
    fix_branch:       Option<String>,
    #[serde(default)]
    duration_ms:      Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ReplayThrow {
    #[serde(default)]
    exception: ReplayException,
    #[serde(default)]
    stack:     Vec<ReplayStackFrame>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ReplayException {
    #[serde(default)]
    name:    String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ReplayStackFrame {
    #[serde(default)]
    function: String,
    #[serde(default)]
    file:     String,
    #[serde(default)]
    line:     u32,
}

// ── helpers ─────────────────────────────────────────────────────────

/// Same minimal escaper `inari_watcher::urlencode` uses — copied verbatim
/// to keep this module self-contained without crossing the architectural
/// fence into `inari_watcher`.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_passes_alnum_through() {
        assert_eq!(urlencode("rec_abc123"), "rec_abc123");
    }

    #[test]
    fn urlencode_escapes_slash() {
        assert_eq!(urlencode("a/b"), "a%2Fb");
    }
}
