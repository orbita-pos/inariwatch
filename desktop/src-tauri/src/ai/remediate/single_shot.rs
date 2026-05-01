//! Single-shot local remediation pipeline (Sesión 19).
//!
//! Runs ENTIRELY on the dock — no cloud calls, no agentic loop. Suited
//! for trivial bugs in repos that aren't connected to a workspace
//! (those go through `proxy::run_cloud_agentic` instead, see
//! `orchestrator`).
//!
//! Pipeline:
//!   1. Embed the error message + first stack frame as the query for
//!      semantic search → top 5 symbols from the local indexer.
//!   2. Read the first ~6 KB of each hit's file from disk (skipping
//!      binaries) → context bag.
//!   3. Pull recent shell events (last hour) for "what was happening
//!      around the error?".
//!   4. Build the single-shot prompt + chat_complete with gpt-5.4.
//!   5. Parse the unified diff out of a fenced ```diff block.
//!   6. Return [`RemediationDraft`] for the orchestrator to persist /
//!      hand to the UI.
//!
//! NO file is written by this module. The orchestrator's
//! [`super::apply_diff`] is the only thing that touches disk; this
//! module is read-only.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ai::budget::Model;
use crate::ai::openai::OpenAIClient;
use crate::ai::prompts::{
    build_single_shot_remediation_prompt, AlertContext, ContextFile, RecentEvent,
};
use crate::daemon::DaemonEvent;
use crate::memory::semantic;
use crate::store::{queries, Store};

/// Per-file byte cap when embedding sources into the prompt. 6 KB is
/// the documented single-shot budget; the prompt builder doesn't
/// re-truncate so this is the discipline.
const MAX_FILE_BYTES: usize = 6 * 1024;

/// How many semantic-search hits to consider. The prompt only embeds
/// 5; we keep this in lockstep so the path is predictable.
const TOP_K: usize = 5;

/// How many recent events to surface. Should mirror the prompt cap so
/// the gather + embed phases stay in sync.
const RECENT_EVENTS_LIMIT: usize = 10;

/// Lookback window for the episodic gather (1 hour).
const RECENT_EVENTS_LOOKBACK_MS: i64 = 60 * 60 * 1000;

/// Inputs to [`run_single_shot`]. The IPC + orchestrator layers build
/// this from the dock's "Fix it" action.
#[derive(Debug, Clone, Deserialize)]
pub struct SingleShotInput {
    pub repo_id:           String,
    pub repo_path:         PathBuf,
    pub error_message:     String,
    pub stack_trace:       Option<String>,
    pub error_fingerprint: Option<String>,
    /// Optional caller-supplied file hint. When the dock surfaces an
    /// alert it knows which file blew up (`first stack frame`); we use
    /// that as a context-gather seed even before semantic search.
    pub file_hint:         Option<String>,
}

/// Output: a draft fix the orchestrator can persist + present in the
/// dock for approval.
#[derive(Debug, Clone, Serialize)]
pub struct RemediationDraft {
    /// Caller-supplied (or orchestrator-assigned) session id. Mirrors
    /// the row in `remediation_sessions`.
    pub session_id:         String,
    /// Unified diff body (no fence). Empty when the model returned an
    /// empty fence — the caller surfaces "no fix from the model" as a
    /// failed session.
    pub diff_unified:       String,
    /// Repo-relative file paths the diff touches. Parsed from the
    /// `+++ b/...` lines.
    pub files_touched:      Vec<String>,
    pub model_used:         &'static str,
    pub prompt_tokens:      u32,
    pub completion_tokens:  u32,
    pub cents:              i64,
}

/// Errors raised by the single-shot pipeline.
#[derive(Debug, thiserror::Error)]
pub enum SingleShotError {
    #[error("AI: {0}")]
    Ai(#[from] crate::ai::openai::OpenAIError),
    #[error("memory: {0}")]
    Memory(#[from] crate::memory::error::MemoryError),
    #[error("store: {0}")]
    Store(#[from] crate::store::error::StoreError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("model returned no diff fence")]
    NoDiffFence,
}

/// Run the single-shot pipeline. The orchestrator calls this on the
/// local path; tests call it directly with a mock `OpenAIClient`
/// (build via `OpenAIClient::with_key("test").with_base_url(mock_url)`)
/// + a tempdir-rooted `repo_path`.
///
/// `session_id` is plumbed through so the bus events match the row id
/// the orchestrator just inserted.
pub async fn run_single_shot(
    store:      &Arc<Store>,
    client:     &OpenAIClient,
    session_id: &str,
    input:      &SingleShotInput,
) -> Result<RemediationDraft, SingleShotError> {
    // 1 — semantic search seed.
    let mut query = String::with_capacity(input.error_message.len() + 64);
    query.push_str(&input.error_message);
    if let Some(stack) = input.stack_trace.as_deref() {
        if let Some(first) = stack.lines().next() {
            query.push(' ');
            query.push_str(first);
        }
    }

    let hits = semantic::search(store, &query, TOP_K, Some(&input.repo_id)).await?;

    // 2 — read context files. Prepend the file hint when present so it
    // always lands in the prompt even if it didn't dominate the search.
    let mut paths: Vec<String> = Vec::with_capacity(TOP_K + 1);
    if let Some(hint) = input.file_hint.as_deref() {
        if !hint.trim().is_empty() {
            paths.push(hint.to_string());
        }
    }
    for h in &hits {
        if !paths.contains(&h.file_path) {
            paths.push(h.file_path.clone());
        }
    }
    paths.truncate(TOP_K);

    let mut context_bodies: Vec<(String, String)> = Vec::with_capacity(paths.len());
    for rel in &paths {
        if let Some(body) = read_file_clipped(&input.repo_path, rel) {
            context_bodies.push((rel.clone(), body));
        }
    }

    // 3 — recent activity. Best-effort: if the query fails, we still
    // produce a draft (just without the activity context).
    let now_ms = now_ms();
    let recent_rows = match queries::query_events(
        store,
        &queries::EventFilter {
            kind:    Some("shell_event"),
            repo_id: Some(&input.repo_id),
            since:   Some(now_ms - RECENT_EVENTS_LOOKBACK_MS),
            limit:   Some(RECENT_EVENTS_LIMIT),
        },
    ) {
        Ok(r)  => r,
        Err(e) => {
            tracing::warn!(error = %e, "single-shot: episodic query failed (continuing)");
            Vec::new()
        }
    };

    let recent_summaries: Vec<(String, String, i64)> = recent_rows
        .iter()
        .map(|r| {
            let summary = summarise_shell_event(&r.payload_json);
            (r.kind.clone(), summary, r.timestamp_ms)
        })
        .collect();

    // 4 — build prompt.
    let alert = AlertContext {
        title:               input.error_message.split('\n').next().unwrap_or(&input.error_message),
        severity:            "high",
        body:                &input.error_message,
        source_integrations: &[],
        full_trace_context:  None,
    };
    let context_files: Vec<ContextFile<'_>> = context_bodies
        .iter()
        .map(|(p, b)| ContextFile { path: p, body: b })
        .collect();
    let recent_events: Vec<RecentEvent<'_>> = recent_summaries
        .iter()
        .map(|(k, s, t)| RecentEvent {
            kind:        k,
            summary:     s,
            timestamp_ms: *t,
        })
        .collect();

    let messages = build_single_shot_remediation_prompt(&alert, &context_files, &recent_events);

    // 5 — chat_complete. NOT streaming — we need the full diff to
    // validate shape before showing it to the user.
    let model    = Model::Gpt54;
    let response = client.chat_complete(&messages, model).await?;

    let diff_body = match extract_diff_fence(&response.content) {
        Some(d) => d,
        None    => {
            tracing::warn!(
                session_id = %session_id,
                "single-shot: model returned no diff fence"
            );
            return Err(SingleShotError::NoDiffFence);
        }
    };

    let files_touched = parse_diff_files(&diff_body);

    // 6 — cost estimate. Reuses the budget tracker's pricing table so
    // single_shot + budget never drift.
    let cents = model.cents_for_tokens(
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
    );

    Ok(RemediationDraft {
        session_id:        session_id.to_string(),
        diff_unified:      diff_body,
        files_touched,
        model_used:        model.api_name(),
        prompt_tokens:     response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        cents,
    })
}

fn read_file_clipped(repo_path: &Path, rel: &str) -> Option<String> {
    let abs = repo_path.join(rel);
    let mut bytes = std::fs::read(&abs).ok()?;
    if bytes.is_empty() {
        return Some(String::new());
    }
    if bytes.len() > MAX_FILE_BYTES {
        bytes.truncate(MAX_FILE_BYTES);
    }
    // Drop any partial UTF-8 multi-byte sequence at the truncation
    // boundary so `String::from_utf8` doesn't panic on a clean cut.
    while !bytes.is_empty() && std::str::from_utf8(&bytes).is_err() {
        bytes.pop();
    }
    String::from_utf8(bytes).ok()
}

/// Parse out the body of a single ```diff fenced code block. Returns
/// `None` when no fence is found. The body excludes the fence markers.
pub fn extract_diff_fence(content: &str) -> Option<String> {
    let mut lines = content.lines();
    let mut in_diff = false;
    let mut buf = String::new();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if !in_diff {
            if trimmed.starts_with("```diff") || trimmed == "```" && line.contains("diff") {
                in_diff = true;
            }
        } else {
            if trimmed == "```" {
                return Some(buf);
            }
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if in_diff {
        // Fence opened but never closed — treat as "no fence" since the
        // patch is structurally suspect. Caller falls into NoDiffFence.
        return None;
    }
    None
}

/// Walk the diff for `+++ b/<path>` (or `+++ <path>` when the diff was
/// produced without `a/`/`b/` prefixes) and return the unique set in
/// first-seen order.
pub fn parse_diff_files(diff: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("+++ ") {
            let path = rest.trim().trim_start_matches("b/");
            if path == "/dev/null" || path.is_empty() {
                continue;
            }
            let s = path.to_string();
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

fn summarise_shell_event(payload_json: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(payload_json) {
        Ok(v)  => v,
        Err(_) => return payload_json.chars().take(120).collect(),
    };
    let cmd  = parsed.get("cmd").and_then(|v| v.as_str()).unwrap_or("?");
    let exit = parsed.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(-1);
    let mut out = format!("$ {cmd} (exit {exit})");
    if out.len() > 120 {
        out.truncate(120);
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Helper for tests + future status surfaces — wrap the synth bus
/// event so the orchestrator doesn't have to keep two paths in sync.
pub fn started_event(session_id: &str, repo_id: &str) -> DaemonEvent {
    DaemonEvent::RemediationStarted {
        session_id: session_id.to_string(),
        repo_id:    repo_id.to_string(),
        mode:       "local".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_diff_fence_pulls_body() {
        let content = "Here is the patch:\n\n```diff\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n```\nDone.";
        let body = extract_diff_fence(content).unwrap();
        assert!(body.contains("--- a/foo"));
        assert!(body.contains("+new"));
        assert!(!body.contains("```"));
    }

    #[test]
    fn extract_diff_fence_returns_none_when_unfenced() {
        let content = "no fence here, just prose\n--- a/foo\n+++ b/foo\n";
        assert!(extract_diff_fence(content).is_none());
    }

    #[test]
    fn extract_diff_fence_returns_none_when_unterminated() {
        let content = "```diff\n--- a/foo\n+++ b/foo\nno close\n";
        assert!(extract_diff_fence(content).is_none());
    }

    #[test]
    fn parse_diff_files_dedups_and_strips_b_prefix() {
        let diff = "\
--- a/src/main.rs
+++ b/src/main.rs
@@ -1 +1 @@
-old
+new
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1 +1 @@
-foo
+bar
--- a/src/main.rs
+++ b/src/main.rs
@@ -2 +2 @@
-x
+y
";
        let files = parse_diff_files(diff);
        assert_eq!(files, vec!["src/main.rs".to_string(), "src/lib.rs".to_string()]);
    }

    #[test]
    fn parse_diff_files_skips_dev_null() {
        let diff = "+++ /dev/null\n+++ b/src/added.rs\n";
        let files = parse_diff_files(diff);
        assert_eq!(files, vec!["src/added.rs".to_string()]);
    }

    #[test]
    fn diff_files_skip_empty_path() {
        let files = parse_diff_files("+++ b/\n+++ b/src/x.rs\n");
        assert_eq!(files, vec!["src/x.rs".to_string()]);
    }
}
