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
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::ai::budget::Model;
use crate::ai::openai::OpenAIClient;
use crate::ai::prompts::{
    build_fast_apply_prompt, build_single_shot_remediation_prompt,
    AlertContext, ContextFile, RecentEvent,
};
use crate::daemon::DaemonEvent;
use crate::local_ai::{
    hardware::HardwareTier,
    GenerateOptions, LocalAI,
};
use crate::memory::semantic;
use crate::store::{queries, settings as store_settings, Store};

/// Settings key the registry persists the detected hardware tier
/// under. Mirrors `local_ai::registry::record_detected_tier`'s key.
/// Sesión 25 reads from here instead of `hardware::detect()` so tests
/// can override the tier via `settings::set` and so the dock's
/// "downgrade to Tier1" UI can take effect without a full re-detect.
const SETTINGS_KEY_LOCAL_AI_TIER: &str = "local_ai_tier";

/// Catalogue id for the Sesión 25 Kortix FastApply-7B model. Must match
/// `local_ai::registry::catalogue()` — the registry is the SSOT.
pub const KORTIX_MODEL_ID: &str = "kortix-fast-apply-7b";

/// Wire name stamped on `RemediationDraft.model_used` / persisted in
/// `remediation_sessions.model` so dashboards can distinguish local-mode
/// fixes from cloud calls. NEVER rename — the cost ledger groups by it.
pub const KORTIX_LOCAL_MODEL_NAME: &str = "kortix-7b-local";

/// Hard ceiling on `local_ai::generate` token output for the Apply
/// path. 4096 covers single-file edits up to ~16 KB which spans 95th
/// percentile of fix-shaped diffs in the v0.1 telemetry corpus.
const FAST_APPLY_MAX_TOKENS: u32 = 4096;

/// Per-call wall clock cap. Q4_K_M Kortix-7B at ~25 tok/s on a Tier-2
/// box (M3 Pro / Ryzen 5800X3D) finishes a 4096-token completion in
/// ~2.7 minutes worst case. We give it 3 minutes — anything beyond
/// that is a wedged sidecar and fall-back to cloud is the right move.
const FAST_APPLY_TIMEOUT_SECS: u64 = 180;

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
///
/// `local_ai` + `local_apply_enabled` (Sesión 25) gate the Kortix
/// FastApply-7B path. The local path is taken when **all** of these
/// hold: (1) `local_apply_enabled` is true, (2) `local_ai` is `Some(_)`,
/// (3) the host hardware classifies as `HardwareTier::Tier2`, and (4)
/// the Kortix GGUF is already cached on disk. If any prerequisite is
/// missing OR if the local generation fails for any reason, the
/// pipeline transparently falls back to the existing gpt-5.4 cloud
/// path (zero behaviour change for callers who pass `None` / `false`).
pub async fn run_single_shot(
    store:      &Arc<Store>,
    client:     &OpenAIClient,
    local_ai:   Option<&LocalAI>,
    local_apply_enabled: bool,
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

    // 2.5 — Sesión 25: try the local Kortix FastApply-7B path before
    // burning a cloud call. All four prerequisites must hold (toggle on,
    // facade present, hardware Tier2, model cached on disk). Any failure
    // — prerequisite missing OR generation error — falls through to the
    // existing gpt-5.4 path with no caller-visible difference.
    if local_apply_enabled {
        if let Some(ai) = local_ai {
            if let Some((target_path, target_body)) = context_bodies.first() {
                if let Some(draft) = try_fast_apply_local(
                    store,
                    ai,
                    session_id,
                    target_path,
                    target_body,
                    &input.error_message,
                    input.stack_trace.as_deref(),
                ).await {
                    return Ok(draft);
                }
            }
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

// ─────────────────────────────────────────────────────────────────────
// Sesión 25 — Kortix FastApply-7B local path
// ─────────────────────────────────────────────────────────────────────

/// Attempt the local Fast Apply pipeline. Returns `Some(draft)` on
/// success, `None` on any failure / missing prerequisite. The caller
/// (`run_single_shot`) treats `None` as "fall back to cloud" — never
/// surfaces an error from this function to the user.
async fn try_fast_apply_local(
    store:            &Arc<Store>,
    ai:               &LocalAI,
    session_id:       &str,
    target_path:      &str,
    target_body:      &str,
    error_message:    &str,
    stack_trace:      Option<&str>,
) -> Option<RemediationDraft> {
    // Prereq 1 — persisted hardware tier. The 7B model needs ≥ 16 GB
    // RAM + 8 logical CPUs (see `hardware::classify`); the registry
    // stores the last detected tier under `local_ai_tier`. Reading from
    // settings lets the dock surface a tier override + lets tests
    // exercise the local path on machines that classify Tier1.
    let tier_str = store_settings::get(store, SETTINGS_KEY_LOCAL_AI_TIER)
        .ok()
        .flatten()
        .unwrap_or_default();
    let tier = HardwareTier::parse(&tier_str);
    if tier != HardwareTier::Tier2 {
        tracing::debug!(
            ?tier,
            session_id,
            "fast_apply_local: skipping — hardware below Tier2",
        );
        return None;
    }

    // Prereq 2 — model is downloaded + verified on disk. We don't
    // trigger a fresh download here: that's the dock's job (Settings
    // → AI → "Download model"). Falling back to cloud is the right
    // move when the user hasn't pulled the GGUF yet.
    if !ai.registry().is_cached(KORTIX_MODEL_ID) {
        tracing::debug!(session_id, "fast_apply_local: skipping — Kortix not cached");
        return None;
    }

    // Build the prompt. Instruction = error message + stack-trace head.
    let mut instruction = String::with_capacity(error_message.len() + 128);
    instruction.push_str("Fix the following error in the file above:\n");
    instruction.push_str(error_message);
    if let Some(stack) = stack_trace {
        if let Some(first) = stack.lines().next() {
            instruction.push_str("\nStack: ");
            instruction.push_str(first);
        }
    }
    let prompt = build_fast_apply_prompt(target_body, &instruction);

    let opts = GenerateOptions {
        model_id:    KORTIX_MODEL_ID.to_string(),
        prompt,
        max_tokens:  FAST_APPLY_MAX_TOKENS,
        // Kortix is a chat-style instruct model — NOT FIM. The runtime
        // ignores this flag today but logs it so the audit trail is
        // honest about the call shape.
        fim_mode:    false,
        // None = use llama-server's default. Kortix is deterministic
        // enough at the default temperature; S26 may pin it lower if
        // empirical apply-success rates demand it.
        temperature: None,
        // Stop on the closing ChatML marker so we don't bleed into a
        // second turn if the model hallucinates one.
        stop_seqs:   vec!["<|im_end|>".into()],
    };

    // Drain the stream into a String, capping wall-clock at the timeout.
    let edited = match drain_local_stream(ai, opts).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                session_id,
                error = %e,
                "fast_apply_local: generate failed; falling back to cloud",
            );
            return None;
        }
    };

    // Strip any trailing ChatML marker the model emitted before the
    // stop sequence (some llama-server builds emit a partial token
    // before honouring `stop`).
    let edited = strip_chatml_trailer(&edited);
    if edited.trim().is_empty() {
        tracing::warn!(session_id, "fast_apply_local: empty completion; falling back");
        return None;
    }

    // Convert the full edited file → unified diff so the apply pipeline
    // (orchestrator::apply_diff) stays unchanged.
    let diff_unified = build_unified_diff(target_path, target_body, &edited);
    if diff_unified.trim().is_empty() {
        // No changes — model parroted the input back. Treat as failure
        // so the caller can still try the cloud (which may have a
        // different idea of what to change).
        tracing::info!(session_id, "fast_apply_local: model returned identical file; falling back");
        return None;
    }

    let files_touched = parse_diff_files(&diff_unified);
    if files_touched.is_empty() {
        // Diff produced but the `+++ b/...` parser couldn't extract a
        // path — should never happen given the way we generate the
        // diff, but defensively bail to cloud.
        tracing::warn!(session_id, "fast_apply_local: diff has no +++ b/ path; falling back");
        return None;
    }

    Some(RemediationDraft {
        session_id:        session_id.to_string(),
        diff_unified,
        files_touched,
        // Stable string for cost-ledger grouping. NEVER rename.
        model_used:        KORTIX_LOCAL_MODEL_NAME,
        // No usage tracking on local — `chars/4` heuristic would lie
        // about a workload that never crosses the network. Zero is
        // honest: zero cents, zero token bill.
        prompt_tokens:     0,
        completion_tokens: 0,
        cents:             0,
    })
}

/// Drain `LocalAI::generate` into a String, with a wall-clock cap. The
/// stream's own `finish_reason` terminates it normally; the timeout is
/// a safety net for wedged sidecars.
async fn drain_local_stream(
    ai:   &LocalAI,
    opts: GenerateOptions,
) -> Result<String, String> {
    let stream_res = tokio::time::timeout(
        Duration::from_secs(FAST_APPLY_TIMEOUT_SECS),
        ai.generate(opts),
    ).await;

    let mut stream = match stream_res {
        Ok(Ok(s))   => s,
        Ok(Err(e))  => return Err(format!("generate open: {e}")),
        Err(_)      => return Err("generate open timeout".to_string()),
    };

    let drain = async {
        let mut out = String::new();
        while let Some(item) = stream.next().await {
            match item {
                Ok(tok) => {
                    out.push_str(&tok.text);
                    if tok.finish_reason.is_some() {
                        break;
                    }
                }
                Err(e) => return Err(format!("stream chunk: {e}")),
            }
        }
        Ok(out)
    };

    match tokio::time::timeout(Duration::from_secs(FAST_APPLY_TIMEOUT_SECS), drain).await {
        Ok(Ok(s))  => Ok(s),
        Ok(Err(e)) => Err(e),
        Err(_)     => Err("stream drain timeout".to_string()),
    }
}

/// Some llama-server builds emit a partial `<|im_end|>` token before
/// the stop-seq match fires — strip any trailing ChatML marker so the
/// edited file is byte-clean. Also trims a single trailing newline
/// the model often glues on after the marker.
fn strip_chatml_trailer(s: &str) -> String {
    let mut out = s.to_string();
    for marker in ["<|im_end|>", "<|im_start|>"] {
        if let Some(idx) = out.rfind(marker) {
            // Keep everything before the marker; assume the marker is
            // at the end (we never want to truncate mid-file content).
            // If the marker appears mid-content somehow, that's the
            // model lying about itself — return the original untouched.
            let after_marker = idx + marker.len();
            if after_marker >= out.len().saturating_sub(8) {
                out.truncate(idx);
            }
        }
    }
    out
}

/// Build a unified diff from `original` → `edited` for `repo_relative`.
/// Uses the `similar` crate's `unified_diff` builder + 3 lines of
/// context (the same default `git apply` expects). The header lines
/// match `git diff`'s `--- a/<path>` / `+++ b/<path>` convention so
/// `parse_diff_files` extracts the right repo-relative path.
pub fn build_unified_diff(repo_relative: &str, original: &str, edited: &str) -> String {
    let diff = similar::TextDiff::from_lines(original, edited);
    let header_a = format!("a/{repo_relative}");
    let header_b = format!("b/{repo_relative}");
    diff.unified_diff()
        .context_radius(3)
        .header(&header_a, &header_b)
        .to_string()
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
