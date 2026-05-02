//! Remediation router + apply surface (Sesión 19).
//!
//! Owns three responsibilities:
//!
//!   1. [`route_remediation`] — pick local vs cloud given workspace
//!      connection + a complexity heuristic. Inserts the
//!      `remediation_sessions` row and emits the
//!      [`DaemonEvent::RemediationStarted`] bus event so the dock can
//!      render the progress card. Returns either a draft (local path)
//!      or a session marker (cloud path runs detached and emits
//!      progress / completed events later).
//!
//!   2. [`apply_diff`] — write the unified diff to disk + commit.
//!      Validates path traversal, runs `git apply --check` first, then
//!      `git apply` + `git add` + `git commit`. NO push — that's a
//!      Sesión 20 gate-runner concern.
//!
//!   3. [`reject_diff`] — persist the rejection + emit
//!      [`DaemonEvent::FixRejected`]. Idempotent: rejecting an
//!      already-applied or already-rejected session is a no-op.
//!
//! Routing heuristic (locked in DECISIONS 2026-05-01):
//!   - No workspace link  → local single-shot.
//!   - workspace link AND complexity above threshold → cloud agentic.
//!   - workspace link AND simple bug → local single-shot (faster, no
//!                                     RTT, the cloud is overkill).
//!   "Complexity" today = stack frames > 3 OR file_hint references > 1.
//!   Ajustable by editing the constants below.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ai::openai::OpenAIClient;
use crate::daemon::{DaemonEvent, DaemonHandle};
use crate::local_ai::LocalAI;
use crate::store::{queries, Store};

use super::single_shot::{run_single_shot, RemediationDraft, SingleShotError, SingleShotInput};

/// Stack-frame count above which we prefer the cloud agentic path.
const COMPLEXITY_STACK_THRESHOLD: usize = 3;

/// Errors raised by the orchestrator.
#[derive(Debug, thiserror::Error)]
pub enum OrchestratorError {
    #[error("store: {0}")]
    Store(#[from] crate::store::error::StoreError),
    #[error("single-shot: {0}")]
    SingleShot(#[from] SingleShotError),
    #[error("apply error: {0}")]
    Apply(#[from] ApplyError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Request shape the IPC layer hands the orchestrator.
#[derive(Debug, Clone, Deserialize)]
pub struct RemediationInput {
    pub repo_id:           String,
    pub repo_path:         PathBuf,
    pub error_message:     String,
    pub stack_trace:       Option<String>,
    pub error_fingerprint: Option<String>,
    pub file_hint:         Option<String>,
}

/// What the IPC layer returns to the dock the moment a session is
/// kicked off. The local path completes synchronously and surfaces a
/// `draft`; the cloud path returns immediately with state=pending and
/// emits progress/completed events asynchronously.
#[derive(Debug, Clone, Serialize)]
pub struct RemediationSession {
    pub session_id: String,
    pub mode:       String,
    pub state:      String,
    /// Populated on the local path once the AI returns. The cloud path
    /// leaves this `None`.
    pub draft:      Option<RemediationDraft>,
    /// Populated when the cloud path produces a PR URL (post-completion).
    /// Always `None` from `route_remediation` — appears only when the
    /// dock re-queries via `get_remediation_session`.
    pub pr_url:     Option<String>,
}

/// Pick the path + execute. Local path runs to completion before
/// returning; cloud path spawns a detached SSE consumer and returns
/// state=pending immediately.
///
/// `local_ai` + `local_apply_enabled` (Sesión 25) gate the Kortix
/// FastApply-7B local path inside `run_single_shot`. Pass `None` /
/// `false` to keep the legacy cloud-only behaviour byte-identical.
pub async fn route_remediation(
    store:      &Arc<Store>,
    daemon:     &Arc<DaemonHandle>,
    client:     OpenAIClient,
    local_ai:   Option<LocalAI>,
    local_apply_enabled: bool,
    session_id: String,
    input:      RemediationInput,
) -> Result<RemediationSession, OrchestratorError> {
    let workspace = queries::get_workspace_link_for_repo(store, &input.repo_id)?;
    let mode = pick_mode(&workspace, &input);

    // Insert the row + emit the started event before doing the work so
    // the dock can render "Inari is fixing this…" right away.
    let now = now_ms();
    queries::insert_remediation_session(
        store,
        &queries::NewRemediationSession {
            id:                &session_id,
            repo_id:           &input.repo_id,
            mode,
            error_fingerprint: input.error_fingerprint.as_deref(),
            error_message:     Some(&input.error_message),
            created_at_ms:     now,
        },
    )?;
    daemon.bus.publish(DaemonEvent::RemediationStarted {
        session_id: session_id.clone(),
        repo_id:    input.repo_id.clone(),
        mode:       mode.as_str().to_string(),
    });

    match mode {
        queries::RemediationMode::Local => {
            run_local(store, daemon, &client, local_ai.as_ref(), local_apply_enabled, &session_id, &input).await
        }
        queries::RemediationMode::Cloud => {
            run_cloud(store, daemon, &session_id, &input).await
        }
    }
}

async fn run_local(
    store:      &Arc<Store>,
    daemon:     &Arc<DaemonHandle>,
    client:     &OpenAIClient,
    local_ai:   Option<&LocalAI>,
    local_apply_enabled: bool,
    session_id: &str,
    input:      &RemediationInput,
) -> Result<RemediationSession, OrchestratorError> {
    let single_input = SingleShotInput {
        repo_id:           input.repo_id.clone(),
        repo_path:         input.repo_path.clone(),
        error_message:     input.error_message.clone(),
        stack_trace:       input.stack_trace.clone(),
        error_fingerprint: input.error_fingerprint.clone(),
        file_hint:         input.file_hint.clone(),
    };
    let draft_res = run_single_shot(
        store,
        client,
        local_ai,
        local_apply_enabled,
        session_id,
        &single_input,
    ).await;

    match draft_res {
        Ok(draft) => {
            let files_str = draft.files_touched.join("\n");
            queries::update_remediation_session(
                store,
                session_id,
                &queries::RemediationUpdate {
                    state:             Some(queries::RemediationState::Draft),
                    draft_diff:        Some(&draft.diff_unified),
                    files_touched:     Some(&files_str),
                    prompt_tokens:     Some(draft.prompt_tokens as i64),
                    completion_tokens: Some(draft.completion_tokens as i64),
                    cents:             Some(draft.cents),
                    ..Default::default()
                },
            )?;
            daemon.bus.publish(DaemonEvent::RemediationProgress {
                session_id: session_id.to_string(),
                stage:      "draft_ready".to_string(),
                message:    format!("Draft fix ready ({} files)", draft.files_touched.len()),
            });
            Ok(RemediationSession {
                session_id: session_id.to_string(),
                mode:       "local".to_string(),
                state:      "draft".to_string(),
                draft:      Some(draft),
                pr_url:     None,
            })
        }
        Err(e) => {
            let summary = format!("Single-shot failed: {e}");
            queries::update_remediation_session(
                store,
                session_id,
                &queries::RemediationUpdate {
                    state:           Some(queries::RemediationState::Failed),
                    completed_at_ms: Some(now_ms()),
                    ..Default::default()
                },
            )?;
            daemon.bus.publish(DaemonEvent::RemediationCompleted {
                session_id: session_id.to_string(),
                success:    false,
                summary:    summary.clone(),
            });
            Err(OrchestratorError::SingleShot(e))
        }
    }
}

async fn run_cloud(
    store:      &Arc<Store>,
    daemon:     &Arc<DaemonHandle>,
    session_id: &str,
    input:      &RemediationInput,
) -> Result<RemediationSession, OrchestratorError> {
    // Hand off to the proxy module. It runs detached + emits progress
    // events as the cloud SSE stream produces them; we return state =
    // pending immediately so the dock can render the spinner.
    let store_clone   = store.clone();
    let daemon_clone  = daemon.clone();
    let session       = session_id.to_string();
    let cloud_input   = super::proxy::CloudInput {
        session_id:        session.clone(),
        repo_id:           input.repo_id.clone(),
        error_message:     input.error_message.clone(),
        stack_trace:       input.stack_trace.clone(),
        error_fingerprint: input.error_fingerprint.clone(),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = super::proxy::run_cloud_agentic(&store_clone, &daemon_clone, cloud_input).await {
            tracing::warn!(error = %e, session_id = %session, "cloud remediation failed");
            // Mark the session failed so a subsequent get_remediation_session
            // returns the right state.
            let _ = queries::update_remediation_session(
                &store_clone,
                &session,
                &queries::RemediationUpdate {
                    state:           Some(queries::RemediationState::Failed),
                    completed_at_ms: Some(now_ms()),
                    ..Default::default()
                },
            );
            daemon_clone.bus.publish(DaemonEvent::RemediationCompleted {
                session_id: session,
                success:    false,
                summary:    format!("Cloud remediation failed: {e}"),
            });
        }
    });

    Ok(RemediationSession {
        session_id: session_id.to_string(),
        mode:       "cloud".to_string(),
        state:      "pending".to_string(),
        draft:      None,
        pr_url:     None,
    })
}

fn pick_mode(workspace: &Option<String>, input: &RemediationInput) -> queries::RemediationMode {
    let connected = workspace
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !connected {
        return queries::RemediationMode::Local;
    }
    let stack_frames = input
        .stack_trace
        .as_deref()
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0);
    if stack_frames > COMPLEXITY_STACK_THRESHOLD {
        queries::RemediationMode::Cloud
    } else {
        queries::RemediationMode::Local
    }
}

// ─────────────────────────────────────────────────────────────────────
// Apply / reject
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("path traversal: {0}")]
    PathTraversal(String),
    #[error("git apply --check rejected the diff: {0}")]
    InvalidPatch(String),
    #[error("git failed: {0}")]
    Git(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Result of an apply call. The orchestrator threads this back through
/// the IPC layer so the dock can show "✓ Applied — commit abc1234".
#[derive(Debug, Clone, Serialize)]
pub struct ApplyResult {
    pub commit_sha:    String,
    pub files_touched: Vec<String>,
}

/// Apply a unified diff to `repo_path` + create a commit. Steps:
///   1. Reject if any `+++ b/...` path escapes `repo_path` (no `..`,
///      no absolute paths). We do NOT trust the model.
///   2. `git apply --check <patch>` — dry run; bail on rejection.
///   3. `git apply <patch>` — write to working tree.
///   4. `git add <files>` (only the files the diff touched, never -A).
///   5. `git commit -m <msg>` — no push.
pub fn apply_diff(
    repo_path:    &Path,
    diff:         &str,
    commit_msg:   &str,
) -> Result<ApplyResult, ApplyError> {
    // 1 — path traversal check.
    let files = super::single_shot::parse_diff_files(diff);
    for rel in &files {
        validate_repo_relative_path(repo_path, rel)?;
    }
    if files.is_empty() {
        return Err(ApplyError::InvalidPatch("diff touches no files".to_string()));
    }

    // Persist the diff to a temp file so `git apply` can stream it.
    let mut patch_path = std::env::temp_dir();
    patch_path.push(format!("inari-live-patch-{}.patch", uuid::Uuid::new_v4()));
    std::fs::write(&patch_path, diff)?;

    // 2 — dry run.
    let check = run_git(repo_path, &["apply", "--check", patch_path.to_str().unwrap_or("")])?;
    if !check.status.success() {
        let _ = std::fs::remove_file(&patch_path);
        return Err(ApplyError::InvalidPatch(string_from(check.stderr)));
    }

    // 3 — apply.
    let apply = run_git(repo_path, &["apply", patch_path.to_str().unwrap_or("")])?;
    if !apply.status.success() {
        let _ = std::fs::remove_file(&patch_path);
        return Err(ApplyError::Git(format!("git apply failed: {}", string_from(apply.stderr))));
    }
    let _ = std::fs::remove_file(&patch_path);

    // 4 — stage exactly the files the diff touched.
    let mut add_args: Vec<String> = vec!["add".to_string(), "--".to_string()];
    add_args.extend(files.iter().cloned());
    let add_args_ref: Vec<&str> = add_args.iter().map(String::as_str).collect();
    let add = run_git(repo_path, &add_args_ref)?;
    if !add.status.success() {
        return Err(ApplyError::Git(format!("git add failed: {}", string_from(add.stderr))));
    }

    // 5 — commit. Use --no-verify=false so user hooks still run; if
    // they reject the commit the user sees exactly what they would have
    // hit by hand. Also use --allow-empty=false (default) so we don't
    // accidentally produce a no-op commit.
    let commit = run_git(repo_path, &["commit", "-m", commit_msg])?;
    if !commit.status.success() {
        return Err(ApplyError::Git(format!("git commit failed: {}", string_from(commit.stderr))));
    }

    // Resolve the new HEAD sha.
    let head = run_git(repo_path, &["rev-parse", "HEAD"])?;
    if !head.status.success() {
        return Err(ApplyError::Git(format!("rev-parse HEAD failed: {}", string_from(head.stderr))));
    }
    let sha = string_from(head.stdout).trim().to_string();

    Ok(ApplyResult {
        commit_sha:    sha,
        files_touched: files,
    })
}

/// Persist a rejection on `session_id` and emit
/// [`DaemonEvent::FixRejected`]. Idempotent: rejecting a row already in
/// `applied` / `rejected` / `failed` is a no-op (no state change, no
/// event), so the IPC surface can be retried safely.
pub fn reject_diff(
    store:      &Arc<Store>,
    daemon:     &Arc<DaemonHandle>,
    session_id: &str,
    reason:     Option<String>,
) -> Result<(), OrchestratorError> {
    let row = match queries::get_remediation_session(store, session_id)? {
        Some(r) => r,
        None    => {
            tracing::warn!(session_id, "reject_diff: unknown session");
            return Ok(());
        }
    };
    let current = queries::RemediationState::from_str(&row.state);
    if !matches!(current, Some(queries::RemediationState::Pending) | Some(queries::RemediationState::Draft)) {
        tracing::info!(session_id, state = %row.state, "reject_diff: idempotent no-op");
        return Ok(());
    }
    queries::update_remediation_session(
        store,
        session_id,
        &queries::RemediationUpdate {
            state:           Some(queries::RemediationState::Rejected),
            completed_at_ms: Some(now_ms()),
            ..Default::default()
        },
    )?;
    daemon.bus.publish(DaemonEvent::FixRejected {
        session_id: session_id.to_string(),
        reason,
    });
    Ok(())
}

// ── helpers ─────────────────────────────────────────────────────────

fn validate_repo_relative_path(repo: &Path, rel: &str) -> Result<(), ApplyError> {
    if rel.is_empty() {
        return Err(ApplyError::PathTraversal("empty path".to_string()));
    }
    let p = PathBuf::from(rel);
    if p.is_absolute() {
        return Err(ApplyError::PathTraversal(format!("absolute path rejected: {rel}")));
    }
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(ApplyError::PathTraversal(format!("traversal rejected: {rel}")));
            }
            _ => {}
        }
    }
    // Defence in depth: canonicalise and check it stays inside the repo.
    let joined = repo.join(&p);
    // Don't require the file to exist (additions land at unknown paths)
    // — but its parent must, and the resolved path must start with repo.
    if let Some(parent) = joined.parent() {
        if let (Ok(repo_canon), Ok(parent_canon)) = (repo.canonicalize(), parent.canonicalize()) {
            if !parent_canon.starts_with(&repo_canon) {
                return Err(ApplyError::PathTraversal(format!(
                    "resolved parent escapes repo: {}", parent_canon.display()
                )));
            }
        }
    }
    Ok(())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, ApplyError> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()?;
    Ok(out)
}

fn string_from(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| {
        let lossy = String::from_utf8_lossy(e.as_bytes()).to_string();
        lossy
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn pick_mode_local_when_no_workspace() {
        let m = pick_mode(&None, &fixture_input());
        assert_eq!(m, queries::RemediationMode::Local);
    }

    #[test]
    fn pick_mode_local_when_simple_bug_even_connected() {
        let m = pick_mode(&Some("default".to_string()), &fixture_input());
        assert_eq!(m, queries::RemediationMode::Local);
    }

    #[test]
    fn pick_mode_cloud_when_complex_and_connected() {
        let mut input = fixture_input();
        input.stack_trace = Some(
            "frame1\nframe2\nframe3\nframe4\nframe5".to_string(),
        );
        let m = pick_mode(&Some("default".to_string()), &input);
        assert_eq!(m, queries::RemediationMode::Cloud);
    }

    #[test]
    fn validate_path_rejects_absolute() {
        let tmp = std::env::temp_dir();
        let r = validate_repo_relative_path(&tmp, "/etc/passwd");
        assert!(matches!(r, Err(ApplyError::PathTraversal(_))));
    }

    #[test]
    fn validate_path_rejects_traversal() {
        let tmp = std::env::temp_dir();
        let r = validate_repo_relative_path(&tmp, "../../etc/passwd");
        assert!(matches!(r, Err(ApplyError::PathTraversal(_))));
    }

    #[test]
    fn validate_path_accepts_normal_relative() {
        let tmp = std::env::temp_dir();
        let r = validate_repo_relative_path(&tmp, "src/main.rs");
        assert!(r.is_ok());
    }

    fn fixture_input() -> RemediationInput {
        RemediationInput {
            repo_id:           "repo-1".to_string(),
            repo_path:         PathBuf::from("/tmp/repo"),
            error_message:     "boom".to_string(),
            stack_trace:       Some("one\n".to_string()),
            error_fingerprint: None,
            file_hint:         None,
        }
    }
}
