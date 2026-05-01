//! Per-gate evaluators for the local subset (Sesión 20).
//!
//! Each `eval_gate_*` function returns a [`crate::sensors::git::gate::GateVerdict`]
//! so the runner can stitch them into the existing
//! [`crate::sensors::git::gate::GateDecision`] shape that the hook
//! handler already returns to the shell script.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;

use crate::ai::budget::Model;
use crate::ai::openai::OpenAIClient;
use crate::ai::prompts::{ChatMessage, Role};
use crate::sensors::git::gate::GateVerdict;
use crate::sensors::substrate::{
    self, replay_client::ReplayBackend, RECENT_WINDOW,
};
use crate::store::{queries, Store};

/// Severity label for a security pattern match. Mirrors the
/// `SecurityFinding["severity"]` enum from the web SSOT
/// (`web/lib/ai/security-scan.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    High,
    Medium,
    Low,
}

/// Static metadata for one Semgrep-inspired regex pattern. The actual
/// compiled regex lives in [`compiled_patterns`] (lazy + eager
/// compilation behind a single `Lazy<Vec<...>>`); putting the regex
/// inline here would force a generic over the closure type.
struct PatternMeta {
    rule:     &'static str,
    severity: Severity,
    message:  &'static str,
    re:       &'static str,
}

/// All 19 patterns, ported byte-close from `web/lib/ai/security-scan.ts`.
/// Two notes for parity:
///  * JS `/.../i` ⇒ Rust `(?i)` prefix on the regex string.
///  * JS `/.../` (no `g`) is line-by-line in the runner; we feed each
///    line into `is_match` so the semantics match the web's
///    `dp.pattern.test(lines[i])` loop.
const PATTERN_META: &[PatternMeta] = &[
    PatternMeta {
        rule: "security/no-eval", severity: Severity::High,
        re: r"eval\s*\(",
        message: "Use of eval() — potential code injection",
    },
    PatternMeta {
        rule: "security/detect-child-process", severity: Severity::High,
        re: r"child_process",
        message: "Use of child_process — potential command injection",
    },
    PatternMeta {
        rule: "security/detect-shell-injection", severity: Severity::High,
        re: r"\.exec\s*\(.*\$\{",
        message: "Template literal in exec() — potential shell injection",
    },
    PatternMeta {
        rule: "security/no-inner-html", severity: Severity::High,
        re: r"innerHTML\s*=",
        message: "Direct innerHTML assignment — potential XSS",
    },
    PatternMeta {
        rule: "security/react-dangerously-set", severity: Severity::Medium,
        re: r"dangerouslySetInnerHTML",
        message: "dangerouslySetInnerHTML — verify input is sanitized",
    },
    PatternMeta {
        rule: "security/detect-non-literal-regexp", severity: Severity::Medium,
        re: r"new RegExp\s*\(.*\+",
        message: "Dynamic RegExp — potential ReDoS",
    },
    PatternMeta {
        rule: "security/detect-sql-injection", severity: Severity::High,
        re: r"(?i)SELECT.*\+.*FROM|INSERT.*\+.*INTO|DELETE.*\+.*FROM",
        message: "String concatenation in SQL — potential SQL injection",
    },
    PatternMeta {
        rule: "security/detect-path-traversal", severity: Severity::Medium,
        re: r"readFileSync\s*\(.*\+|readFile\s*\(.*\+",
        message: "Dynamic file path — potential path traversal",
    },
    PatternMeta {
        rule: "security/non-global-replace", severity: Severity::Low,
        re: r"\.replace\s*\(\s*/.*/[^g]",
        message: "Non-global replace — may only replace first occurrence",
    },
    PatternMeta {
        rule: "security/env-secret-usage", severity: Severity::Medium,
        re: r"(?i)process\.env\.\w+.*password|process\.env\.\w+.*secret",
        message: "Environment variable with sensitive name — ensure not logged",
    },
    PatternMeta {
        rule: "security/buffer-encoding", severity: Severity::Low,
        re: r"Buffer\.from\s*\([^,]+\)\s*\.toString\s*\(\s*\)",
        message: "Buffer.from without encoding — defaults to utf8",
    },
    PatternMeta {
        rule: "security/detect-ssrf", severity: Severity::High,
        // JS source: `/fetch\s*\(\s*[^"'`\s]/`.
        re: r#"fetch\s*\(\s*[^"'`\s]"#,
        message: "Dynamic URL in fetch() — potential SSRF",
    },
    PatternMeta {
        rule: "security/hardcoded-secret", severity: Severity::High,
        re: r#"(?i)(password|secret|apikey|api_key|token)\s*[:=]\s*["'][^"']{8,}"#,
        message: "Hardcoded secret or credential — use environment variables",
    },
    PatternMeta {
        rule: "security/prototype-pollution", severity: Severity::High,
        re: r"__proto__",
        message: "__proto__ access — potential prototype pollution",
    },
    PatternMeta {
        rule: "security/prototype-pollution-constructor", severity: Severity::High,
        re: r"constructor\s*\[",
        message: "Dynamic constructor access — potential prototype pollution",
    },
    PatternMeta {
        rule: "security/insecure-hash", severity: Severity::Medium,
        re: r#"createHash\s*\(\s*['"](?:md5|sha1)['"]"#,
        message: "Insecure hash algorithm (md5/sha1) — use sha256 or stronger",
    },
    PatternMeta {
        rule: "security/open-redirect", severity: Severity::High,
        re: r"res\.redirect\s*\(\s*req\.(query|params|body)",
        message: "Redirect using user input — potential open redirect",
    },
    PatternMeta {
        rule: "security/cors-wildcard", severity: Severity::Medium,
        re: r"Access-Control-Allow-Origin.*\*",
        message: "CORS wildcard origin — consider restricting to specific domains",
    },
    PatternMeta {
        rule: "security/unvalidated-redirect", severity: Severity::Medium,
        re: r#"window\.location\s*=\s*[^"'`]"#,
        message: "Client-side redirect with dynamic value — validate URL first",
    },
];

struct CompiledPattern {
    rule:     &'static str,
    severity: Severity,
    message:  &'static str,
    regex:    Regex,
}

static COMPILED: Lazy<Vec<CompiledPattern>> = Lazy::new(|| {
    PATTERN_META.iter().map(|m| CompiledPattern {
        rule:     m.rule,
        severity: m.severity,
        message:  m.message,
        regex:    Regex::new(m.re).unwrap_or_else(|e| {
            panic!("hand-checked security pattern failed to compile: rule={} re={} err={}", m.rule, m.re, e)
        }),
    }).collect()
});

/// Number of patterns the gate evaluates. Public so tests can assert
/// the cardinality without touching `PATTERN_META` directly.
pub const PATTERN_COUNT: usize = 19;

/// One match the security scan surfaces. Reported per-line so the
/// runner can stitch a useful reason ("HIGH: <rule> at line ~42").
#[derive(Debug, Clone)]
pub struct ScanFinding {
    pub rule:     &'static str,
    pub severity: Severity,
    pub message:  &'static str,
    pub line:     usize,
}

/// Scan a diff body (or any source blob) line by line. Mirrors the
/// web pattern loop: each line is tested against every pattern, the
/// first match per (line, rule) is recorded.
pub fn run_security_scan(body: &str) -> Vec<ScanFinding> {
    let mut out: Vec<ScanFinding> = Vec::new();
    for (idx, line) in body.lines().enumerate() {
        for pat in COMPILED.iter() {
            if pat.regex.is_match(line) {
                out.push(ScanFinding {
                    rule:     pat.rule,
                    severity: pat.severity,
                    message:  pat.message,
                    line:     idx + 1,
                });
            }
        }
    }
    out
}

// ── Gate 5 — self_review (AI confidence) ─────────────────────────────

/// Gate 5 evaluator. Asks the AI to score the diff for correctness on
/// a 0-100 confidence scale; passes when ≥ 70.
///
/// Failure modes (all surface as `GateVerdict::fail`):
///   * AI call errored — surface "AI call failed" as a soft fail so
///     the user can retry or bypass; we'd rather block than silently
///     allow a push when self-review couldn't run.
///   * Response unparseable — same posture (don't trust an answer
///     we can't read).
///   * Score < 70 — actual no-confidence verdict.
pub async fn eval_gate_5_self_review(
    client: &OpenAIClient,
    diff:   &str,
    commit_msg: &str,
) -> GateVerdict {
    let system = ChatMessage {
        role:    Role::System,
        content: SELF_REVIEW_SYSTEM.to_string(),
    };
    let user_body = format!(
        "Commit message:\n{commit_msg}\n\n--- diff ---\n{diff}\n--- end ---\n\nReturn EXACTLY:\nSCORE: <0-100>\nREASON: <one short sentence>"
    );
    let user = ChatMessage::user(user_body);
    let messages = vec![system, user];

    match client.chat_complete(&messages, Model::Gpt54).await {
        Ok(resp) => match parse_score_reason(&resp.content) {
            Some((score, reason)) => {
                if score >= 70 {
                    GateVerdict::pass("self_review")
                } else {
                    GateVerdict::fail(
                        "self_review",
                        format!("AI confidence {score}/100 (need ≥70): {reason}"),
                    )
                }
            }
            None => GateVerdict::fail(
                "self_review",
                "AI response unparseable (no SCORE: line)".to_string(),
            ),
        },
        Err(e) => GateVerdict::fail(
            "self_review",
            format!("AI call failed: {e}"),
        ),
    }
}

const SELF_REVIEW_SYSTEM: &str = "You are a senior code reviewer. Score the diff's correctness on a 0-100 scale (100 = ship-it, 70 = probably fine, 40 = risky, 0 = obviously broken). Return EXACTLY two lines:\nSCORE: <integer 0-100>\nREASON: <one short sentence>\nNo other text.";

/// Parse the SCORE/REASON pair out of the AI response. Tolerant of
/// surrounding whitespace + markdown fences but strict about the
/// label: if "SCORE:" is missing the verdict is unparseable.
pub fn parse_score_reason(content: &str) -> Option<(u32, String)> {
    let mut score: Option<u32> = None;
    let mut reason = String::new();
    for line in content.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("SCORE:").or_else(|| t.strip_prefix("Score:")) {
            // Pull the first integer-looking token — tolerates "SCORE: 85/100" / "85" / "85."
            let digits: String = rest.chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = digits.parse::<u32>() {
                score = Some(n.min(100));
            }
        } else if let Some(rest) = t.strip_prefix("REASON:").or_else(|| t.strip_prefix("Reason:")) {
            reason = rest.trim().to_string();
        }
    }
    score.map(|s| (s, if reason.is_empty() { "(no reason)".to_string() } else { reason }))
}

// ── Gate 6 — substrate_simulate ──────────────────────────────────────

/// Gate 6 evaluator. Looks for a substrate recording within the
/// configured "recent" window for the repo and asks the configured
/// backend whether the diff preserves recorded behaviour.
///
/// **Default-allow when no recent recording exists.** Substrate is
/// opt-in per repo (migration 0004 default OFF), and even on
/// repos with the toggle on the recording is only fresh for 60s
/// after a `inari run` invocation. Failing closed would block every
/// push from a user who hasn't actively been recording — bad UX.
/// We surface the "no recording" verdict as `deferred` so the dock
/// can show "no replay signal — push allowed" without scaring the
/// user with a red gate. Real failures (replay HIGH severity) are
/// `fail`.
pub async fn eval_gate_6_substrate_simulate(
    store:       &Arc<Store>,
    backend:     Option<&dyn ReplayBackend>,
    repo_id:     &str,
) -> GateVerdict {
    // Repo not registered → deferred (gate doesn't apply).
    let repo_path = match queries::find_repo_path_by_id(store, repo_id) {
        Ok(Some(p)) => PathBuf::from(p),
        Ok(None)    => return GateVerdict::deferred(
            "substrate_simulate",
            "repo not registered locally",
        ),
        Err(e) => return GateVerdict::deferred(
            "substrate_simulate",
            format!("store error: {e}"),
        ),
    };

    let recordings_root = repo_path.join(".inari").join("recordings");
    let Some(recording_dir) = latest_recent_recording(&recordings_root, RECENT_WINDOW) else {
        return GateVerdict::deferred(
            "substrate_simulate",
            "no recent recording (substrate is opt-in)",
        );
    };

    let Some(backend) = backend else {
        return GateVerdict::deferred(
            "substrate_simulate",
            "no replay backend configured",
        );
    };

    // The actor uses the modified file as the overlay; the gate
    // doesn't have a single file to point at (the diff may touch many).
    // Pass the recording dir itself — backends treat this advisory
    // for path-traversal defense and re-read from the recording's
    // tree internally.
    let overlay = recording_dir.clone();
    let backend_name = backend.name();

    // The backend's `replay()` is a sync + blocking call (subprocess
    // or HTTP — both wrapped in 30s timeouts). The runner is already
    // inside `tokio::join!`, so calling synchronously here is safe:
    // the join's other branches (Gates 5 + 9) keep advancing on
    // their own tasks. The 30s ceiling means even worst-case this
    // gate doesn't block longer than the overall runner deadline.
    match backend.replay(&recording_dir, &overlay) {
        Ok(outcome) => {
            if outcome.matched {
                GateVerdict::pass("substrate_simulate")
            } else {
                let summary = outcome.divergence
                    .map(|d| format!("{:?} in {} (severity {:?})",
                        d.kind, d.affected_module, d.severity))
                    .unwrap_or_else(|| "unspecified divergence".into());
                GateVerdict::fail(
                    "substrate_simulate",
                    format!("replay diverged ({backend_name}): {summary}"),
                )
            }
        }
        Err(e) => {
            // Backend errored — same default-allow posture as "no
            // recording": substrate is opt-in, surface as deferred so
            // we don't block the user on a transient binary failure.
            tracing::warn!(error = %e, backend = backend_name, "substrate gate skipped");
            GateVerdict::deferred(
                "substrate_simulate",
                format!("backend {backend_name} unavailable: {e}"),
            )
        }
    }
}

/// Pick the newest recording dir (mtime) within the window. Returns
/// `None` when the recordings root doesn't exist OR every dir is older.
pub fn latest_recent_recording(root: &std::path::Path, window: Duration) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    let now = std::time::SystemTime::now();
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(m)  => m,
            Err(_) => continue,
        };
        let age = now.duration_since(mtime).unwrap_or(Duration::from_secs(0));
        if age > window { continue; }
        match &best {
            None => best = Some((mtime, path)),
            Some((bt, _)) if mtime > *bt => best = Some((mtime, path)),
            _ => {}
        }
    }
    best.map(|(_, p)| p)
}

// ── Gate 9 — security_scan ───────────────────────────────────────────

/// Gate 9 evaluator. Runs the 19-regex Semgrep-inspired scan against
/// the diff body. Any HIGH match fails the gate. MEDIUM/LOW matches
/// are logged but don't fail (matches the web's `passed = highCount === 0`).
///
/// **Note on coverage:** the web `web/lib/ai/security-scan.ts` runs
/// THREE layers (eslint-plugin-security 17 rules + 19 regex + AI
/// review). This gate ports only the 19 regex layer because:
///   * eslint-plugin-security needs a Node runtime (no portable Rust
///     equivalent today) — would require shelling out to a bundled
///     Node binary, which doubles the install footprint and breaks
///     air-gapped users.
///   * The AI review layer would double the per-push AI cost (Gate 5
///     already runs one AI call); we'd rather invest that latency in
///     a higher-quality Gate 5 prompt than a redundant pass.
/// See `INARI_LIVE_DECISIONS.md` 2026-05-01 entry for the full
/// rationale.
pub async fn eval_gate_9_security_scan(diff: &str) -> GateVerdict {
    let findings = run_security_scan(diff);
    let high: Vec<&ScanFinding> = findings.iter()
        .filter(|f| f.severity == Severity::High)
        .collect();
    if high.is_empty() {
        GateVerdict::pass("security_scan")
    } else {
        let first = high[0];
        let extra = if high.len() > 1 { format!(" (+{} more)", high.len() - 1) } else { String::new() };
        GateVerdict::fail(
            "security_scan",
            format!(
                "HIGH: {} (line ~{}): {}{}",
                first.rule, first.line, first.message, extra,
            ),
        )
    }
}

// Sub-spawn helper kept private to the module — the runner doesn't
// need to import substrate's actor surface itself.
#[allow(dead_code)]
fn _ensure_substrate_in_scope() {
    let _ = substrate::SUBSTRATE_SENSOR_NAME;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// All 19 patterns must compile. Catches any future drift in the
    /// regex bodies before the runner touches them.
    #[test]
    fn all_patterns_compile() {
        Lazy::force(&COMPILED);
        assert_eq!(COMPILED.len(), PATTERN_COUNT);
    }

    #[test]
    fn parse_score_reason_handles_canonical_format() {
        let (score, reason) = parse_score_reason(
            "SCORE: 85\nREASON: clean refactor"
        ).unwrap();
        assert_eq!(score, 85);
        assert_eq!(reason, "clean refactor");
    }

    #[test]
    fn parse_score_reason_handles_lowercase_and_extra_punct() {
        let (score, reason) = parse_score_reason(
            "Score: 42/100\nReason: risky change.\n"
        ).unwrap();
        assert_eq!(score, 42);
        assert_eq!(reason, "risky change.");
    }

    #[test]
    fn parse_score_reason_returns_none_when_score_missing() {
        assert!(parse_score_reason("REASON: missing label").is_none());
    }

    #[test]
    fn run_security_scan_finds_eval() {
        let diff = "+ eval(userInput)";
        let finds = run_security_scan(diff);
        assert!(finds.iter().any(|f| f.rule == "security/no-eval" && f.severity == Severity::High));
    }

    #[test]
    fn run_security_scan_clean_diff_yields_nothing() {
        let diff = "+ const x = 1;\n+ const y = x + 2;\n";
        let finds = run_security_scan(diff);
        assert!(finds.is_empty(), "expected no findings, got {finds:?}");
    }
}
