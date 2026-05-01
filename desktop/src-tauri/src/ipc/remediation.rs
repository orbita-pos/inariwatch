//! Tauri commands for the local remediation pipeline (Sesión 19).
//!
//! Four commands the dock invokes:
//!
//!   * [`start_remediation`]   — kicks off the orchestrator.
//!   * [`apply_remediation`]   — applies the cached draft + commits.
//!   * [`reject_remediation`]  — persists rejection + emits event.
//!   * [`get_remediation_session`] — re-read current state.
//!
//! All four resolve the active repo via the same `Arc<Store>` Sesión 4
//! manages. The orchestrator owns the heavy work; this module is only
//! the IPC seam.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ai::openai::OpenAIClient;
use crate::ai::remediate::{
    self,
    orchestrator::{
        ApplyResult, OrchestratorError, RemediationInput, RemediationSession,
    },
};
use crate::daemon::DaemonHandle;
use crate::store::{queries, Store};

use super::error::IpcError;

#[derive(Debug, Deserialize)]
pub struct StartRemediationArgs {
    pub repo_id:           String,
    pub error_message:     String,
    #[serde(default)]
    pub stack_trace:       Option<String>,
    #[serde(default)]
    pub error_fingerprint: Option<String>,
    #[serde(default)]
    pub file_hint:         Option<String>,
}

#[tauri::command]
pub async fn start_remediation(
    state:  tauri::State<'_, Arc<Store>>,
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
    args:   StartRemediationArgs,
) -> Result<RemediationSession, IpcError> {
    let store_arc:  Arc<Store>        = state.inner().clone();
    let daemon_arc: Arc<DaemonHandle> = daemon.inner().clone();

    let repo_path = match queries::find_repo_path_by_id(&store_arc, &args.repo_id)? {
        Some(p) => PathBuf::from(p),
        None    => return Err(IpcError::RepoNotFound { id: args.repo_id }),
    };

    let client = OpenAIClient::from_store(&store_arc).map_err(IpcError::from)?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let input = RemediationInput {
        repo_id:           args.repo_id,
        repo_path,
        error_message:     args.error_message,
        stack_trace:       args.stack_trace,
        error_fingerprint: args.error_fingerprint,
        file_hint:         args.file_hint,
    };

    remediate::orchestrator::route_remediation(
        &store_arc,
        &daemon_arc,
        client,
        session_id,
        input,
    )
    .await
    .map_err(orchestrator_to_ipc)
}

#[derive(Debug, Deserialize)]
pub struct ApplyRemediationArgs {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
pub struct ApplyRemediationResult {
    pub success:       bool,
    pub commit_sha:    Option<String>,
    pub files_touched: Vec<String>,
    /// Wrapped, surface-formatted message ("Fix applied + commit abc123",
    /// "Apply failed: <reason>"). The dock displays this directly so it
    /// must be friendly.
    pub message:       String,
}

#[tauri::command]
pub async fn apply_remediation(
    state:  tauri::State<'_, Arc<Store>>,
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
    args:   ApplyRemediationArgs,
) -> Result<ApplyRemediationResult, IpcError> {
    let store_arc:  Arc<Store>        = state.inner().clone();
    let daemon_arc: Arc<DaemonHandle> = daemon.inner().clone();

    let row = queries::get_remediation_session(&store_arc, &args.session_id)?
        .ok_or_else(|| IpcError::Internal {
            message: format!("unknown remediation session: {}", args.session_id),
        })?;

    let diff = row.draft_diff.ok_or_else(|| IpcError::Internal {
        message: "session has no cached draft — nothing to apply".to_string(),
    })?;
    let repo_path = queries::find_repo_path_by_id(&store_arc, &row.repo_id)?
        .ok_or_else(|| IpcError::RepoNotFound { id: row.repo_id.clone() })?;

    let commit_msg = format!(
        "inari-live: auto-fix {}",
        row.error_fingerprint.unwrap_or_else(|| args.session_id.clone()),
    );

    // Run apply on a blocking thread — git is blocking IO and we don't
    // want to wedge the Tauri runtime.
    let repo_buf = PathBuf::from(repo_path);
    let diff_owned = diff.clone();
    let join: Result<Result<ApplyResult, remediate::orchestrator::ApplyError>, _> =
        tauri::async_runtime::spawn_blocking(move || {
            remediate::orchestrator::apply_diff(&repo_buf, &diff_owned, &commit_msg)
        })
        .await;

    let apply_outcome = match join {
        Ok(inner) => inner,
        Err(e) => {
            return Err(IpcError::Internal {
                message: format!("apply task join failed: {e}"),
            });
        }
    };

    match apply_outcome {
        Ok(applied) => {
            let now = now_ms();
            queries::update_remediation_session(
                &store_arc,
                &args.session_id,
                &queries::RemediationUpdate {
                    state:           Some(queries::RemediationState::Applied),
                    commit_sha:      Some(&applied.commit_sha),
                    completed_at_ms: Some(now),
                    ..Default::default()
                },
            )?;
            let msg = format!("Fix applied + commit {}", short_sha(&applied.commit_sha));
            daemon_arc.bus.publish(crate::daemon::DaemonEvent::RemediationCompleted {
                session_id: args.session_id.clone(),
                success:    true,
                summary:    msg.clone(),
            });
            Ok(ApplyRemediationResult {
                success:       true,
                commit_sha:    Some(applied.commit_sha),
                files_touched: applied.files_touched,
                message:       msg,
            })
        }
        Err(e) => {
            let msg = friendly_apply_error(&e);
            queries::update_remediation_session(
                &store_arc,
                &args.session_id,
                &queries::RemediationUpdate {
                    state:           Some(queries::RemediationState::Failed),
                    completed_at_ms: Some(now_ms()),
                    ..Default::default()
                },
            )?;
            daemon_arc.bus.publish(crate::daemon::DaemonEvent::RemediationCompleted {
                session_id: args.session_id.clone(),
                success:    false,
                summary:    msg.clone(),
            });
            Ok(ApplyRemediationResult {
                success:       false,
                commit_sha:    None,
                files_touched: Vec::new(),
                message:       msg,
            })
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RejectRemediationArgs {
    pub session_id: String,
    #[serde(default)]
    pub reason:     Option<String>,
}

#[tauri::command]
pub async fn reject_remediation(
    state:  tauri::State<'_, Arc<Store>>,
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
    args:   RejectRemediationArgs,
) -> Result<(), IpcError> {
    let store_arc:  Arc<Store>        = state.inner().clone();
    let daemon_arc: Arc<DaemonHandle> = daemon.inner().clone();
    remediate::orchestrator::reject_diff(&store_arc, &daemon_arc, &args.session_id, args.reason)
        .map_err(orchestrator_to_ipc)
}

#[derive(Debug, Deserialize)]
pub struct GetRemediationSessionArgs {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
pub struct RemediationSessionState {
    pub session_id:        String,
    pub repo_id:           String,
    pub mode:              String,
    pub state:             String,
    pub draft_diff:        Option<String>,
    pub files_touched:     Vec<String>,
    pub pr_url:            Option<String>,
    pub commit_sha:        Option<String>,
    pub error_message:     Option<String>,
    pub created_at_ms:     i64,
    pub completed_at_ms:   Option<i64>,
}

#[tauri::command]
pub async fn get_remediation_session_cmd(
    state: tauri::State<'_, Arc<Store>>,
    args:  GetRemediationSessionArgs,
) -> Result<Option<RemediationSessionState>, IpcError> {
    let store_arc: Arc<Store> = state.inner().clone();
    let row = queries::get_remediation_session(&store_arc, &args.session_id)?;
    Ok(row.map(|r| RemediationSessionState {
        session_id:      r.id,
        repo_id:         r.repo_id,
        mode:            r.mode,
        state:           r.state,
        draft_diff:      r.draft_diff,
        files_touched:   r
            .files_touched
            .map(|s| s.lines().filter(|l| !l.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default(),
        pr_url:          r.pr_url,
        commit_sha:      r.commit_sha,
        error_message:   r.error_message,
        created_at_ms:   r.created_at_ms,
        completed_at_ms: r.completed_at_ms,
    }))
}

// ── helpers ─────────────────────────────────────────────────────────

fn orchestrator_to_ipc(e: OrchestratorError) -> IpcError {
    match e {
        OrchestratorError::Store(s)        => IpcError::from(s),
        OrchestratorError::Io(io)          => IpcError::from(io),
        OrchestratorError::SingleShot(ss)  => IpcError::Internal { message: ss.to_string() },
        OrchestratorError::Apply(ap)       => IpcError::Internal { message: ap.to_string() },
    }
}

fn friendly_apply_error(e: &remediate::orchestrator::ApplyError) -> String {
    match e {
        remediate::orchestrator::ApplyError::PathTraversal(_)  => {
            "Fix application blocked: the diff tried to write outside the repo. \
            (We never apply patches that touch paths outside your project — the AI's \
            output was rejected.)".to_string()
        }
        remediate::orchestrator::ApplyError::InvalidPatch(_)   => {
            "Fix application failed: the diff doesn't apply cleanly to your current \
            files. The repo may have changed since the fix was generated — try \
            generating a new fix.".to_string()
        }
        remediate::orchestrator::ApplyError::Git(_) => {
            "Fix application failed: git rejected the change (your hooks may have \
            blocked the commit). Check the dock log for details.".to_string()
        }
        remediate::orchestrator::ApplyError::Io(_) => {
            "Fix application failed: a filesystem error occurred. Make sure the repo \
            isn't open in another writer.".to_string()
        }
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
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

    #[test]
    fn short_sha_truncates_at_seven() {
        assert_eq!(short_sha("0123456789abcdef"), "0123456");
    }

    #[test]
    fn friendly_apply_error_for_path_traversal_warns() {
        let e = remediate::orchestrator::ApplyError::PathTraversal("../etc".to_string());
        let msg = friendly_apply_error(&e);
        assert!(msg.contains("outside the repo"));
    }
}
