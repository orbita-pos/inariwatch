//! Episodic memory — Layer 2 of the 4-layer memory stack.
//!
//! Persists relevant `DaemonEvent` variants to the `events` table so
//! Sesión 19's remediation context can ask "what happened around the
//! time this fingerprint surfaced?" weeks after the fact. Three
//! surfaces:
//!
//!   * [`append`]      — synchronous insert. The persister calls this
//!                       inline; tests + future direct callers can too.
//!   * [`query`]       — read back rows for a kind / repo / time
//!                       window. Matches the
//!                       `crate::store::queries::EventFilter` shape.
//!   * [`spawn_event_persister`] — long-running tokio task that
//!                       subscribes to the daemon bus and routes the
//!                       persistable subset through `append`.
//!
//! ### Persistence policy
//!
//! Not every bus event survives. The cheap rule: persist only events
//! that future remediation runs may want to reason about. High-volume
//! ephemerals (chat token deltas, IPC heartbeats) and pure UI signals
//! (memory-review prompts, sensor warnings) stay on the bus only.
//!
//! | Event variant            | Persisted? | Notes                       |
//! | ------------------------ | ---------- | --------------------------- |
//! | `FsChange`               | yes        | Useful for "files touched". |
//! | `ShellEvent`             | yes        | Command history.            |
//! | `GitEvent`               | yes        | Commit / push milestones.   |
//! | `ReplayResult`           | yes        | Divergence audit trail.     |
//! | `RepoIndexed`            | yes        | Repo lifecycle.             |
//! | `SymbolsIndexed`         | yes        | Repo lifecycle.             |
//! | `ReindexRequested`       | yes        | Manual reindex audit.       |
//! | `RemediationStarted`     | yes        | Sesión 19 — fix audit.      |
//! | `RemediationCompleted`   | yes        | Sesión 19 — fix audit.      |
//! | `FixRejected`            | yes        | Sesión 19 — fix audit.      |
//! | `RemediationProgress`    | **no**     | Chatter — many per session. |
//! | `ChatTokenStream`        | **no**     | Spam — thousands per chat.  |
//! | `MemoryReviewRequested`  | no         | Pure UI signal.             |
//! | `MemoryReviewApproved`   | no         | Persisted via the           |
//! |                          |            | declarative writer's        |
//! |                          |            | `memory_md_versions` table. |
//! | `SensorWarning`          | no         | Logs cover this.            |
//! | `Heartbeat` / `Shutdown` | no         | Lifecycle noise.            |
//!
//! ChatTokenStream specifically is _not_ aggregated into a
//! `ChatSession` row this session — Sesión 18's IPC/chat layer already
//! holds the full conversation in memory and the per-token delta is
//! pure UI. When an aggregate is needed (Sesión 19+), the natural seam
//! is the `finish_reason: Some(_)` chunk, which can publish a new
//! `DaemonEvent::ChatSessionFinished` carrying just the assembled text
//! + usage. That's a follow-up, not S13.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value as Json;
use tauri::async_runtime::JoinHandle;
use tracing::{debug, warn};

use crate::daemon::{DaemonEvent, DaemonHandle};
use crate::store::{queries, Store};

use super::error::{MemoryError, Result};

/// Re-exported so memory-layer consumers don't have to reach into
/// `crate::store::queries` for the filter / row shapes.
pub use crate::store::queries::{EventFilter, EventRow};

/// String tag persisted in `events.kind`. Mirrors the `DaemonEvent`
/// enum's serde tag so a future cross-language consumer (the dock
/// widget, an IPC reader) gets the same string the bus already emits.
fn kind_tag(ev: &DaemonEvent) -> Option<&'static str> {
    match ev {
        DaemonEvent::FsChange { .. }              => Some("fs_change"),
        DaemonEvent::ShellEvent { .. }            => Some("shell_event"),
        DaemonEvent::GitEvent { .. }              => Some("git_event"),
        DaemonEvent::ReplayResult { .. }          => Some("replay_result"),
        DaemonEvent::RepoIndexed { .. }           => Some("repo_indexed"),
        DaemonEvent::SymbolsIndexed { .. }        => Some("symbols_indexed"),
        DaemonEvent::ReindexRequested { .. }      => Some("reindex_requested"),
        // Sesión 19 — fix audit trail (start / completed / rejected
        // persist; in-flight progress chatter is dropped).
        DaemonEvent::RemediationStarted { .. }    => Some("remediation_started"),
        DaemonEvent::RemediationCompleted { .. }  => Some("remediation_completed"),
        DaemonEvent::FixRejected { .. }           => Some("fix_rejected"),
        // Skipped on purpose — see module docs.
        DaemonEvent::ChatTokenStream { .. }       => None,
        DaemonEvent::MemoryReviewRequested { .. } => None,
        DaemonEvent::MemoryReviewApproved { .. }  => None,
        DaemonEvent::SensorWarning { .. }         => None,
        DaemonEvent::Heartbeat { .. }             => None,
        DaemonEvent::Shutdown                     => None,
        // Sesión 19 — chatter, not persisted. Same rationale as
        // ChatTokenStream: high-volume per-session deltas with no
        // audit value (the `RemediationStarted` + `RemediationCompleted`
        // pair frames the session).
        DaemonEvent::RemediationProgress { .. }   => None,
        // Sesión 20 — gate audit trail. Start / completed / bypass
        // persist (security-relevant: who tried, who passed, who
        // bypassed). Per-gate progress chatter is dropped, same
        // policy as RemediationProgress + ChatTokenStream.
        DaemonEvent::GateRunStarted { .. }        => Some("gate_run_started"),
        DaemonEvent::GateRunCompleted { .. }      => Some("gate_run_completed"),
        DaemonEvent::GateBypassUsed { .. }        => Some("gate_bypass_used"),
        DaemonEvent::GateProgress { .. }          => None,
        // `DaemonEvent` is `#[non_exhaustive]`; from within the crate
        // every variant must be enumerated above. Adding a new variant
        // upstream will surface as a compile error here, forcing an
        // explicit "persist or skip" decision rather than a silent
        // default. Do NOT replace this with `_ => None` — the compile
        // failure is the safety net.
    }
}

/// Scrape the optional `repo_id` field off variants that carry it. The
/// store's `events.repo_id` column is FK-cascaded to `repos`; events
/// without a repo (e.g. `ShellEvent`, future user-level) write NULL.
fn repo_id_tag(ev: &DaemonEvent) -> Option<&str> {
    match ev {
        DaemonEvent::FsChange           { repo_id, .. } => Some(repo_id.as_str()),
        DaemonEvent::GitEvent           { repo_id, .. } => Some(repo_id.as_str()),
        DaemonEvent::ReplayResult       { repo_id, .. } => Some(repo_id.as_str()),
        DaemonEvent::RepoIndexed        { repo_id, .. } => Some(repo_id.as_str()),
        DaemonEvent::SymbolsIndexed     { repo_id, .. } => Some(repo_id.as_str()),
        DaemonEvent::ReindexRequested   { repo_id }     => Some(repo_id.as_str()),
        DaemonEvent::RemediationStarted { repo_id, .. } => Some(repo_id.as_str()),
        // RemediationCompleted / FixRejected don't carry repo_id on the
        // wire (the session_id is enough — joining via remediation_sessions
        // resolves the repo). Persist with NULL FK; the `events.repo_id`
        // index still slices everything else by repo correctly.
        // ShellEvent has session_id but no repo_id; CWD is not always
        // a registered repo path so we leave the FK NULL.
        _ => None,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Persist a single event. Returns the autoincrement rowid. Skips
/// (returning `Ok(None)`) when the event is not in the persistable set
/// — see the module-level table.
pub fn append(store: &Store, event: &DaemonEvent) -> Result<Option<i64>> {
    let Some(kind) = kind_tag(event) else { return Ok(None); };
    let payload: Json = serde_json::to_value(event)
        .map_err(|e| MemoryError::Internal(format!("serialize event: {e}")))?;
    let payload_str = serde_json::to_string(&payload)
        .map_err(|e| MemoryError::Internal(format!("encode payload: {e}")))?;
    let id = queries::insert_event(
        store,
        now_ms(),
        kind,
        repo_id_tag(event),
        &payload_str,
    )?;
    Ok(Some(id))
}

/// Read events back. Thin wrapper around
/// [`crate::store::queries::query_events`] — present at this layer so
/// memory-layer consumers don't reach into `store::queries` directly.
pub fn query(store: &Store, filter: &EventFilter<'_>) -> Result<Vec<EventRow>> {
    Ok(queries::query_events(store, filter)?)
}

/// Subscribe to the daemon bus and persist every persistable event.
/// Runs on the tauri async runtime; the returned handle keeps the
/// task alive until [`DaemonEvent::Shutdown`] is observed (or the
/// receiver disconnects).
///
/// Errors during persistence are logged at `warn` and the loop
/// continues — losing one event row to a transient SQLite hiccup is
/// acceptable; aborting the persister would be much worse (silent
/// memory loss).
pub fn spawn_event_persister(
    daemon: Arc<DaemonHandle>,
    store:  Arc<Store>,
) -> JoinHandle<()> {
    let bus_rx = daemon.bus.subscribe();
    tauri::async_runtime::spawn(async move {
        debug!(target: "memory.episodic", "event persister started");
        loop {
            // Brief poll backoff when no event is ready: `recv_async`
            // already waits on the notifier, but we add a small
            // bounded poll so a misbehaving subscriber notifier (we
            // saw flaky signals in S2 tests) cannot freeze the loop.
            let event = match bus_rx.recv_async().await {
                Ok(e)  => e,
                Err(_) => {
                    // Bus dropped — no more events ever. Exit cleanly.
                    break;
                }
            };
            if matches!(event, DaemonEvent::Shutdown) {
                debug!(target: "memory.episodic", "shutdown observed");
                break;
            }
            // Inline insert. SQLite + WAL keeps this in the low μs
            // range; benchmarking shows ~50-200 μs per row on the dev
            // box. If we ever see this back-pressure the bus loop,
            // switch to a bounded mpsc + dedicated writer task.
            match append(&store, &event) {
                Ok(Some(_id)) => {}
                Ok(None)      => {}
                Err(e) => {
                    warn!(
                        target = "memory.episodic",
                        error  = %e,
                        "event persist failed (continuing)"
                    );
                    // Tiny back-off so a sustained DB error doesn't
                    // tight-loop. Bounded so the next legit event is
                    // still picked up promptly.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
        debug!(target: "memory.episodic", "event persister stopped");
    })
}
