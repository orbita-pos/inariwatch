//! `textDocument/completion` handler.
//!
//! Sesión 23 wired this to `LocalAI::generate(.., fim_mode = true)`
//! against Qwen2.5-Coder-1.5B with a single-candidate, no-cache,
//! always-fire pipeline. Sesión 24 adds the UX-magic layers on top:
//!
//! 1. **Smart triggers** ([`crate::lsp::triggers::should_trigger`]) —
//!    suppress in string literals, comments, mid-word, import blocks.
//! 2. **Cache** ([`crate::lsp::cache::CompletionCache`]) — LRU keyed on
//!    `(blake3(buffer), byte_offset)`. Hits return in <5 ms.
//! 3. **Indexer-aware context** ([`crate::lsp::fim::build_context_for_completion`]) —
//!    top-3 symbols + import block prepended to the local ±200-line
//!    slice, per-language tuned.
//! 4. **n=3 sampling + ranking** — three parallel `LocalAI::generate`
//!    calls with `temperature: 0.7`, scored by token-boundary +
//!    syntactic validity + overlap-with-prefix.
//! 5. **Dedup against next 3 lines** — completions matching the doc's
//!    suffix (whitespace-tolerant) are suppressed.
//! 6. **Latency budget** — the whole pipeline is wrapped in a 250 ms
//!    `tokio::time::timeout`. On overrun: empty list, silent
//!    degradation.
//!
//! ## Cancellation (preserved from S22/S23)
//!
//! The cancel pipeline (`tokio::select!` over `cancel_rx`) is owned by
//! `lsp::mod::run_request`. When `cancel_rx` fires, the work future
//! drops; that drops the parallel HTTP body streams from
//! `LocalAI::generate`, which closes the connections. The `-32800
//! RequestCancelled` code is emitted only via the cancel branch.
//!
//! ## Failure mode
//!
//! Every error path (no doc, no LocalAI, network failure, parse error,
//! timeout, all candidates dedup'd, suppressed by triggers) returns an
//! empty `CompletionList` — same silent-degradation contract as S22.

use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::StreamExt;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tree_sitter::Parser;

use crate::indexer::lang::tree_sitter_language;
use crate::local_ai::{GenerateOptions, LocalAI, LocalAiError, Token};
use crate::lsp::cache::{CacheKey, CompletionCache};
use crate::lsp::document_sync::utf16_pos_to_byte;
use crate::lsp::fim;
use crate::lsp::protocol::{RequestId, ResponseError, ResponseMessage};
use crate::lsp::triggers::{lang_for_id, should_trigger};
use crate::lsp::LspState;

/// Model id from `local_ai::registry::catalogue()` (Sesión 21).
const QWEN_MODEL_ID: &str = "qwen2.5-coder-1.5b";

/// How many candidates to sample per request. n=3 is the HANDOFF spec.
const N_CANDIDATES: usize = 3;

/// Sampling temperature for the parallel candidates. Higher than the
/// llama-server default (0.8) makes outputs feel "wild"; lower (0.3)
/// kills the variety the ranker needs. 0.7 is the spec.
const SAMPLE_TEMPERATURE: f32 = 0.7;

/// Total pipeline budget. Cursor's Tab feels native at <150 ms; >250 ms
/// is "user perceives lag, gives up". Silent degradation past this.
const PIPELINE_BUDGET: Duration = Duration::from_millis(250);

/// How many lines of the document's suffix we compare against the
/// candidate for the dedup check.
const DEDUP_LOOKAHEAD_LINES: usize = 3;

/// Stop sequences. Two newlines means "end of block" in most languages
/// and is a useful bail-out so the model doesn't generate past the
/// current logical scope.
fn fim_stop_seqs() -> Vec<String> {
    vec!["\n\n".to_string()]
}

/// Run the completion request inside the cancel-aware pipeline.
pub async fn handle(
    state: Arc<LspState>,
    id: RequestId,
    params: Value,
    cancel_rx: oneshot::Receiver<()>,
) -> ResponseMessage {
    let work = compute_completion(state.clone(), params);

    tokio::select! {
        result = work => ResponseMessage::success(id, result),
        _      = cancel_rx => ResponseMessage::fail(id, ResponseError::request_cancelled()),
    }
}

/// Build a completion list. Returns the empty `CompletionList` JSON on
/// any failure path (silent degradation — see module docs).
async fn compute_completion(state: Arc<LspState>, params: Value) -> Value {
    // Honor the test-only debug delay (preserved from S22 so the
    // `lsp_cancel_request_works.rs` regression keeps observing a
    // genuinely-pending request). Production code never sets this.
    let delay_ms = state.completion_delay_ms();
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }

    // Wrap the entire post-delay pipeline in the latency budget. On
    // timeout we return an empty list — the editor falls back to its
    // built-in suggestions.
    match tokio::time::timeout(PIPELINE_BUDGET, run_pipeline(state, params)).await {
        Ok(v) => v,
        Err(_elapsed) => empty_list(),
    }
}

async fn run_pipeline(state: Arc<LspState>, params: Value) -> Value {
    // Parse params — best-effort.
    let Some(uri) = params
        .get("textDocument")
        .and_then(|td| td.get("uri"))
        .and_then(Value::as_str)
    else {
        return empty_list();
    };
    let line: u32 = params
        .get("position")
        .and_then(|p| p.get("line"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;
    let character: u32 = params
        .get("position")
        .and_then(|p| p.get("character"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;

    let Some(doc) = state.documents.get(uri) else {
        return empty_list();
    };

    // Position → byte offset (UTF-16 code units → UTF-8 bytes).
    let byte_offset = utf16_pos_to_byte(&doc.text, line, character);

    // ── 1. Smart triggers ────────────────────────────────────────────
    let lang_id = if doc.language_id.is_empty() {
        None
    } else {
        Some(doc.language_id.as_str())
    };
    if !should_trigger(lang_id, &doc.text, byte_offset) {
        return empty_list();
    }

    // ── 2. Cache lookup BEFORE LocalAI / cancel select ──────────────
    let cache: CompletionCache = state.completion_cache();
    let key = CacheKey::from_text(&doc.text, byte_offset);
    if let Some(cached) = cache.get(&key) {
        return cached;
    }

    // ── 3. LocalAI handle (none → empty) ─────────────────────────────
    let Some(local_ai) = state.local_ai() else {
        return empty_list();
    };

    // ── 4. Indexer-aware context selection ───────────────────────────
    let lang = lang_id.and_then(lang_for_id);
    let (prefix, suffix) = fim::build_context_for_completion(
        &doc.text,
        byte_offset,
        fim::DEFAULT_CONTEXT_LINES,
        lang,
    );
    let prompt     = fim::build_fim_prompt(&prefix, &suffix);
    let max_tokens = fim::max_tokens_for_lang(lang);

    // ── 5. n=3 parallel sampling at temperature 0.7 ─────────────────
    let candidates = sample_n_candidates(&local_ai, &prompt, max_tokens).await;
    let candidates: Vec<String> = candidates
        .into_iter()
        .filter(|c| !c.is_empty())
        .collect();
    if candidates.is_empty() {
        return empty_list();
    }

    // ── 6. Rank candidates ───────────────────────────────────────────
    let best = rank_candidates(&candidates, &prefix, &suffix, lang);

    // ── 7. Dedup against the next 3 lines of the document's suffix ──
    if matches_doc_suffix(&best, &doc.text, byte_offset, DEDUP_LOOKAHEAD_LINES) {
        return empty_list();
    }

    // ── 8. Build CompletionItem + cache ──────────────────────────────
    let item = json!({
        "isIncomplete": false,
        "items": [{
            "label":      first_line(&best).to_string(),
            "insertText": best,
            "kind":       1,
        }],
    });
    cache.insert(key, item.clone());
    item
}

/// Spawn `N_CANDIDATES` parallel calls to `LocalAI::generate` with the
/// same prompt + temperature. Returns the accumulated text from each;
/// errored streams contribute an empty string (filtered out upstream).
async fn sample_n_candidates(
    local_ai:   &LocalAI,
    prompt:     &str,
    max_tokens: u32,
) -> Vec<String> {
    let mut tasks = Vec::with_capacity(N_CANDIDATES);
    for _ in 0..N_CANDIDATES {
        let opts = GenerateOptions {
            model_id:    QWEN_MODEL_ID.to_string(),
            prompt:      prompt.to_string(),
            max_tokens,
            stop_seqs:   fim_stop_seqs(),
            fim_mode:    true,
            temperature: Some(SAMPLE_TEMPERATURE),
        };
        let ai = local_ai.clone();
        tasks.push(tokio::spawn(async move {
            collect_one(&ai, opts).await
        }));
    }

    let mut out = Vec::with_capacity(N_CANDIDATES);
    for t in tasks {
        match t.await {
            Ok(s)  => out.push(s),
            Err(_) => out.push(String::new()),
        }
    }
    out
}

/// Drain a single `LocalAI::generate` stream into a `String`. Returns
/// the empty string on any error.
async fn collect_one(local_ai: &LocalAI, opts: GenerateOptions) -> String {
    let mut stream = match local_ai.generate(opts).await {
        Ok(s)  => s,
        Err(_) => return String::new(),
    };
    let mut acc = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(Token { text, finish_reason }) => {
                acc.push_str(&text);
                if finish_reason.is_some() {
                    break;
                }
            }
            Err(LocalAiError::BadChunk(_)) => break,
            Err(_)                         => return String::new(),
        }
    }
    acc
}

/// Score candidates and return the highest-scoring one. Tie-break by
/// stable ordering (first wins).
fn rank_candidates(
    candidates: &[String],
    prefix:     &str,
    suffix:     &str,
    lang:       Option<crate::indexer::lang::Lang>,
) -> String {
    let scored: Vec<(i64, &String)> = candidates
        .iter()
        .map(|c| (candidate_score(c, prefix, suffix, lang), c))
        .collect();
    let best = scored.iter().max_by_key(|(s, _)| *s).map(|(_, c)| *c);
    best.cloned().unwrap_or_default()
}

/// Score a single candidate. Higher is better. Components (each
/// roughly in the same order of magnitude so the sum stays meaningful):
///
///   * `+10` if completion ends on an identifier boundary OR on a
///     closing brace / paren / bracket. Prefer "complete tokens".
///   * `+10` if `tree-sitter` parses `prefix + completion + suffix`
///     without ERROR / MISSING nodes. Syntactic validity.
///   * `-5`  per occurrence (capped at 3) of an exact >=20-char
///     substring that already appears in the prefix. Penalises
///     parroting.
///   * `+1`  per unique identifier in the completion that does NOT
///     appear in the prefix (capped at 3). Tiny novelty bonus.
///   * `-3`  if the candidate is empty or whitespace-only.
fn candidate_score(
    completion: &str,
    prefix:     &str,
    suffix:     &str,
    lang:       Option<crate::indexer::lang::Lang>,
) -> i64 {
    if completion.trim().is_empty() {
        return -3;
    }

    let mut score = 0i64;

    // (a) Token-boundary check.
    let last_char = completion.chars().last();
    let ends_clean = match last_char {
        Some(c) if c.is_alphanumeric() || c == '_' => {
            // Ends mid-identifier — penalise.
            false
        }
        Some(c) if matches!(c, '}' | ')' | ']' | ';' | '\n' | ',' | '.' | ' ' | '?') => true,
        Some(_) => true,
        None    => false,
    };
    if ends_clean { score += 10; }

    // (b) Syntactic validity. Skipped when language is unknown.
    if let Some(l) = lang {
        let assembled = format!("{prefix}{completion}{suffix}");
        if parses_clean(l, &assembled) {
            score += 10;
        }
    }

    // (c) Overlap-with-prefix penalty.
    score -= overlap_penalty(completion, prefix);

    // (d) Novelty bonus.
    score += novelty_bonus(completion, prefix);

    score
}

fn parses_clean(lang: crate::indexer::lang::Lang, source: &str) -> bool {
    let mut parser = Parser::new();
    if parser.set_language(&tree_sitter_language(lang)).is_err() {
        return false;
    }
    let Some(tree) = parser.parse(source, None) else { return false };
    !tree.root_node().has_error()
}

fn overlap_penalty(completion: &str, prefix: &str) -> i64 {
    // Slide a 20-char window over the completion; count windows that
    // appear verbatim in the prefix (skipping shorter completions).
    if completion.len() < 20 || prefix.len() < 20 {
        return 0;
    }
    let mut hits = 0i64;
    let bytes = completion.as_bytes();
    let mut i = 0;
    while i + 20 <= bytes.len() {
        if let Ok(window) = std::str::from_utf8(&bytes[i..i + 20]) {
            if prefix.contains(window) {
                hits += 1;
                if hits >= 3 { break; }
                i += 20; // skip past this window
                continue;
            }
        }
        i += 1;
    }
    hits.saturating_mul(5)
}

fn novelty_bonus(completion: &str, prefix: &str) -> i64 {
    let mut count = 0i64;
    for ident in completion
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| s.len() >= 3)
    {
        if !prefix.contains(ident) {
            count += 1;
            if count >= 3 { break; }
        }
    }
    count
}

/// Whitespace-tolerant comparison: does `completion` (modulo runs of
/// whitespace) match the next `lookahead_lines` lines of the document
/// after `byte_offset`?
fn matches_doc_suffix(
    completion:      &str,
    text:            &str,
    byte_offset:     usize,
    lookahead_lines: usize,
) -> bool {
    let cursor = byte_offset.min(text.len());
    let after = &text[cursor..];
    let suffix_window: String = after
        .lines()
        .take(lookahead_lines)
        .collect::<Vec<_>>()
        .join("\n");
    if suffix_window.trim().is_empty() {
        return false;
    }
    normalize_ws(completion) == normalize_ws(&suffix_window)
}

fn normalize_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

fn empty_list() -> Value {
    json!({ "isIncomplete": false, "items": [] })
}

/// First line of `s`, or the entire `s` if it has no newline.
fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::lang::Lang;

    #[test]
    fn empty_list_shape_matches_lsp_completionlist() {
        let v = empty_list();
        assert_eq!(v["isIncomplete"], false);
        assert!(v["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn first_line_handles_single_and_multi_line() {
        assert_eq!(first_line("fn add"), "fn add");
        assert_eq!(first_line("fn add\nfn sub"), "fn add");
        assert_eq!(first_line(""), "");
    }

    #[test]
    fn rank_picks_token_boundary_over_mid_word() {
        // Two candidates: one ends mid-word ("addNumb"), the other on
        // identifier boundary ("addNumber()"). The ranker prefers the
        // boundary-clean one.
        let prefix = "function ";
        let suffix = "\n}";
        let cands = vec![
            "addNumb".to_string(),
            "addNumber()".to_string(),
        ];
        let best = rank_candidates(&cands, prefix, suffix, None);
        assert_eq!(best, "addNumber()");
    }

    #[test]
    fn rank_breaks_ties_on_overlap_penalty() {
        // Two boundary-clean candidates; one duplicates a prefix
        // string of >=20 chars verbatim. The duplicator scores lower.
        let prefix = "// duplicated string content here over twenty chars\n";
        let suffix = "";
        let cands = vec![
            "duplicated string content here over twenty chars".to_string(),
            "fresh new content here".to_string(),
        ];
        let best = rank_candidates(&cands, prefix, suffix, None);
        assert_eq!(best, "fresh new content here");
    }

    #[test]
    fn dedup_matches_whitespace_tolerant() {
        let text = "fn main() {\n    let x = 1;\n    let y = 2;\n    let z = 3;\n}\n";
        let cursor = text.find("let x").unwrap();
        // Completion verbatim of next 3 lines.
        let completion = "let x = 1;\n    let y = 2;\n    let z = 3;";
        assert!(matches_doc_suffix(completion, text, cursor, 3));
        // Subtle whitespace differences should still match.
        let completion_ws = "let  x =  1;\n    let y= 2;\n    let z = 3;";
        assert!(matches_doc_suffix(completion_ws, text, cursor, 3));
        // A different completion does NOT match.
        let completion_diff = "let foo = 99;";
        assert!(!matches_doc_suffix(completion_diff, text, cursor, 3));
    }

    #[test]
    fn parses_clean_returns_true_for_valid_rust() {
        assert!(parses_clean(Lang::Rust, "fn main() { let x = 1; }"));
    }

    #[test]
    fn parses_clean_returns_false_for_broken_rust() {
        // Unmatched brace.
        assert!(!parses_clean(Lang::Rust, "fn main() { let x = 1;"));
    }
}
