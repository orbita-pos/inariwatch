//! Procedural matcher — sync read-side over `.inari/patterns.json`.
//!
//! Independent from [`learner`](super::learner) on purpose: the
//! matcher loads patterns from disk on every call rather than sharing
//! the learner's in-memory cache. Justification:
//!
//!   * The matcher is called by future remediation context-gathering
//!     code (Sesión 19's `single_shot.rs` is the planned consumer); a
//!     single load + ranking is well under 1 ms for the typical
//!     ≤500-pattern file.
//!   * Sharing the cache would couple the modules. v0.1 stays
//!     decoupled; if a hot-path benchmark ever surfaces a need, the
//!     `Cache` type from `learner` can be lifted to a module-level
//!     `OnceLock<Arc<RwLock<...>>>` and read from both sides.
//!
//! ### Ranking
//!
//!   `score = success_rate * recency_weight`
//!
//! where:
//!
//!   * `success_rate = success / (success + failure)`
//!     (simple proportion — Wilson lower bound deferred until the
//!     dataset > 1000 patterns; see DECISIONS 2026-05-01).
//!   * `recency_weight = exp(-age_days / RECENCY_HALFLIFE_DAYS)`
//!     (half-life 30 days — a 60-day-old pattern weighs half a 0-day
//!     one).
//!
//! Anti-patterns are surfaced by default (opt-out via
//! [`MatchOptions::include_anti_patterns = false`]). Skipping them
//! silently would let a known-bad fix re-emerge — the consumer should
//! always know the pattern exists, even if to display "do NOT try
//! this fix" UX.

use std::path::PathBuf;

use crate::memory::error::Result;
use crate::store::{queries, Store};

use super::learner::{load_patterns, patterns_path};
use super::{Pattern, PatternKind};

/// Caller-tunable options for [`match_patterns`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MatchOptions {
    /// Patterns older than this are dropped from results. Measured in
    /// whole days against `last_seen_ms`.
    pub max_age_days:         u32,
    /// Maximum number of `PatternMatch` rows returned. The actual
    /// returned count is `min(top_k, eligible.len())`.
    pub top_k:                usize,
    /// When `false`, drops `PatternKind::AntiPattern` rows from the
    /// result. Default `true` — the consumer should be aware of
    /// anti-patterns even when surfacing positive recommendations.
    pub include_anti_patterns: bool,
}

impl Default for MatchOptions {
    fn default() -> Self {
        Self {
            max_age_days:          90,
            top_k:                 5,
            include_anti_patterns: true,
        }
    }
}

/// One ranked match. `score` and `age_days` are computed at call time
/// and never persisted — the on-disk format stays float-free.
#[derive(Debug, Clone)]
pub struct PatternMatch {
    pub pattern:  Pattern,
    pub score:    f64,
    pub age_days: u32,
}

/// Half-life for recency weighting — a pattern N days older than now
/// scores `0.5^(N/30)` of a fresh pattern. Chosen so a 30-day-old
/// pattern is still strongly weighted (0.5) while a 90-day-old one
/// is significantly downweighted (0.125).
const RECENCY_HALFLIFE_DAYS: f64 = 30.0;

/// Find patterns whose fingerprint matches `error_fingerprint`,
/// filtered by [`MatchOptions`] and ranked by
/// `success_rate * recency_weight`.
///
/// `async` only because the public-facing call site is async; the
/// implementation is sync (file read + ranking on the calling task,
/// no `spawn_blocking`). If the disk read ever shows up in a profile,
/// wrap the body in `tokio::task::spawn_blocking` — the function
/// signature already supports it.
///
/// Returns `Ok(Vec::new())` on every "no match" path:
///   * repo unknown to store
///   * patterns.json missing
///   * patterns.json corrupt (the learner already emitted the
///     `SensorWarning` on a prior write, so silent here is fine)
///   * no fingerprint match
pub async fn match_patterns(
    store:             &Store,
    repo_id:           &str,
    error_fingerprint: &str,
    opts:              MatchOptions,
) -> Result<Vec<PatternMatch>> {
    let Some(repo_root) = queries::find_repo_path_by_id(store, repo_id)? else {
        return Ok(Vec::new());
    };
    let path = patterns_path(&PathBuf::from(repo_root));
    let file = match load_patterns(&path) {
        Ok(f)  => f,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(rank_patterns(file.patterns, error_fingerprint, opts, now_ms()))
}

/// Pure ranking helper. Extracted so unit tests can drive it with a
/// fixed clock (no `now_ms()` flakes) and a synthetic pattern list.
pub(crate) fn rank_patterns(
    patterns:          Vec<Pattern>,
    error_fingerprint: &str,
    opts:              MatchOptions,
    now_ms:            i64,
) -> Vec<PatternMatch> {
    let max_age_ms = (opts.max_age_days as i64) * 86_400_000;
    let mut matches: Vec<PatternMatch> = patterns
        .into_iter()
        .filter(|p| p.fingerprint == error_fingerprint)
        .filter(|p| opts.include_anti_patterns || !matches!(p.kind, PatternKind::AntiPattern))
        .filter(|p| now_ms.saturating_sub(p.last_seen_ms) <= max_age_ms)
        .map(|p| {
            let age_ms   = (now_ms.saturating_sub(p.last_seen_ms)).max(0);
            let age_days = (age_ms / 86_400_000) as u32;
            let total    = (p.success_count + p.failure_count).max(1) as f64;
            let success_rate = p.success_count as f64 / total;
            let recency  = (-(age_days as f64) / RECENCY_HALFLIFE_DAYS).exp();
            let score    = success_rate * recency;
            PatternMatch { pattern: p, score, age_days }
        })
        .collect();
    // Descending by score. NaN can't be produced (success_rate ∈
    // [0,1], recency > 0), so partial_cmp.unwrap is sound — but use
    // `total_cmp`-style fallback to be defensive.
    matches.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    matches.truncate(opts.top_k);
    matches
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

    fn pat(kind: PatternKind, fp: &str, succ: u32, fail: u32, last_seen_ms: i64) -> Pattern {
        Pattern {
            kind,
            fingerprint:           fp.to_string(),
            suggested_fix_summary: format!("fix for {fp}"),
            success_count:         succ,
            failure_count:         fail,
            evidence:              Vec::new(),
            last_seen_ms,
            created_at_ms:         0,
        }
    }

    const NOW: i64 = 1_000_000_000_000; // arbitrary fixed "now"
    const DAY: i64 = 86_400_000;

    #[test]
    fn anti_pattern_excluded_when_opted_out() {
        let patterns = vec![
            pat(PatternKind::AutoDetected, "fp", 3, 0, NOW),
            pat(PatternKind::AntiPattern,  "fp", 0, 5, NOW),
        ];
        let r = rank_patterns(
            patterns,
            "fp",
            MatchOptions { include_anti_patterns: false, ..Default::default() },
            NOW,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].pattern.kind, PatternKind::AutoDetected);
    }

    #[test]
    fn anti_pattern_included_by_default() {
        let patterns = vec![
            pat(PatternKind::AutoDetected, "fp", 3, 0, NOW),
            pat(PatternKind::AntiPattern,  "fp", 0, 5, NOW),
        ];
        let r = rank_patterns(patterns, "fp", MatchOptions::default(), NOW);
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn fresh_high_rate_outranks_stale_perfect() {
        // Fresh 90% success vs 60-day-old 100% success.
        // Fresh: 0.9 * 1.0 = 0.9
        // Stale: 1.0 * 0.5^(60/30) = 1.0 * 0.25 = 0.25
        let patterns = vec![
            pat(PatternKind::AutoDetected, "fp", 9, 1, NOW),                // fresh
            pat(PatternKind::AutoDetected, "fp", 1, 0, NOW - 60 * DAY),     // stale perfect
        ];
        let r = rank_patterns(patterns, "fp", MatchOptions::default(), NOW);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].pattern.success_count, 9, "fresh-high-rate must rank first");
        assert!(r[0].score > r[1].score);
    }

    #[test]
    fn max_age_filters_old_patterns() {
        let patterns = vec![
            pat(PatternKind::AutoDetected, "fp", 1, 0, NOW),
            pat(PatternKind::AutoDetected, "fp", 1, 0, NOW - 100 * DAY),
        ];
        let r = rank_patterns(
            patterns,
            "fp",
            MatchOptions { max_age_days: 90, ..Default::default() },
            NOW,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].age_days, 0);
    }

    #[test]
    fn fingerprint_filter() {
        let patterns = vec![
            pat(PatternKind::AutoDetected, "fp_a", 1, 0, NOW),
            pat(PatternKind::AutoDetected, "fp_b", 1, 0, NOW),
        ];
        let r = rank_patterns(patterns, "fp_b", MatchOptions::default(), NOW);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].pattern.fingerprint, "fp_b");
    }

    #[test]
    fn top_k_truncates() {
        let patterns: Vec<_> = (0..20)
            .map(|i| pat(PatternKind::AutoDetected, "fp", i + 1, 0, NOW))
            .collect();
        let r = rank_patterns(
            patterns,
            "fp",
            MatchOptions { top_k: 5, ..Default::default() },
            NOW,
        );
        assert_eq!(r.len(), 5);
    }
}
