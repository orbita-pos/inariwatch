//! Pre-push gate evaluation (subset of the 17 web gates).
//!
//! Session 8 lands the *plumbing* for the local-runnable subset — gates
//! 1, 4, 5, 6, 9 per `INARI_LIVE_HANDOFF.md` § "Session 20 — Pre-push
//! gate visual surface" — but only gates 1 and 4 are wired with real
//! logic today. Gates 5/6/9 return a `deferred` verdict that marks them
//! as advisory until Session 20 attaches:
//!
//! * Gate 5 — self-review (≥ 70 confidence, AI call)
//! * Gate 6 — substrate_simulate (risk ≤ 40, calls local Substrate
//!   replay if available)
//! * Gate 9 — security_scan (zero HIGH findings, calls local
//!   19-regex scan)
//!
//! The verdict shape is JSON so the eventual pre-push UI (Session 20)
//! can render a per-gate timeline without a second round-trip.

use serde::{Deserialize, Serialize};

use crate::store::{settings, Store};

/// Verdict for a single gate. `passed = false` blocks the push;
/// `passed = true && deferred = true` means the gate is advisory only
/// (Session 8 scaffold; Session 20 fills in the implementation).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GateVerdict {
    pub name:     String,
    pub passed:   bool,
    pub deferred: bool,
    pub reason:   Option<String>,
}

impl GateVerdict {
    pub fn pass(name: &str) -> Self {
        Self { name: name.to_string(), passed: true, deferred: false, reason: None }
    }
    pub fn fail(name: &str, reason: impl Into<String>) -> Self {
        Self { name: name.to_string(), passed: false, deferred: false, reason: Some(reason.into()) }
    }
    pub fn deferred(name: &str, reason: impl Into<String>) -> Self {
        Self { name: name.to_string(), passed: true, deferred: true, reason: Some(reason.into()) }
    }
}

/// Aggregate decision returned to the caller (and to the pre-push hook
/// shell script). `allow = false` translates to `exit 1` in the hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateDecision {
    pub allow:    bool,
    pub reason:   Option<String>,
    pub verdicts: Vec<GateVerdict>,
}

/// Inputs the pre-push gate needs. The hook shell script builds this
/// from `git rev-list` / `git diff --shortstat` and the request body.
#[derive(Debug, Clone)]
pub struct GateInput<'a> {
    pub repo_id:   &'a str,
    pub diff_size: usize,
}

/// Default cap from spec recap & Session 20 ("Gate 4 — lines changed
/// ≤ max"). Configurable via `settings.max_lines_changed`.
pub const DEFAULT_MAX_LINES_CHANGED: usize = 500;

pub fn evaluate(store: &Store, input: GateInput<'_>) -> GateDecision {
    let mut verdicts = Vec::with_capacity(5);

    // ── Gate 1: auto_merge_enabled ────────────────────────────────
    let auto_merge_enabled = settings::get(store, "gates.auto_merge_enabled")
        .ok()
        .flatten()
        .map(|v| v == "true" || v == "1" || v == "yes")
        .unwrap_or(true);
    if auto_merge_enabled {
        verdicts.push(GateVerdict::pass("auto_merge_enabled"));
    } else {
        verdicts.push(GateVerdict::fail(
            "auto_merge_enabled",
            "Auto-merge is disabled in Settings (Gate 1).",
        ));
    }

    // ── Gate 4: lines_changed ≤ max ───────────────────────────────
    let max = settings::get(store, "gates.max_lines_changed")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_LINES_CHANGED);
    if input.diff_size <= max {
        verdicts.push(GateVerdict::pass("lines_changed"));
    } else {
        verdicts.push(GateVerdict::fail(
            "lines_changed",
            format!(
                "diff is {} lines; cap is {} (Gate 4). Set INARI_BYPASS=1 to override.",
                input.diff_size, max
            ),
        ));
    }

    // ── Gate 5: self_review (deferred to Session 20) ──────────────
    verdicts.push(GateVerdict::deferred(
        "self_review",
        "deferred to Session 20",
    ));

    // ── Gate 6: substrate_simulate (deferred) ─────────────────────
    verdicts.push(GateVerdict::deferred(
        "substrate_simulate",
        "deferred to Session 20",
    ));

    // ── Gate 9: security_scan (deferred) ──────────────────────────
    verdicts.push(GateVerdict::deferred(
        "security_scan",
        "deferred to Session 20",
    ));

    let blocking: Vec<&GateVerdict> = verdicts
        .iter()
        .filter(|v| !v.passed && !v.deferred)
        .collect();

    if blocking.is_empty() {
        GateDecision {
            allow:    true,
            reason:   None,
            verdicts,
        }
    } else {
        let reason = blocking
            .iter()
            .filter_map(|v| v.reason.clone())
            .collect::<Vec<_>>()
            .join("; ");
        GateDecision {
            allow:    false,
            reason:   Some(reason),
            verdicts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_store() -> (Arc<Store>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
        (store, dir)
    }

    #[test]
    fn small_diff_with_default_settings_passes() {
        let (store, _dir) = make_store();
        let dec = evaluate(&store, GateInput { repo_id: "r1", diff_size: 10 });
        assert!(dec.allow, "expected allow but got {dec:?}");
        // Gates 1 + 4 PASS, gates 5/6/9 deferred → 5 verdicts.
        assert_eq!(dec.verdicts.len(), 5);
        let blocking: usize = dec.verdicts.iter()
            .filter(|v| !v.passed && !v.deferred)
            .count();
        assert_eq!(blocking, 0);
    }

    #[test]
    fn oversize_diff_fails_gate_4() {
        let (store, _dir) = make_store();
        let dec = evaluate(&store, GateInput { repo_id: "r1", diff_size: 10_000 });
        assert!(!dec.allow);
        assert!(dec.reason.as_deref().unwrap_or("").contains("Gate 4"));
    }

    #[test]
    fn auto_merge_disabled_fails_gate_1() {
        let (store, _dir) = make_store();
        settings::set(&store, "gates.auto_merge_enabled", "false").unwrap();
        let dec = evaluate(&store, GateInput { repo_id: "r1", diff_size: 1 });
        assert!(!dec.allow);
        assert!(dec.reason.as_deref().unwrap_or("").contains("Gate 1"));
    }
}
