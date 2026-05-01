//! Procedural learner — owns `.inari/patterns.json` writes and the
//! daemon-bus subscriber that drives them.
//!
//! ### Event routing
//!
//! Subscribed events:
//!
//! | Event                                       | Action                         |
//! | ------------------------------------------- | ------------------------------ |
//! | `RemediationCompleted { success: true, .. }`| `apply_success(session_id)`    |
//! | `RemediationCompleted { success: false, .. }`| `apply_failure(session_id, false)` |
//! | `FixRejected { session_id, .. }`            | `apply_failure(session_id, false)` |
//!
//! The `false` argument to [`apply_failure`] is the `forced_demote`
//! flag — reserved for the future `RegressionDetected` emitter (see
//! the DECISIONS 2026-05-01 entry "Sesión 12 — RegressionDetected
//! variant deferred"). Today no caller passes `true`; the path is
//! exercised by the unit tests in this file.
//!
//! ### Cache strategy
//!
//! In-memory `RwLock<HashMap<RepoId, PatternsFile>>` write-through
//! cache. Reads (load on first event for a repo) acquire a write lock
//! to insert; subsequent mutations update cache + persist to disk
//! under the same write lock. The matcher does NOT share this cache
//! (it's a separate read path that loads from disk on demand) — the
//! cache exists only to coalesce burst writes from the learner. See
//! DECISIONS 2026-05-01 for the rationale.
//!
//! ### Graceful degradation
//!
//! A corrupt `patterns.json` does NOT crash the learner. The file is
//! re-loaded as empty (preserving any anti-pattern history is
//! impossible without parseable bytes), a `SensorWarning` is emitted
//! on the bus, and the next successful write overwrites the corrupt
//! file. Same posture as the FS sensor's inotify-saturation path:
//! degrade visibly, never silently die.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde_json::Value as JsonValue;
use tauri::async_runtime::JoinHandle;
use tracing::{debug, warn};

use crate::daemon::{DaemonEvent, DaemonHandle};
use crate::memory::declarative;
use crate::memory::error::{MemoryError, Result};
use crate::store::{queries, Store};

use super::{
    Pattern, PatternKind, PatternsFile, CURRENT_VERSION, MAX_EVIDENCE_PER_PATTERN,
    MAX_PATTERNS_PER_REPO, PRUNE_BATCH,
};

/// Tauri runtime handle for the spawned learner task. Drop to
/// detach (the task continues running until `Shutdown` is observed
/// on the bus).
pub type PatternLearnerHandle = JoinHandle<()>;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve `.inari/patterns.json` for a repo's filesystem root.
pub fn patterns_path(repo_root: &Path) -> PathBuf {
    declarative::inari_dir(repo_root).join("patterns.json")
}

/// Load patterns from disk. Missing file → empty `PatternsFile` with
/// the current version (NOT an error — a brand-new repo has nothing
/// learned yet). Parse failure → propagated as `MemoryError::Parse`;
/// the learner converts that to a `SensorWarning` and continues with
/// an empty cache. A version newer than [`CURRENT_VERSION`] is also
/// `MemoryError::Parse` ("future version, refusing to overwrite").
pub fn load_patterns(path: &Path) -> Result<PatternsFile> {
    if !path.exists() {
        return Ok(PatternsFile {
            version:  CURRENT_VERSION,
            patterns: Vec::new(),
        });
    }
    let bytes = std::fs::read(path)?;
    let raw: JsonValue = serde_json::from_slice(&bytes)
        .map_err(|e| MemoryError::Parse(format!("patterns.json: {e}")))?;
    // Read version first so we can refuse to load a future schema
    // without trying to deserialise into the current Pattern shape.
    let version = raw.get("version").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if version > CURRENT_VERSION {
        return Err(MemoryError::Parse(format!(
            "patterns.json version {version} > current {CURRENT_VERSION}; refusing to overwrite"
        )));
    }
    let file: PatternsFile = serde_json::from_value(raw)
        .map_err(|e| MemoryError::Parse(format!("patterns.json: {e}")))?;
    Ok(file)
}

/// Persist patterns to disk via the shared atomic-write helper. Uses
/// `serde_json::to_string_pretty` with the default 2-space indent.
/// Field order is the struct declaration order in [`Pattern`] +
/// [`PatternsFile`] — that's the canonical key order. Round-tripping
/// the same file (load → save) is byte-identical when nothing has
/// mutated the in-memory state.
pub fn save_patterns(path: &Path, file: &PatternsFile) -> Result<()> {
    let body = serde_json::to_string_pretty(file)
        .map_err(|e| MemoryError::Internal(format!("serialize patterns.json: {e}")))?;
    // Trailing newline so editors / git diff don't surface a "no
    // newline at end of file" warning.
    let mut body_with_nl = body;
    body_with_nl.push('\n');
    declarative::atomic_write(path, &body_with_nl)
}

/// Bump (or create) the success entry for `fingerprint`. Returns the
/// `(success_count, kind)` AFTER the mutation so the caller can decide
/// whether to emit `PatternLearned`.
///
/// Behavior:
///   * No existing pattern → insert a new `auto-detected` row with
///     `success_count = 1`.
///   * Existing `auto-detected` → `success_count += 1`. Append
///     `session_id` to evidence (oldest-drop at cap).
///   * Existing `anti-pattern` → `success_count += 1`, but the kind
///     does NOT auto-revert. Once a pattern is demoted, only an
///     explicit human signal can re-promote it (out of scope for
///     v0.1 — would land alongside the `acknowledge_anti_pattern`
///     IPC on a future Track-7 maintenance session).
///
/// `summary` is recorded only when creating the row; later successes
/// don't overwrite it (the first successful summary is the canonical
/// description of "what worked").
fn apply_success(
    file:          &mut PatternsFile,
    fingerprint:   &str,
    session_id:    &str,
    summary:       &str,
) -> (u32, PatternKind) {
    let now = now_ms();
    if let Some(p) = file.patterns.iter_mut().find(|p| p.fingerprint == fingerprint) {
        p.success_count = p.success_count.saturating_add(1);
        p.last_seen_ms  = now;
        p.evidence.push(session_id.to_string());
        if p.evidence.len() > MAX_EVIDENCE_PER_PATTERN {
            // Drop oldest. Not a Vec::drain because the count is
            // bounded by 1 per call (we only just pushed once); the
            // rotation is O(n) but n ≤ MAX_EVIDENCE_PER_PATTERN.
            p.evidence.remove(0);
        }
        return (p.success_count, p.kind);
    }
    let pattern = Pattern {
        kind:                  PatternKind::AutoDetected,
        fingerprint:           fingerprint.to_string(),
        suggested_fix_summary: summary.to_string(),
        success_count:         1,
        failure_count:         0,
        evidence:              vec![session_id.to_string()],
        last_seen_ms:          now,
        created_at_ms:         now,
    };
    file.patterns.push(pattern);
    prune_if_needed(file);
    (1, PatternKind::AutoDetected)
}

/// Outcome of [`apply_failure`] — surfaces whether the call demoted a
/// previously-`auto-detected` pattern so the caller can emit the
/// `PatternDemoted` event with the right `prior_success` / `new_failure`
/// snapshot.
#[derive(Debug, Clone, Copy)]
struct FailureOutcome {
    prior_success: u32,
    new_failure:   u32,
    /// `true` when this call flipped the kind from `AutoDetected`
    /// to `AntiPattern` (the demote moment).
    demoted:       bool,
    /// Reason string for the `DaemonEvent::PatternDemoted` payload,
    /// only meaningful when `demoted == true`.
    reason:        &'static str,
}

/// Bump (or create) the failure entry for `fingerprint`.
///
/// `forced_demote = true` forces the row into `AntiPattern` regardless
/// of whether `failure_count > success_count` — reserved for the
/// future `RegressionDetected` emitter. Today no production caller
/// passes `true`; the unit test `forced_demote_overrides_count_majority`
/// exercises the path so the API remains correct when the emitter
/// arrives.
///
/// If no row exists, a NEW `auto-detected` row is created with
/// `failure_count = 1` (and immediately demoted if `forced_demote =
/// true`). The first failure for an unseen fingerprint isn't yet a
/// learning signal — it just records that the system tried + failed.
fn apply_failure(
    file:           &mut PatternsFile,
    fingerprint:    &str,
    session_id:     &str,
    summary:        &str,
    forced_demote:  bool,
) -> FailureOutcome {
    let now = now_ms();
    // Either find the existing row or insert a new one and re-find
    // the index. Doing the borrow this way avoids a self-referential
    // mutable-borrow conflict that the compiler rightly rejects.
    let idx = match file.patterns.iter().position(|p| p.fingerprint == fingerprint) {
        Some(i) => i,
        None => {
            let pattern = Pattern {
                kind:                  PatternKind::AutoDetected,
                fingerprint:           fingerprint.to_string(),
                suggested_fix_summary: summary.to_string(),
                success_count:         0,
                failure_count:         0,
                evidence:              Vec::new(),
                last_seen_ms:          now,
                created_at_ms:         now,
            };
            file.patterns.push(pattern);
            prune_if_needed(file);
            file.patterns
                .iter()
                .position(|p| p.fingerprint == fingerprint)
                .expect("just-pushed pattern is locatable")
        }
    };
    let p = &mut file.patterns[idx];
    let prior_success = p.success_count;
    p.failure_count = p.failure_count.saturating_add(1);
    p.last_seen_ms  = now;
    p.evidence.push(session_id.to_string());
    if p.evidence.len() > MAX_EVIDENCE_PER_PATTERN {
        p.evidence.remove(0);
    }
    let new_failure = p.failure_count;
    let was_auto = matches!(p.kind, PatternKind::AutoDetected);
    let count_demote = was_auto && new_failure > prior_success;
    let force_demote = was_auto && forced_demote;
    let demoted = count_demote || force_demote;
    if demoted {
        p.kind = PatternKind::AntiPattern;
    }
    FailureOutcome {
        prior_success,
        new_failure,
        demoted,
        reason: if force_demote { "regression_forced" } else { "failure_majority" },
    }
}

/// Drop the [`PRUNE_BATCH`] lowest-net-evidence `AutoDetected` rows
/// when the file exceeds [`MAX_PATTERNS_PER_REPO`]. `AntiPattern` rows
/// are exempt — a forgotten anti-pattern would let a known-bad fix
/// re-surface, which is strictly worse than the few extra KB of disk.
fn prune_if_needed(file: &mut PatternsFile) {
    if file.patterns.len() <= MAX_PATTERNS_PER_REPO {
        return;
    }
    // Sort ONLY auto-detected by ascending net score so we can drop
    // the lowest-scoring N. Anti-patterns are partitioned out first.
    let mut auto_indices: Vec<usize> = file
        .patterns
        .iter()
        .enumerate()
        .filter(|(_, p)| matches!(p.kind, PatternKind::AutoDetected))
        .map(|(i, _)| i)
        .collect();
    auto_indices.sort_by_key(|&i| {
        let p = &file.patterns[i];
        // Net score: signed difference. Stable, no float, never
        // panics (saturating).
        (p.success_count as i32).saturating_sub(p.failure_count as i32)
    });
    let drop_count = PRUNE_BATCH.min(auto_indices.len());
    let mut to_drop: Vec<usize> = auto_indices.into_iter().take(drop_count).collect();
    // Sort descending so removing in this order doesn't shift later
    // indices.
    to_drop.sort_by(|a, b| b.cmp(a));
    for i in to_drop {
        file.patterns.remove(i);
    }
}

/// In-memory cache of patterns files keyed by repo id. Built up
/// lazily as events arrive (no preload at boot — repos with no
/// remediation history skip the I/O).
type Cache = Arc<RwLock<HashMap<String, PatternsFile>>>;

/// Spawn the learner on the tauri async runtime. Returns the join
/// handle; drop to detach. The task exits on `DaemonEvent::Shutdown`
/// or when the bus disconnects.
pub fn spawn_pattern_learner(
    daemon: Arc<DaemonHandle>,
    store:  Arc<Store>,
) -> PatternLearnerHandle {
    let bus_rx = daemon.bus.subscribe();
    let cache: Cache = Arc::new(RwLock::new(HashMap::new()));
    tauri::async_runtime::spawn(async move {
        debug!(target: "memory.procedural", "pattern learner started");
        loop {
            let event = match bus_rx.recv_async().await {
                Ok(e)  => e,
                Err(_) => break, // bus dropped
            };
            if matches!(event, DaemonEvent::Shutdown) {
                debug!(target: "memory.procedural", "shutdown observed");
                break;
            }
            // Match exhaustively so a future `DaemonEvent` variant
            // forces an explicit "consume or ignore" decision here
            // rather than a silent default.
            match &event {
                DaemonEvent::RemediationCompleted { session_id, success: true, summary } => {
                    handle_success(&daemon, &store, &cache, session_id, summary).await;
                }
                DaemonEvent::RemediationCompleted { session_id, success: false, summary } => {
                    handle_failure(&daemon, &store, &cache, session_id, summary, false).await;
                }
                DaemonEvent::FixRejected { session_id, reason } => {
                    let summary = reason.clone().unwrap_or_default();
                    handle_failure(&daemon, &store, &cache, session_id, &summary, false).await;
                }
                // Variants we explicitly ignore. Listed (not `_`) so
                // a new variant is a build-time prompt to classify.
                DaemonEvent::Heartbeat { .. }
                | DaemonEvent::Shutdown
                | DaemonEvent::RepoIndexed { .. }
                | DaemonEvent::FsChange { .. }
                | DaemonEvent::SensorWarning { .. }
                | DaemonEvent::ReindexRequested { .. }
                | DaemonEvent::SymbolsIndexed { .. }
                | DaemonEvent::MemoryReviewRequested { .. }
                | DaemonEvent::MemoryReviewApproved { .. }
                | DaemonEvent::GitEvent { .. }
                | DaemonEvent::ShellEvent { .. }
                | DaemonEvent::ReplayResult { .. }
                | DaemonEvent::ChatTokenStream { .. }
                | DaemonEvent::RemediationStarted { .. }
                | DaemonEvent::RemediationProgress { .. }
                | DaemonEvent::GateRunStarted { .. }
                | DaemonEvent::GateProgress { .. }
                | DaemonEvent::GateRunCompleted { .. }
                | DaemonEvent::GateBypassUsed { .. }
                | DaemonEvent::PatternLearned { .. }
                | DaemonEvent::PatternDemoted { .. } => {}
            }
        }
        debug!(target: "memory.procedural", "pattern learner stopped");
    })
}

async fn handle_success(
    daemon:     &Arc<DaemonHandle>,
    store:      &Arc<Store>,
    cache:      &Cache,
    session_id: &str,
    summary:    &str,
) {
    let Some((repo_id, fingerprint)) = lookup_meta(daemon, store, session_id) else {
        return;
    };
    let mutation = with_repo(daemon, store, cache, &repo_id, |file| {
        let (success_count, kind) =
            apply_success(file, &fingerprint, session_id, summary);
        Mutation::Learned { success_count, kind }
    });
    if let Some(Mutation::Learned { success_count, kind }) = mutation {
        daemon.bus.publish(DaemonEvent::PatternLearned {
            repo_id:       repo_id.clone(),
            fingerprint:   fingerprint.clone(),
            kind:          kind.as_wire_str().to_string(),
            success_count,
        });
    }
}

async fn handle_failure(
    daemon:        &Arc<DaemonHandle>,
    store:         &Arc<Store>,
    cache:         &Cache,
    session_id:    &str,
    summary:       &str,
    forced_demote: bool,
) {
    let Some((repo_id, fingerprint)) = lookup_meta(daemon, store, session_id) else {
        return;
    };
    let mutation = with_repo(daemon, store, cache, &repo_id, |file| {
        let outcome = apply_failure(file, &fingerprint, session_id, summary, forced_demote);
        Mutation::Failure(outcome)
    });
    let Some(Mutation::Failure(outcome)) = mutation else {
        return;
    };
    if outcome.demoted {
        daemon.bus.publish(DaemonEvent::PatternDemoted {
            repo_id:       repo_id.clone(),
            fingerprint:   fingerprint.clone(),
            prior_success: outcome.prior_success,
            new_failure:   outcome.new_failure,
            reason:        outcome.reason.to_string(),
        });
    }
}

/// Either the row was a learning signal (we want to publish
/// `PatternLearned`) or a failure outcome (we may want to publish
/// `PatternDemoted` if `outcome.demoted`).
enum Mutation {
    Learned { success_count: u32, kind: PatternKind },
    Failure(FailureOutcome),
}

/// Look up `(repo_id, fingerprint)` from `remediation_sessions` for the
/// given `session_id`. Missing row → emit a `SensorWarning` and return
/// `None` so the caller skips the event.
fn lookup_meta(
    daemon:     &Arc<DaemonHandle>,
    store:      &Arc<Store>,
    session_id: &str,
) -> Option<(String, String)> {
    match queries::get_remediation_session_meta(store, session_id) {
        Ok(Some(meta)) => Some(meta),
        Ok(None) => {
            daemon.bus.publish(DaemonEvent::SensorWarning {
                sensor:  "procedural".to_string(),
                message: format!("session {session_id} missing in store (no fingerprint to learn)"),
            });
            None
        }
        Err(e) => {
            warn!(
                target = "memory.procedural",
                error  = %e,
                session_id,
                "session lookup failed; skipping event"
            );
            None
        }
    }
}

/// Resolve the patterns.json path for `repo_id`, load (or hydrate the
/// cache from disk), apply `mutate`, persist the result, and return
/// the mutation outcome. Errors during load are degraded to a
/// `SensorWarning`; errors during save are logged but the cache stays
/// updated (the next successful save will retry).
fn with_repo(
    daemon:  &Arc<DaemonHandle>,
    store:   &Arc<Store>,
    cache:   &Cache,
    repo_id: &str,
    mutate:  impl FnOnce(&mut PatternsFile) -> Mutation,
) -> Option<Mutation> {
    let repo_path = match queries::find_repo_path_by_id(store, repo_id) {
        Ok(Some(p)) => PathBuf::from(p),
        Ok(None) => {
            daemon.bus.publish(DaemonEvent::SensorWarning {
                sensor:  "procedural".to_string(),
                message: format!("repo {repo_id} unknown to store"),
            });
            return None;
        }
        Err(e) => {
            warn!(target = "memory.procedural", error = %e, "repo lookup failed");
            return None;
        }
    };
    let file_path = patterns_path(&repo_path);
    let mut guard = cache.write().unwrap_or_else(|p| p.into_inner());
    if !guard.contains_key(repo_id) {
        let loaded = match load_patterns(&file_path) {
            Ok(f) => f,
            Err(e) => {
                daemon.bus.publish(DaemonEvent::SensorWarning {
                    sensor:  "procedural".to_string(),
                    message: format!("patterns.json unreadable for {repo_id}: {e}; starting empty"),
                });
                PatternsFile {
                    version:  CURRENT_VERSION,
                    patterns: Vec::new(),
                }
            }
        };
        guard.insert(repo_id.to_string(), loaded);
    }
    let file = guard.get_mut(repo_id).expect("cache entry just inserted");
    let outcome = mutate(file);
    if let Err(e) = save_patterns(&file_path, file) {
        warn!(
            target  = "memory.procedural",
            error   = %e,
            repo_id,
            "patterns.json save failed (cache retained, will retry on next event)"
        );
    }
    Some(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pat(fp: &str, kind: PatternKind, succ: u32, fail: u32) -> Pattern {
        Pattern {
            kind,
            fingerprint:           fp.to_string(),
            suggested_fix_summary: format!("fix for {fp}"),
            success_count:         succ,
            failure_count:         fail,
            evidence:              Vec::new(),
            last_seen_ms:          0,
            created_at_ms:         0,
        }
    }

    #[test]
    fn apply_success_creates_then_increments() {
        let mut f = PatternsFile { version: CURRENT_VERSION, patterns: Vec::new() };
        let (n1, k1) = apply_success(&mut f, "fp1", "s1", "summary");
        assert_eq!(n1, 1);
        assert_eq!(k1, PatternKind::AutoDetected);
        assert_eq!(f.patterns.len(), 1);
        let (n2, _) = apply_success(&mut f, "fp1", "s2", "ignored");
        assert_eq!(n2, 2);
        // First-write summary wins; later successes don't overwrite.
        assert_eq!(f.patterns[0].suggested_fix_summary, "summary");
    }

    #[test]
    fn evidence_capped() {
        let mut f = PatternsFile { version: CURRENT_VERSION, patterns: Vec::new() };
        for i in 0..(MAX_EVIDENCE_PER_PATTERN + 5) {
            apply_success(&mut f, "fp", &format!("s{i}"), "");
        }
        assert_eq!(f.patterns[0].evidence.len(), MAX_EVIDENCE_PER_PATTERN);
        // Oldest dropped — the first surviving entry is s5.
        assert_eq!(f.patterns[0].evidence[0], "s5");
    }

    #[test]
    fn failure_majority_demotes() {
        let mut f = PatternsFile {
            version:  CURRENT_VERSION,
            patterns: vec![pat("fp", PatternKind::AutoDetected, 1, 0)],
        };
        // First failure: counts equal (1=1) → no demote yet.
        let o = apply_failure(&mut f, "fp", "s", "", false);
        assert!(!o.demoted);
        assert_eq!(f.patterns[0].kind, PatternKind::AutoDetected);
        // Second failure: 1 < 2 → demote.
        let o = apply_failure(&mut f, "fp", "s", "", false);
        assert!(o.demoted);
        assert_eq!(o.reason, "failure_majority");
        assert_eq!(f.patterns[0].kind, PatternKind::AntiPattern);
    }

    #[test]
    fn forced_demote_overrides_count_majority() {
        let mut f = PatternsFile {
            version:  CURRENT_VERSION,
            patterns: vec![pat("fp", PatternKind::AutoDetected, 5, 0)],
        };
        let o = apply_failure(&mut f, "fp", "s", "", true);
        assert!(o.demoted);
        assert_eq!(o.reason, "regression_forced");
        assert_eq!(f.patterns[0].kind, PatternKind::AntiPattern);
    }

    #[test]
    fn anti_pattern_extra_success_does_not_revert() {
        let mut f = PatternsFile {
            version:  CURRENT_VERSION,
            patterns: vec![pat("fp", PatternKind::AntiPattern, 1, 5)],
        };
        let (_, kind) = apply_success(&mut f, "fp", "s", "");
        assert_eq!(kind, PatternKind::AntiPattern);
        assert_eq!(f.patterns[0].kind, PatternKind::AntiPattern);
    }

    #[test]
    fn prune_keeps_anti_patterns() {
        // Build 600 patterns: 100 anti-patterns (low score), 500
        // auto-detected with varying scores. Cap is 500 → expect 50
        // auto-detected dropped; all 100 anti-patterns retained.
        let mut patterns = Vec::with_capacity(600);
        for i in 0..100 {
            patterns.push(pat(&format!("anti_{i}"), PatternKind::AntiPattern, 0, 99));
        }
        for i in 0..500 {
            // Spread scores so the low ones are deterministic to find.
            patterns.push(pat(&format!("auto_{i}"), PatternKind::AutoDetected, i as u32, 0));
        }
        let mut f = PatternsFile { version: CURRENT_VERSION, patterns };
        prune_if_needed(&mut f);
        assert_eq!(f.patterns.len(), 600 - PRUNE_BATCH);
        let anti_kept = f.patterns.iter().filter(|p| matches!(p.kind, PatternKind::AntiPattern)).count();
        assert_eq!(anti_kept, 100, "anti-patterns must survive pruning");
        // The lowest-scoring auto-detected (auto_0..auto_49) should be gone.
        for i in 0..PRUNE_BATCH {
            let fp = format!("auto_{i}");
            assert!(
                !f.patterns.iter().any(|p| p.fingerprint == fp),
                "expected lowest-score auto pattern {fp} to be pruned"
            );
        }
    }

    #[test]
    fn save_load_roundtrip_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("patterns.json");
        let file = PatternsFile {
            version:  CURRENT_VERSION,
            patterns: vec![
                pat("fp_a", PatternKind::AutoDetected, 3, 1),
                pat("fp_b", PatternKind::AntiPattern, 0, 5),
            ],
        };
        save_patterns(&path, &file).unwrap();
        let body1 = std::fs::read(&path).unwrap();
        let reloaded = load_patterns(&path).unwrap();
        save_patterns(&path, &reloaded).unwrap();
        let body2 = std::fs::read(&path).unwrap();
        assert_eq!(body1, body2, "save → load → save must be byte-identical");
        // Sanity: exact JSON shape (kebab-case kind, struct field order).
        let s = std::str::from_utf8(&body1).unwrap();
        assert!(s.contains("\"kind\": \"auto-detected\""));
        assert!(s.contains("\"kind\": \"anti-pattern\""));
        // version key first, then patterns.
        let v_pos = s.find("\"version\":").unwrap();
        let p_pos = s.find("\"patterns\":").unwrap();
        assert!(v_pos < p_pos);
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.json");
        let f = load_patterns(&path).unwrap();
        assert_eq!(f.version, CURRENT_VERSION);
        assert!(f.patterns.is_empty());
    }

    #[test]
    fn load_future_version_is_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.json");
        std::fs::write(&path, br#"{"version": 99, "patterns": []}"#).unwrap();
        let err = load_patterns(&path).unwrap_err();
        match err {
            MemoryError::Parse(s) => assert!(s.contains("99")),
            e => panic!("expected Parse, got {e:?}"),
        }
    }

    #[test]
    fn load_corrupt_file_is_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.json");
        std::fs::write(&path, b"not json at all{").unwrap();
        let err = load_patterns(&path).unwrap_err();
        assert!(matches!(err, MemoryError::Parse(_)));
    }
}
