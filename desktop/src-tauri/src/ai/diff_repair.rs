//! Sesión 26 — Fast Apply v2: validate + repair the FULL edited file the
//! Kortix FastApply-7B model returns, before we hand it to the unified
//! diff builder.
//!
//! Sesión 25 documented three known failure modes that drop the local
//! apply rate to ~70%:
//!
//!   1. **CRLF normalisation drift** — the model normalises line endings
//!      to LF on Windows-CRLF source files. The resulting diff has the
//!      right intent but `git apply --check` rejects it because the
//!      context lines don't match byte-for-byte.
//!   2. **Trailing-newline drift** — the model omits (or adds) a single
//!      trailing newline. `git apply` complains about "no newline at end
//!      of file" and refuses the patch.
//!   3. **Mid-stream `<|im_end|>` partial emission** — the model emits a
//!      partial ChatML control token mid-content. S25's
//!      `strip_chatml_trailer` only catches markers in the last 8 bytes.
//!
//! This module owns the post-generation cleanup (rules 1 + 2) and the
//! detection logic for fatal failure modes (rule 3 + truncation +
//! suspicious full-rewrite). The actual retry orchestration lives in
//! `single_shot::try_fast_apply_local`; this module is pure: input →
//! result, no I/O, no external state.

/// Markers that can appear in a partial ChatML emission. We match
/// against any of these inside the body (NOT just at the end) — that's
/// the signal something went wrong mid-stream.
const CHATML_BODY_MARKERS: &[&str] = &["<|im_start|>", "<|im_end|>", "<|im_"];

/// A ratio below which "edited is much shorter than original" trips the
/// truncation detector. 0.5 means "the model gave us less than half the
/// file" — a very strong signal that the stream cut off mid-output.
const TRUNCATION_RATIO: f32 = 0.5;

/// Original-file floor before truncation detection runs at all. Tiny
/// files (< 5 lines or < 200 bytes) can legitimately shrink by half
/// after a one-line edit; we don't want to flag those. The 200-byte
/// floor matches the lower end of "real fix-shaped files" in the
/// `radar/web/` corpus we'll measure against in S31.
const TRUNCATION_MIN_ORIGINAL_BYTES: usize = 200;
const TRUNCATION_MIN_ORIGINAL_LINES: usize = 5;

/// Original-line floor before full-rewrite detection runs. A 3-line
/// file legitimately rewrites entirely on most edits; we only flag
/// "every line different" as suspicious when the file is large enough
/// that a sane fix touches < 100% of it.
const FULL_REWRITE_MIN_ORIGINAL_LINES: usize = 10;

/// Substring (case-insensitive) that, when present in the user's
/// instruction, exempts the output from full-rewrite suspicion. The
/// user explicitly asked for a rewrite, so changing every line is fine.
const REWRITE_INTENT_KEYWORDS: &[&str] = &["rewrite", "rewrite the", "redo", "from scratch"];

/// Errors the validator can raise. Each variant maps to a different
/// recovery strategy in `single_shot::try_fast_apply_local`:
///
/// * [`Truncated`] / [`FullRewriteSuspicious`] — fatal. The output is
///   structurally wrong; no amount of prompt repair will recover. Caller
///   bails to the cloud path immediately (no retry).
/// * [`PartialChatMLEmission`] / [`EmptyOutput`] — recoverable via
///   prompt repair. Caller asks the model to regenerate with explicit
///   guidance about what went wrong.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RepairError {
    #[error(
        "edited file is much shorter than original (orig={original_len}B, \
         edited={edited_len}B); model likely truncated mid-stream"
    )]
    Truncated { original_len: usize, edited_len: usize },

    #[error(
        "edited file rewrites every line of the original; this is \
         suspicious for a targeted fix (use 'rewrite' in the instruction \
         to disable this guard)"
    )]
    FullRewriteSuspicious,

    #[error("edited file is empty after normalisation")]
    EmptyOutput,

    #[error(
        "edited file contains a ChatML control token in body content \
         (model emitted a partial marker before stop)"
    )]
    PartialChatMLEmission,
}

/// Outcome of `validate_and_repair` on success. `edited_file` is the
/// post-normalisation body the caller should hand to `build_unified_diff`.
/// `normalized` is true when the normaliser actually changed something
/// (useful for telemetry / decision tracking — Sesión 26 doesn't surface
/// it past the call boundary, but Sesión 31's apply-rate dashboard will).
#[derive(Debug, Clone)]
pub struct RepairedDiff {
    pub edited_file: String,
    pub normalized:  bool,
}

/// Validate the model's output and return a normalised, apply-ready
/// version. The normaliser:
///
///   1. Strips a leading UTF-8 BOM (some llama-server builds prepend
///      one when the GGUF was tokenised with a tokeniser config that
///      includes a BOM in its alphabet).
///   2. Aligns line endings (CRLF / CR / LF mixed → match the original
///      file's dominant line ending).
///   3. Re-attaches a trailing newline if the original had one and the
///      model dropped it (or strips it if the model added one and the
///      original didn't).
///
/// Then runs the four fatal-failure detectors — truncation, full
/// rewrite, partial ChatML emission, empty output — and returns a
/// `RepairError` if any fire.
///
/// The `instruction` arg is consulted only by `detect_full_rewrite` to
/// honour the user's "please rewrite the whole file" intent (case-
/// insensitive substring match against [`REWRITE_INTENT_KEYWORDS`]).
pub fn validate_and_repair(
    original:    &str,
    edited:      &str,
    instruction: &str,
) -> Result<RepairedDiff, RepairError> {
    // 1 — early reject: empty output is always invalid (caller would
    // produce an empty diff, which we already short-circuit upstream,
    // but explicit-is-better-than-implicit).
    if edited.trim().is_empty() {
        return Err(RepairError::EmptyOutput);
    }

    // 2 — partial ChatML detection. We check BEFORE normalisation so
    // the marker isn't accidentally smoothed away by line-ending fixes.
    // Skip the trailing 16 bytes — that's S25's `strip_chatml_trailer`'s
    // domain. Markers in the body proper are the bug we're catching.
    if has_partial_chatml_in_body(edited) {
        return Err(RepairError::PartialChatMLEmission);
    }

    // 3 — normalise (BOM + line endings + trailing newline).
    let normalised = normalize_line_endings(edited);
    let normalised = align_to_original(&normalised, original);
    let did_change = normalised != edited;

    // 4 — truncation detector. Run on the NORMALISED body so trailing
    // whitespace doesn't bias the byte count. Skip for trivially small
    // originals where "much shorter" has no meaning.
    if detect_truncation(original.len(), normalised.len())
        && original.len() >= TRUNCATION_MIN_ORIGINAL_BYTES
        && original.lines().count() >= TRUNCATION_MIN_ORIGINAL_LINES
    {
        return Err(RepairError::Truncated {
            original_len: original.len(),
            edited_len:   normalised.len(),
        });
    }

    // 5 — full-rewrite detector. Honour the "rewrite" intent in the
    // instruction so the user can explicitly opt out of the guard.
    if detect_full_rewrite(original, &normalised) && !instruction_allows_rewrite(instruction) {
        return Err(RepairError::FullRewriteSuspicious);
    }

    Ok(RepairedDiff {
        edited_file: normalised,
        normalized:  did_change,
    })
}

/// Strip a leading UTF-8 BOM (`\u{FEFF}` = `EF BB BF`) and unify line
/// endings to LF. Trailing whitespace per line is left intact — that
/// can be load-bearing in some files (Markdown line breaks, .gitignore
/// trailing-slash semantics) and `git apply` cares about it byte-for-
/// byte. The follow-on `align_to_original` swaps LF → CRLF if the
/// original used CRLF.
pub fn normalize_line_endings(text: &str) -> String {
    let stripped = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    // Two-pass: CRLF → LF first, then any lone CR → LF. Doing it in one
    // pass with a manual scan would be slightly faster but the borrow-
    // checker mess isn't worth the µs on a 16 KB file.
    let lf = stripped.replace("\r\n", "\n");
    lf.replace('\r', "\n")
}

/// Align the normalised (LF-only) edited body to the original's line-
/// ending convention + trailing-newline state. This is the "make the
/// model's output byte-compatible with what `git apply --check` will
/// see on disk" pass.
fn align_to_original(edited_lf: &str, original: &str) -> String {
    let original_uses_crlf  = original.contains("\r\n");
    let original_ends_in_lf = original.ends_with('\n') || original.ends_with("\r\n");

    let mut out = String::with_capacity(edited_lf.len());
    if original_uses_crlf {
        // Replace LF → CRLF. We already normalised away any stray CR so
        // a naive replace is safe.
        out.push_str(&edited_lf.replace('\n', "\r\n"));
    } else {
        out.push_str(edited_lf);
    }

    // Trailing-newline alignment. The model often drops or adds a single
    // trailing newline depending on whether the closing token aligned
    // with end-of-line. We mirror the original.
    let edited_ends_in_lf = out.ends_with('\n') || out.ends_with("\r\n");
    match (original_ends_in_lf, edited_ends_in_lf) {
        (true,  false) => out.push_str(if original_uses_crlf { "\r\n" } else { "\n" }),
        (false, true)  => {
            // Strip exactly one trailing newline (CRLF or LF).
            if out.ends_with("\r\n") {
                out.truncate(out.len() - 2);
            } else if out.ends_with('\n') {
                out.truncate(out.len() - 1);
            }
        }
        _ => {}
    }
    out
}

/// True when `edited_len` is below `TRUNCATION_RATIO` × `original_len`.
/// Pure ratio test — the original-size floor is enforced by the caller
/// (`validate_and_repair`) so the helper stays trivially testable.
pub fn detect_truncation(original_len: usize, edited_len: usize) -> bool {
    if original_len == 0 {
        return false;
    }
    (edited_len as f32) < (original_len as f32) * TRUNCATION_RATIO
}

/// True when every line of the original is missing from the edited
/// body. Strict: a single shared line disqualifies the full-rewrite
/// verdict (the model preserved at least one piece of context, so the
/// user's intent was likely a targeted edit).
///
/// Skip for tiny files (< [`FULL_REWRITE_MIN_ORIGINAL_LINES`]) — small
/// files legitimately rewrite entirely.
pub fn detect_full_rewrite(original: &str, edited: &str) -> bool {
    let original_lines: Vec<&str> = original.lines().collect();
    if original_lines.len() < FULL_REWRITE_MIN_ORIGINAL_LINES {
        return false;
    }
    let edited_set: std::collections::HashSet<&str> = edited.lines().collect();
    // Look for any non-trivial original line that survives. We exclude
    // blank lines + lines that are < 3 chars (`}`, `{`, `;`) because
    // those would cause false negatives on most Rust/JS files.
    !original_lines.iter().any(|line| {
        let trimmed = line.trim();
        trimmed.len() >= 3 && edited_set.contains(line)
    })
}

/// Case-insensitive substring scan against [`REWRITE_INTENT_KEYWORDS`].
fn instruction_allows_rewrite(instruction: &str) -> bool {
    let lower = instruction.to_lowercase();
    REWRITE_INTENT_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

/// True when a ChatML control marker appears in the body, EXCLUDING
/// the trailing 16 bytes (S25's `strip_chatml_trailer` owns that
/// region — markers there are the expected end-of-stream artefact, not
/// a partial mid-stream emission).
fn has_partial_chatml_in_body(text: &str) -> bool {
    if text.len() <= 16 {
        return false;
    }
    let body = &text[..text.len() - 16];
    CHATML_BODY_MARKERS.iter().any(|m| body.contains(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_unifies_crlf_lf_mixed() {
        let input = "line1\r\nline2\nline3\r\n";
        let out   = normalize_line_endings(input);
        assert_eq!(out, "line1\nline2\nline3\n");
    }

    #[test]
    fn normalize_strips_bom() {
        let input = "\u{FEFF}fn main() {}\n";
        let out   = normalize_line_endings(input);
        assert_eq!(out, "fn main() {}\n");
    }

    #[test]
    fn normalize_handles_lone_cr() {
        let input = "line1\rline2\r";
        let out   = normalize_line_endings(input);
        assert_eq!(out, "line1\nline2\n");
    }

    #[test]
    fn align_swaps_lf_to_crlf_when_original_was_crlf() {
        let original = "a\r\nb\r\n";
        let edited   = "a\nb\nc\n";
        let aligned  = align_to_original(edited, original);
        assert_eq!(aligned, "a\r\nb\r\nc\r\n");
    }

    #[test]
    fn align_reattaches_trailing_newline_when_dropped() {
        let original = "fn main() {}\n";
        let edited   = "fn main() {}";
        let aligned  = align_to_original(edited, original);
        assert_eq!(aligned, "fn main() {}\n");
    }

    #[test]
    fn align_strips_extra_trailing_newline() {
        let original = "fn main() {}";
        let edited   = "fn main() {}\n";
        let aligned  = align_to_original(edited, original);
        assert_eq!(aligned, "fn main() {}");
    }

    #[test]
    fn detect_truncation_flags_half_size() {
        assert!(detect_truncation(1000, 400));
        assert!(!detect_truncation(1000, 600));
        assert!(!detect_truncation(0, 0));
    }

    #[test]
    fn detect_full_rewrite_flags_disjoint_corpus() {
        let original = (1..=12).map(|i| format!("alpha_{i}_line")).collect::<Vec<_>>().join("\n");
        let edited   = (1..=12).map(|i| format!("beta_{i}_word")).collect::<Vec<_>>().join("\n");
        assert!(detect_full_rewrite(&original, &edited));
    }

    #[test]
    fn detect_full_rewrite_passes_when_one_line_survives() {
        let original = "let x = 1;\nlet y = 2;\nlet z = 3;\nlet w = 4;\nlet v = 5;\n\
                        let u = 6;\nlet t = 7;\nlet s = 8;\nlet r = 9;\nlet q = 10;\nlet p = 11;\n";
        // edit one line — the other 10 survive. Should NOT flag.
        let edited   = "let x = 99;\nlet y = 2;\nlet z = 3;\nlet w = 4;\nlet v = 5;\n\
                        let u = 6;\nlet t = 7;\nlet s = 8;\nlet r = 9;\nlet q = 10;\nlet p = 11;\n";
        assert!(!detect_full_rewrite(original, edited));
    }

    #[test]
    fn detect_full_rewrite_skipped_for_tiny_files() {
        let original = "fn a() {}\nfn b() {}\nfn c() {}\n";
        let edited   = "fn x() {}\nfn y() {}\nfn z() {}\n";
        assert!(!detect_full_rewrite(original, edited));
    }

    #[test]
    fn validate_and_repair_passes_clean_lf_input() {
        let original    = "line1\nline2\nline3\n";
        let edited      = "line1\nline2 changed\nline3\n";
        let instruction = "fix line 2";
        let repaired    = validate_and_repair(original, edited, instruction).unwrap();
        assert_eq!(repaired.edited_file, edited);
        assert!(!repaired.normalized);
    }

    #[test]
    fn validate_and_repair_normalises_crlf_drift() {
        let original    = "line1\r\nline2\r\nline3\r\n";
        // Model returned the file with LF endings — the apply check
        // would normally fail. The validator aligns it back to CRLF.
        let edited      = "line1\nline2 changed\nline3\n";
        let repaired    = validate_and_repair(original, edited, "fix line 2").unwrap();
        assert_eq!(repaired.edited_file, "line1\r\nline2 changed\r\nline3\r\n");
        assert!(repaired.normalized);
    }

    #[test]
    fn validate_and_repair_reattaches_trailing_newline() {
        let original    = "fn main() {}\n";
        let edited      = "fn main() { let x = 1; }";
        let repaired    = validate_and_repair(original, edited, "add a let binding").unwrap();
        assert_eq!(repaired.edited_file, "fn main() { let x = 1; }\n");
        assert!(repaired.normalized);
    }

    #[test]
    fn validate_and_repair_rejects_truncation() {
        // Original ≥ 200 bytes AND ≥ 5 lines so both truncation floors
        // are cleared. Edited is < 50% of original (TRUNCATION_RATIO).
        let original = "fn function_alpha() -> usize { 1 }\n\
                        fn function_beta() -> usize { 2 }\n\
                        fn function_gamma() -> usize { 3 }\n\
                        fn function_delta() -> usize { 4 }\n\
                        fn function_epsilon() -> usize { 5 }\n\
                        fn function_zeta() -> usize { 6 }\n\
                        fn function_eta() -> usize { 7 }\n\
                        fn main_entrypoint_for_truncation_test() {}\n";
        assert!(original.len() >= 200, "test fixture must clear the 200-byte floor; got {} bytes", original.len());
        let edited      = "fn function_alpha() -> usize { 1 }\n";
        let err         = validate_and_repair(original, edited, "fix").unwrap_err();
        assert!(matches!(err, RepairError::Truncated { .. }), "got {err:?}");
    }

    #[test]
    fn validate_and_repair_skips_truncation_for_small_files() {
        let original    = "let x = 1;\nlet y = 2;\n";
        let edited      = "let x = 1;\n";
        // Small original → truncation detection skipped. The result
        // should pass through (50% size, but file is tiny).
        let repaired    = validate_and_repair(original, edited, "remove y").unwrap();
        assert_eq!(repaired.edited_file, "let x = 1;\n");
    }

    #[test]
    fn validate_and_repair_rejects_full_rewrite_without_intent() {
        let original = (1..=12).map(|i| format!("alpha_{i}_line")).collect::<Vec<_>>().join("\n");
        let edited   = (1..=12).map(|i| format!("beta_{i}_word")).collect::<Vec<_>>().join("\n");
        let err      = validate_and_repair(&original, &edited, "fix the bug").unwrap_err();
        assert_eq!(err, RepairError::FullRewriteSuspicious);
    }

    #[test]
    fn validate_and_repair_allows_full_rewrite_with_intent() {
        let original = (1..=12).map(|i| format!("alpha_{i}_line")).collect::<Vec<_>>().join("\n");
        let edited   = (1..=12).map(|i| format!("beta_{i}_word")).collect::<Vec<_>>().join("\n");
        let repaired = validate_and_repair(&original, &edited, "please rewrite this entirely")
            .expect("rewrite intent should bypass full-rewrite guard");
        assert!(!repaired.edited_file.is_empty());
    }

    #[test]
    fn validate_and_repair_rejects_partial_chatml_in_body() {
        let original = "fn one() { 1 }\nfn two() { 2 }\nfn three() { 3 }\n";
        // ChatML marker emitted MID-content, far from the trailing 16 bytes.
        let edited   = "fn one() { 1 }\n<|im_end|>\nfn two() { 2 }\nfn three() { 3 }\n\
                        // padding line to push the marker outside the trailing slice\n\
                        // more padding so the body slice contains the marker\n";
        let err      = validate_and_repair(original, edited, "fix").unwrap_err();
        assert_eq!(err, RepairError::PartialChatMLEmission);
    }

    #[test]
    fn validate_and_repair_rejects_empty_output() {
        let err = validate_and_repair("fn main() {}\n", "   \n  ", "fix").unwrap_err();
        assert_eq!(err, RepairError::EmptyOutput);
    }

    #[test]
    fn instruction_allows_rewrite_is_case_insensitive() {
        assert!(instruction_allows_rewrite("Please REWRITE the entire file"));
        assert!(instruction_allows_rewrite("rewrite this from scratch"));
        assert!(!instruction_allows_rewrite("fix the off-by-one"));
    }
}
