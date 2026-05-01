//! Async runner for the local-subset gates (Sesión 20).
//!
//! Drives Gates 5 (`self_review`) + 6 (`substrate_simulate`) + 9
//! (`security_scan`) in parallel via `tokio::join!`, emits per-gate
//! progress events to the daemon bus, and returns a single
//! [`GateRunOutcome`] the HTTP handler turns into the pre-push
//! response.

use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::ai::openai::OpenAIClient;
use crate::daemon::{DaemonEvent, DaemonHandle};
use crate::gates::local_subset::{
    eval_gate_5_self_review, eval_gate_6_substrate_simulate, eval_gate_9_security_scan,
};
use crate::sensors::git::gate::GateVerdict;
use crate::sensors::substrate::replay_client::{auto_backend, ReplayBackend};
use crate::store::{queries, Store};

/// Inputs the runner needs to evaluate the local subset. The HTTP
/// handler builds this from the pre-push payload.
#[derive(Debug, Clone)]
pub struct GateRunInput {
    pub run_id:         String,
    pub repo_id:        String,
    pub sha:            String,
    pub ref_:           String,
    pub diff_body:      String,
    pub commit_message: String,
}

/// Per-gate verdict re-export so the HTTP handler / persister doesn't
/// have to dip into the sensors module just to name the type.
pub type GateRunVerdict = GateVerdict;

/// Output of one run. The HTTP handler stitches `allowed` + verdicts
/// + reason into the pre-push response shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateRunOutcome {
    pub run_id:           String,
    pub allowed:          bool,
    pub blocking_gates:   Vec<String>,
    pub individual:       Vec<GateRunVerdict>,
    pub total_latency_ms: u64,
    /// One-line composite reason — joins every blocking gate's
    /// `reason` with `; ` so the hook script can echo it inline.
    pub reason:           Option<String>,
}

/// Names of the three async gates the runner evaluates. Used for the
/// `GateRunStarted` event payload + dock UI bootstrap.
pub const GATE_NAMES: [&str; 3] = ["self_review", "substrate_simulate", "security_scan"];

/// Run the local subset against `input`. Sequence:
///   1. Emit [`DaemonEvent::GateRunStarted`].
///   2. Resolve a substrate replay backend (best-effort; `None`
///      makes Gate 6 return `deferred` immediately).
///   3. Evaluate Gates 5 + 6 + 9 in parallel via `tokio::join!`.
///      Each branch emits a `GateProgress` event when it transitions
///      `running → passed/failed`.
///   4. Stitch `allowed = no blocking gate failed` and emit
///      [`DaemonEvent::GateRunCompleted`].
///   5. Return [`GateRunOutcome`].
///
/// The HTTP handler wraps this whole call in `tokio::time::timeout`
/// (default 30s) and on timeout returns `allowed=false` with reason
/// `"gate runner timeout"` — that's outside this function's scope so
/// the runner stays focused on the gate semantics.
pub async fn run_local_subset(
    daemon: &Arc<DaemonHandle>,
    store:  &Arc<Store>,
    client: Option<&OpenAIClient>,
    input:  &GateRunInput,
) -> GateRunOutcome {
    let started = Instant::now();

    daemon.bus.publish(DaemonEvent::GateRunStarted {
        run_id:  input.run_id.clone(),
        repo_id: input.repo_id.clone(),
        gates:   GATE_NAMES.iter().map(|s| (*s).to_string()).collect(),
    });

    let backend: Option<Box<dyn ReplayBackend>> = auto_backend();

    // Surface the trio of futures with per-gate progress wrapping.
    let g5_fut = run_gate_with_progress(
        daemon,
        &input.run_id,
        "self_review",
        async {
            match client {
                Some(c) => eval_gate_5_self_review(c, &input.diff_body, &input.commit_message).await,
                // No AI client wired (e.g. NoKey, test harness without a
                // mock URL configured) — surface as deferred so push
                // proceeds. The dock can prompt the user to configure a
                // key from the bypass UI.
                None => GateVerdict::deferred(
                    "self_review",
                    "AI client unavailable — configure OpenAI key in Settings",
                ),
            }
        },
    );

    let g6_fut = run_gate_with_progress(
        daemon,
        &input.run_id,
        "substrate_simulate",
        async {
            eval_gate_6_substrate_simulate(
                store,
                backend.as_deref(),
                &input.repo_id,
            ).await
        },
    );

    let g9_fut = run_gate_with_progress(
        daemon,
        &input.run_id,
        "security_scan",
        async { eval_gate_9_security_scan(&input.diff_body).await },
    );

    let (g5, g6, g9) = tokio::join!(g5_fut, g6_fut, g9_fut);

    let individual = vec![g5, g6, g9];
    let blocking: Vec<String> = individual.iter()
        .filter(|v| !v.passed && !v.deferred)
        .map(|v| v.name.clone())
        .collect();
    let allowed = blocking.is_empty();

    let reason: Option<String> = if allowed {
        None
    } else {
        let parts: Vec<String> = individual.iter()
            .filter(|v| !v.passed && !v.deferred)
            .filter_map(|v| v.reason.clone())
            .collect();
        Some(parts.join("; "))
    };

    let total_latency_ms = started.elapsed().as_millis() as u64;

    daemon.bus.publish(DaemonEvent::GateRunCompleted {
        run_id:           input.run_id.clone(),
        allowed,
        blocking_gates:   blocking.clone(),
        total_latency_ms,
    });

    // Persist the run row for the audit trail. Failure is non-fatal:
    // the runner returns its verdict either way (better to push than
    // to crash on a transient SQLite hiccup).
    let individual_json = serde_json::to_string(&individual).unwrap_or_else(|_| "[]".into());
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let row = queries::NewGateRun {
        run_id:              &input.run_id,
        repo_id:             &input.repo_id,
        sha:                 &input.sha,
        ref_:                &input.ref_,
        allowed,
        blocking_gates:      &blocking,
        individual_verdicts: &individual_json,
        total_latency_ms,
        created_at_ms:       now_ms,
        override_used:       false,
        override_reason:     None,
    };
    if let Err(e) = queries::insert_gate_run(store, &row) {
        tracing::warn!(error = %e, run_id = %input.run_id, "gate run audit row failed (continuing)");
    }

    GateRunOutcome {
        run_id: input.run_id.clone(),
        allowed,
        blocking_gates: blocking,
        individual,
        total_latency_ms,
        reason,
    }
}

/// Wrap one gate evaluator: emit `running` before the future awaits,
/// `passed` / `failed` after with measured latency. The verdict
/// returned is exactly what the inner future produced — the wrapper
/// adds no decision logic.
async fn run_gate_with_progress<F>(
    daemon: &Arc<DaemonHandle>,
    run_id: &str,
    gate_name: &'static str,
    fut: F,
) -> GateRunVerdict
where
    F: std::future::Future<Output = GateRunVerdict>,
{
    daemon.bus.publish(DaemonEvent::GateProgress {
        run_id:     run_id.to_string(),
        gate:       gate_name.to_string(),
        state:      "running".to_string(),
        reason:     None,
        latency_ms: 0,
    });

    let started = Instant::now();
    let verdict = fut.await;
    let latency_ms = started.elapsed().as_millis() as u64;

    let state = if verdict.passed && !verdict.deferred {
        "passed"
    } else if verdict.deferred {
        "deferred"
    } else {
        "failed"
    };
    daemon.bus.publish(DaemonEvent::GateProgress {
        run_id:     run_id.to_string(),
        gate:       gate_name.to_string(),
        state:      state.to_string(),
        reason:     verdict.reason.clone(),
        latency_ms,
    });

    verdict
}

/// Persist a bypass row + emit the bus event. Called by the HTTP
/// handler when the `X-Inari-Bypass: 1` header is present, AND by
/// the post-hoc IPC `request_bypass` (the IPC variant carries a
/// reason; the header variant does not).
pub fn record_bypass(
    daemon:           &Arc<DaemonHandle>,
    store:            &Arc<Store>,
    run_id:           &str,
    repo_id:          &str,
    sha:              &str,
    ref_:             &str,
    reason:           Option<String>,
) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let empty: Vec<String> = Vec::new();
    let row = queries::NewGateRun {
        run_id,
        repo_id,
        sha,
        ref_,
        allowed:             true,
        blocking_gates:      &empty,
        individual_verdicts: "[]",
        total_latency_ms:    0,
        created_at_ms:       now_ms,
        override_used:       true,
        override_reason:     reason.as_deref(),
    };
    if let Err(e) = queries::insert_gate_run(store, &row) {
        tracing::warn!(error = %e, run_id = %run_id, "bypass audit row failed (continuing)");
    }
    daemon.bus.publish(DaemonEvent::GateBypassUsed {
        run_id:  run_id.to_string(),
        repo_id: repo_id.to_string(),
        reason,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_names_are_three() {
        assert_eq!(GATE_NAMES.len(), 3);
        assert!(GATE_NAMES.contains(&"self_review"));
        assert!(GATE_NAMES.contains(&"substrate_simulate"));
        assert!(GATE_NAMES.contains(&"security_scan"));
    }
}
