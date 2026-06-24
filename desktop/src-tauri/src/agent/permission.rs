//! Permission decision pipeline for tool invocations.
//!
//! Three levels — `Auto`, `Confirm`, `Deny` — and a thread-safe
//! resolver that lets the user override per-tool from settings while
//! the agent is running. The registry's `invoke()` calls
//! [`PermissionResolver::decide`] before reaching the tool's
//! `execute()`; `RequiresConfirm` short-circuits invoke and surfaces
//! to the chat surface (S6+) so the UI can prompt and re-invoke via
//! `invoke_confirmed()` once the user approves.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

/// How a tool gets permission to run. Per-tool default lives in
/// [`super::ToolMeta::default_permission`]; user can override per tool
/// in settings (handled by [`PermissionResolver`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionLevel {
    /// Run without prompting. Safe reads, queries, idempotent ops.
    Auto,
    /// Block on user approval before invoke. Writes, sends, exec.
    Confirm,
    /// Reject every invoke. Used to disable a tool entirely.
    Deny,
}

impl PermissionLevel {
    /// String form persisted in the audit log + settings rows. Matches
    /// the lowercase `serde(rename_all)` variant used on the wire.
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionLevel::Auto => "auto",
            PermissionLevel::Confirm => "confirm",
            PermissionLevel::Deny => "deny",
        }
    }

    /// Inverse of [`Self::as_str`]. Returns `None` for unknown strings
    /// so the audit-log reader can degrade gracefully on a row written
    /// by a future schema change. Named `parse_str` (not `from_str`)
    /// to avoid colliding with the conventional [`std::str::FromStr`]
    /// trait shape — we return `Option`, the trait wants `Result`.
    pub fn parse_str(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "confirm" => Some(Self::Confirm),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

/// What the resolver returns. The registry uses `Allow` to proceed
/// directly, `RequiresConfirm` to suspend invoke until the UI raises
/// the prompt and the user approves, `Denied` to reject with
/// [`super::ToolError::PermissionDenied`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    RequiresConfirm,
    Denied,
}

impl PermissionDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionDecision::Allow => "allow",
            PermissionDecision::RequiresConfirm => "requires_confirm",
            PermissionDecision::Denied => "denied",
        }
    }

    pub fn parse_str(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "requires_confirm" => Some(Self::RequiresConfirm),
            "denied" => Some(Self::Denied),
            _ => None,
        }
    }
}

/// Resolves the effective permission for a tool given user overrides.
/// Thread-safe — overrides come from the settings UI which can mutate
/// while the agent is mid-invoke.
#[derive(Debug, Default)]
pub struct PermissionResolver {
    /// Per-tool overrides keyed by `ToolMeta.name`. Absent = use the
    /// tool's `default_permission`.
    overrides: RwLock<HashMap<String, PermissionLevel>>,
}

impl PermissionResolver {
    pub fn new() -> Self {
        Self {
            overrides: RwLock::new(HashMap::new()),
        }
    }

    /// Compute the decision for invoking `tool_name` whose default is
    /// `default`. Cheap (one read lock + lookup).
    pub fn decide(&self, tool_name: &str, default: PermissionLevel) -> PermissionDecision {
        let effective = self
            .overrides
            .read()
            .ok()
            .and_then(|m| m.get(tool_name).copied())
            .unwrap_or(default);
        match effective {
            PermissionLevel::Auto => PermissionDecision::Allow,
            PermissionLevel::Confirm => PermissionDecision::RequiresConfirm,
            PermissionLevel::Deny => PermissionDecision::Denied,
        }
    }

    /// Effective level for `tool_name` (override-aware). Useful for
    /// the audit log so we record what the resolver actually saw.
    pub fn effective_level(&self, tool_name: &str, default: PermissionLevel) -> PermissionLevel {
        self.overrides
            .read()
            .ok()
            .and_then(|m| m.get(tool_name).copied())
            .unwrap_or(default)
    }

    pub fn set_override(&self, tool_name: impl Into<String>, level: PermissionLevel) {
        if let Ok(mut m) = self.overrides.write() {
            m.insert(tool_name.into(), level);
        }
    }

    pub fn clear_override(&self, tool_name: &str) {
        if let Ok(mut m) = self.overrides.write() {
            m.remove(tool_name);
        }
    }

    /// Snapshot of the current override map. Diagnostic / settings UI.
    pub fn snapshot(&self) -> HashMap<String, PermissionLevel> {
        self.overrides
            .read()
            .map(|m| m.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn decide_returns_allow_for_auto_default() {
        let r = PermissionResolver::new();
        assert_eq!(
            r.decide("desktop.read_file", PermissionLevel::Auto),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn decide_returns_requires_confirm_for_confirm_default() {
        let r = PermissionResolver::new();
        assert_eq!(
            r.decide("local.run_shell", PermissionLevel::Confirm),
            PermissionDecision::RequiresConfirm
        );
    }

    #[test]
    fn decide_returns_denied_for_deny_default() {
        let r = PermissionResolver::new();
        assert_eq!(
            r.decide("comm.dangerous", PermissionLevel::Deny),
            PermissionDecision::Denied
        );
    }

    #[test]
    fn override_wins_over_default() {
        let r = PermissionResolver::new();
        // Default is Auto, override forces Confirm.
        r.set_override("desktop.read_file", PermissionLevel::Confirm);
        assert_eq!(
            r.decide("desktop.read_file", PermissionLevel::Auto),
            PermissionDecision::RequiresConfirm
        );
        // Default is Confirm, override loosens to Auto.
        r.set_override("local.run_shell", PermissionLevel::Auto);
        assert_eq!(
            r.decide("local.run_shell", PermissionLevel::Confirm),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn clearing_override_falls_back_to_default() {
        let r = PermissionResolver::new();
        r.set_override("desktop.read_file", PermissionLevel::Deny);
        assert_eq!(
            r.decide("desktop.read_file", PermissionLevel::Auto),
            PermissionDecision::Denied
        );
        r.clear_override("desktop.read_file");
        assert_eq!(
            r.decide("desktop.read_file", PermissionLevel::Auto),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn effective_level_reports_override_when_present() {
        let r = PermissionResolver::new();
        assert_eq!(
            r.effective_level("t", PermissionLevel::Auto),
            PermissionLevel::Auto
        );
        r.set_override("t", PermissionLevel::Deny);
        assert_eq!(
            r.effective_level("t", PermissionLevel::Auto),
            PermissionLevel::Deny
        );
    }

    #[test]
    fn level_string_round_trip() {
        for level in [
            PermissionLevel::Auto,
            PermissionLevel::Confirm,
            PermissionLevel::Deny,
        ] {
            assert_eq!(PermissionLevel::parse_str(level.as_str()), Some(level));
        }
        assert!(PermissionLevel::parse_str("garbage").is_none());
    }

    #[test]
    fn decision_string_round_trip() {
        for decision in [
            PermissionDecision::Allow,
            PermissionDecision::RequiresConfirm,
            PermissionDecision::Denied,
        ] {
            assert_eq!(
                PermissionDecision::parse_str(decision.as_str()),
                Some(decision)
            );
        }
        assert!(PermissionDecision::parse_str("garbage").is_none());
    }

    #[test]
    fn concurrent_reads_and_writes_do_not_deadlock() {
        let r = Arc::new(PermissionResolver::new());
        let mut handles = Vec::new();

        for i in 0..8 {
            let r = r.clone();
            handles.push(thread::spawn(move || {
                for n in 0..200 {
                    let key = format!("tool_{}", (i + n) % 4);
                    if n % 5 == 0 {
                        r.set_override(&key, PermissionLevel::Confirm);
                    } else if n % 7 == 0 {
                        r.clear_override(&key);
                    } else {
                        let _ = r.decide(&key, PermissionLevel::Auto);
                    }
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
    }
}
