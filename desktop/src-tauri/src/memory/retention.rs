//! Per-kind TTL retention runner for the episodic `events` table.
//!
//! Wakes once an hour, deletes rows older than each kind's TTL, and
//! runs `VACUUM` on tick when enough rows were removed to make
//! reclaiming pages worthwhile. The TTL table is a hard-coded const
//! so a config change is a code change (auditable in git, no runtime
//! drift). Rationale + per-kind defaults are documented in
//! `INARI_LIVE_HANDOFF.md` Sesión 13 spec.
//!
//! ### Cadence
//!
//! 1 hour. Faster wakes (e.g. every minute) would shave at most a few
//! kB at the cost of background CPU on a tray-resident process; the
//! `events` table is bounded by sensor rates measured in low Hz, so
//! deferring deletion by up to an hour is fine. Slower wakes risk
//! letting a burst (e.g. an `npm install` shell-event flood) sit
//! around for the better part of a day.
//!
//! ### Test hook
//!
//! [`RetentionRunner::run_once_for_tests`] runs the same logic as one
//! tick of [`spawn_retention_runner`] using a caller-supplied `now`.
//! This lets integration tests insert "old" rows with a synthesized
//! timestamp and observe deletion deterministically without sleeping
//! for an hour.

use std::sync::Arc;
use std::time::Duration;

use tauri::async_runtime::JoinHandle;
use tokio::time::interval;
use tracing::{debug, info, warn};

use crate::store::{queries, Store};

use super::error::Result;

/// How often the runner ticks. Hard-coded — runtime tuning would
/// require persisting state and reasoning about migration; the
/// hourly cadence is a fixed product decision (see HANDOFF Sesión 13).
pub const TICK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Tick deletes ≥ this many rows ⇒ run `VACUUM` to reclaim pages.
/// 10k is the round number the spec locks: small enough that the
/// VACUUM rewrite stays sub-second on the tray-process budget,
/// large enough that we don't VACUUM on a tick that only swept a
/// handful of stale shell events.
pub const VACUUM_ROW_THRESHOLD: usize = 10_000;

/// Per-kind retention horizon. `Infinite` = never delete (audit
/// trail). Locked to the table in INARI_LIVE_HANDOFF Sesión 13.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventTtl {
    Days(u32),
    Infinite,
}

impl EventTtl {
    /// Convert `Days(N)` into a millisecond cutoff relative to `now`.
    /// `Infinite` returns `None` (caller skips the delete).
    pub fn cutoff_ms(self, now_ms: i64) -> Option<i64> {
        match self {
            EventTtl::Days(n)  => Some(now_ms - (n as i64) * 24 * 60 * 60 * 1000),
            EventTtl::Infinite => None,
        }
    }
}

/// Resolve the TTL for a `kind` tag string. The strings here MUST
/// stay in sync with `crate::memory::episodic::kind_tag` — adding a
/// new persisted variant means deciding its retention here.
pub fn ttl_for(kind: &str) -> EventTtl {
    match kind {
        // 30 days: useful "recent activity" without keeping forever.
        "fs_change"         => EventTtl::Days(30),
        "shell_event"       => EventTtl::Days(30),
        "replay_result"     => EventTtl::Days(30),
        "reindex_requested" => EventTtl::Days(30),
        "symbols_indexed"   => EventTtl::Days(30),
        "repo_indexed"      => EventTtl::Days(30),
        // Audit trail — never expire. Git milestones are cheap and
        // the remediation pipeline benefits from "what did the user
        // ship over the last quarter?" lookups.
        "git_event"             => EventTtl::Infinite,
        // Sesión 19 — fix audit trail. Same rationale as `git_event`:
        // remediation history is cheap to keep and supports the
        // "did this fingerprint already get attempted?" lookup.
        "remediation_started"   => EventTtl::Infinite,
        "remediation_completed" => EventTtl::Infinite,
        "fix_rejected"          => EventTtl::Infinite,
        // Default to never-delete for unknown kinds. Better to leak
        // a few rows than to silently drop user data because someone
        // forgot to add an arm.
        _                       => EventTtl::Infinite,
    }
}

/// Every kind the runner is responsible for sweeping. Iterating a
/// const slice keeps the tick loop trivial + makes "is this kind
/// covered?" a code-review check rather than a runtime surprise.
pub const MANAGED_KINDS: &[&str] = &[
    "fs_change",
    "shell_event",
    "replay_result",
    "reindex_requested",
    "symbols_indexed",
    "repo_indexed",
    "git_event",
];

/// Per-tick summary used by tests + telemetry.
#[derive(Debug, Default, Clone)]
pub struct TickReport {
    /// Rows deleted across all kinds during the tick.
    pub deleted: usize,
    /// Whether `VACUUM` ran on this tick.
    pub vacuumed: bool,
}

/// Runner state. Cheap to clone — the store handle is already
/// `Arc`-shared and the rest is `Copy`.
#[derive(Clone)]
pub struct RetentionRunner {
    pub store: Arc<Store>,
}

impl RetentionRunner {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }

    /// Run one sweep using `now_ms` as the reference time. Always
    /// available (not behind `cfg(test)`) so callers in
    /// `tests/retention_*` integration files can drive the runner
    /// deterministically without depending on wall-clock or
    /// `tokio::time::pause`.
    pub fn run_once_for_tests(&self, now_ms: i64) -> Result<TickReport> {
        let mut report = TickReport::default();
        for kind in MANAGED_KINDS {
            let ttl = ttl_for(kind);
            let Some(cutoff) = ttl.cutoff_ms(now_ms) else {
                continue;
            };
            let n = queries::delete_events_older_than(&self.store, kind, cutoff)?;
            report.deleted += n;
        }
        if report.deleted >= VACUUM_ROW_THRESHOLD {
            queries::vacuum(&self.store)?;
            report.vacuumed = true;
        }
        Ok(report)
    }

    fn tick(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        match self.run_once_for_tests(now) {
            Ok(r) => {
                info!(
                    target  = "memory.retention",
                    deleted = r.deleted,
                    vacuumed = r.vacuumed,
                    "retention tick"
                );
            }
            Err(e) => {
                warn!(
                    target = "memory.retention",
                    error  = %e,
                    "retention tick failed (continuing)"
                );
            }
        }
    }
}

/// Spawn the long-running retention task. Wakes every
/// [`TICK_INTERVAL`]; idempotent on shutdown — the caller drops the
/// returned handle (or the store goes away) and the task exits at
/// the next tick / await point.
pub fn spawn_retention_runner(store: Arc<Store>) -> JoinHandle<()> {
    let runner = RetentionRunner::new(store);
    tauri::async_runtime::spawn(async move {
        debug!(target: "memory.retention", "retention runner started");
        // `interval` fires immediately on the first poll. Skip that
        // first tick so startup doesn't pay an extra DB write before
        // anything has aged out.
        let mut ticker = interval(TICK_INTERVAL);
        ticker.tick().await; // consume the immediate-fire
        loop {
            ticker.tick().await;
            runner.tick();
        }
    })
}
