//! Procedural memory — Layer 4 of the 4-layer memory stack.
//!
//! Persists "what worked" / "what didn't work" knowledge across
//! remediation sessions. Each entry is keyed by the deterministic error
//! fingerprint from [`crate::memory::fingerprint`] so the same error
//! class — regardless of timestamps, IDs, or paths — collapses onto the
//! same row. The dock-side AI (Sesión 19) can then ask the matcher
//! "what fix has worked for this fingerprint before?" and either
//! propose the known good fix or block a known-bad one.
//!
//! ### Submodules
//!
//!   * [`learner`] — long-running task that subscribes to the daemon
//!                   bus and updates `.inari/patterns.json` on every
//!                   remediation outcome.
//!   * [`matcher`] — synchronous read-side: load patterns + score them
//!                   for a given fingerprint, return top-K.
//!
//! ### Storage
//!
//! Patterns live in `<repo_root>/.inari/patterns.json`. Commit-friendly
//! by design — stable key order, 2-space indent, no floats. The
//! `.inari/` directory is gitignored by default by the declarative
//! watcher's `augment_gitignore` (Sesión 11), so users opt INTO sharing
//! this knowledge by removing the gitignore line.
//!
//! ### Spec note (Sesión 12)
//!
//! HANDOFF originally specified subscription to
//! `FixApplied`/`FixRejected`/`RegressionDetected`. Actual implementation
//! subscribes to `RemediationCompleted` + `FixRejected` (the existing
//! event shapes from S19) and joins event → `remediation_sessions` row
//! in store for the `(repo_id, fingerprint)` pair. Semantic equivalence
//! preserved; the nomenclature delta is documented in DECISIONS
//! 2026-05-01. `RegressionDetected` is deferred entirely — see the
//! same DECISIONS entry for the reopen condition.

pub mod learner;
pub mod matcher;

use serde::{Deserialize, Serialize};

/// Whether a pattern represents validated success knowledge or
/// validated failure knowledge.
///
/// On-wire (in `.inari/patterns.json` and on the daemon bus
/// `PatternLearned`/`PatternDemoted` events) the variants serialize as
/// kebab-case strings: `auto-detected` / `anti-pattern`. The kebab-case
/// is intentional — it matches the schema doc + the original spec
/// language ("auto-detected" patterns become "anti-patterns" on
/// majority failure) and keeps the JSON file readable for humans
/// browsing the repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PatternKind {
    /// The learner has seen at least one successful fix for this
    /// fingerprint and successes outnumber failures (or there are no
    /// failures yet). Eligible for matcher recall.
    AutoDetected,
    /// Failures outweigh successes (`failure_count > success_count`)
    /// or a regression was forced. The matcher SURFACES anti-patterns
    /// to the consumer — they're a "do NOT try fix X again" signal,
    /// not a hidden row.
    AntiPattern,
}

impl PatternKind {
    /// Wire string used by `DaemonEvent::PatternLearned::kind`. Mirrors
    /// the kebab-case JSON encoding so a downstream subscriber that
    /// reads the event + the file sees the same string.
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            PatternKind::AutoDetected => "auto-detected",
            PatternKind::AntiPattern  => "anti-pattern",
        }
    }
}

/// One learned pattern. Field order is the canonical JSON key order —
/// `serde_json::to_string_pretty` emits keys in struct-declaration
/// order, so changing the order here is a wire-format break. Don't
/// reorder without bumping `PatternsFile::version` and writing a
/// migration step in `learner::load_patterns`.
///
/// All numeric fields are integers (`u32` / `i64`). Floats are
/// intentionally banned from the on-disk format so a round-trip
/// (load → save) is byte-identical with no precision drift. The
/// matcher's ranking uses `f64` internally but those scores live only
/// in memory and never hit disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pattern {
    pub kind:                  PatternKind,
    pub fingerprint:           String,
    pub suggested_fix_summary: String,
    pub success_count:         u32,
    pub failure_count:         u32,
    /// Session ids of remediations that contributed to this pattern.
    /// Capped at [`MAX_EVIDENCE_PER_PATTERN`]; oldest entries are
    /// dropped when the cap is exceeded.
    pub evidence:              Vec<String>,
    pub last_seen_ms:          i64,
    pub created_at_ms:         i64,
}

/// Top-level shape of `.inari/patterns.json`. `version` is bumped when
/// the on-disk schema changes; today it's locked at 1 and parsing a
/// future version higher than the current `CURRENT_VERSION` is a
/// graceful warn (the learner skips the file rather than corrupting it
/// with an old-shape write).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatternsFile {
    pub version:  u32,
    pub patterns: Vec<Pattern>,
}

/// Per-repo cap. When the learner crosses this threshold it drops the
/// `PRUNE_BATCH` lowest-scoring `auto-detected` rows. `anti-pattern`
/// rows are NEVER pruned — a forgotten "do not try this fix" lesson is
/// strictly worse than the disk overhead of keeping the row.
pub const MAX_PATTERNS_PER_REPO: usize = 500;

/// How many low-score `auto-detected` rows the learner drops in one
/// pass when it crosses [`MAX_PATTERNS_PER_REPO`]. 10% of the cap
/// keeps the bookkeeping bounded without re-pruning every insert.
pub const PRUNE_BATCH: usize = MAX_PATTERNS_PER_REPO / 10;

/// Per-pattern evidence cap. Sessions beyond this count are dropped
/// (oldest first) — the count fields on the pattern preserve the full
/// history; evidence is just a sample for human inspection.
pub const MAX_EVIDENCE_PER_PATTERN: usize = 50;

/// Current `PatternsFile::version`. Bump on schema-incompatible changes
/// and add a migration arm in `learner::load_patterns`.
pub const CURRENT_VERSION: u32 = 1;

pub use learner::{spawn_pattern_learner, PatternLearnerHandle};
pub use matcher::{match_patterns, MatchOptions, PatternMatch};
