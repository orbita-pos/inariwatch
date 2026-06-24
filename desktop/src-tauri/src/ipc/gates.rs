//! Tauri commands for the pre-push gate runner UI (Sesión 20).
//!
//! Two commands the dock invokes from Mode 5 (`GateRunning`):
//!
//!   * [`get_recent_gate_runs`] — paginated history per repo for the
//!     "Recent gate runs" affordance.
//!   * [`request_bypass`] — POST-hoc audit marker when the user
//!     overrides a blocking verdict via the dock's `[Push anyway]`
//!     button. Note: this does NOT change whether the user's `git
//!     push` proceeds — that decision is owned by the HTTP handler
//!     (the canonical bypass is `INARI_BYPASS=1 git push`, which the
//!     hook script forwards as `X-Inari-Bypass: 1`). The IPC variant
//!     is purely for marking the audit trail when the user ALSO
//!     decided to bypass after seeing a verdict.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::daemon::DaemonHandle;
use crate::gates::runner::record_bypass;
use crate::store::{queries, Store};

use super::error::IpcError;

#[derive(Debug, Serialize)]
pub struct GateRunSummary {
    pub run_id:           String,
    pub repo_id:          String,
    pub sha:              String,
    pub ref_:             String,
    pub allowed:          bool,
    pub blocking_gates:   Vec<String>,
    pub total_latency_ms: u64,
    pub created_at_ms:    i64,
    pub override_used:    bool,
    pub override_reason:  Option<String>,
}

impl From<queries::GateRunRow> for GateRunSummary {
    fn from(r: queries::GateRunRow) -> Self {
        Self {
            run_id:           r.run_id,
            repo_id:          r.repo_id,
            sha:              r.sha,
            ref_:             r.ref_,
            allowed:          r.allowed,
            blocking_gates:   r.blocking_gates,
            total_latency_ms: r.total_latency_ms,
            created_at_ms:    r.created_at_ms,
            override_used:    r.override_used,
            override_reason:  r.override_reason,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct GetRecentGateRunsArgs {
    pub repo_id: String,
    #[serde(default = "default_limit")]
    pub limit:   u32,
}

fn default_limit() -> u32 { 20 }

#[tauri::command]
pub async fn get_recent_gate_runs(
    state: tauri::State<'_, Arc<Store>>,
    args:  GetRecentGateRunsArgs,
) -> Result<Vec<GateRunSummary>, IpcError> {
    let store = state.inner().clone();
    let rows  = queries::recent_gate_runs(&store, &args.repo_id, args.limit)?;
    Ok(rows.into_iter().map(GateRunSummary::from).collect())
}

#[derive(Debug, Deserialize)]
pub struct RequestBypassArgs {
    pub run_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn request_bypass(
    state:  tauri::State<'_, Arc<Store>>,
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
    args:   RequestBypassArgs,
) -> Result<(), IpcError> {
    let store_arc  = state.inner().clone();
    let daemon_arc = daemon.inner().clone();

    // Resolve the originating run so the bypass audit row carries
    // the same repo/sha/ref triple. Returns NotFound when the dock
    // racing against a freshly-cleaned audit table — return an empty
    // OK in that case so the UI doesn't complain.
    let original = match queries::get_gate_run(&store_arc, &args.run_id)? {
        Some(r) => r,
        None    => {
            tracing::warn!(run_id = %args.run_id, "request_bypass: original run not found");
            return Ok(());
        }
    };

    // Derived run_id so the new audit row doesn't collide with the
    // original verdict's PRIMARY KEY. The bypass row is a sibling
    // entry in `gate_runs`, not a mutation of the original verdict.
    let bypass_run_id = format!("bp_{}", &args.run_id);
    record_bypass(
        &daemon_arc,
        &store_arc,
        &bypass_run_id,
        &original.repo_id,
        &original.sha,
        &original.ref_,
        args.reason,
    );
    Ok(())
}
