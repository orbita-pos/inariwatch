//! FIM (Fill-in-the-Middle) prompt construction for Qwen2.5-Coder.
//!
//! Sesión 23 wires `textDocument/completion` to `LocalAI::generate` with
//! `fim_mode = true`. S21 plumbed the flag through the facade but
//! intentionally did NOT wrap the prompt — that's this module's job.
//!
//! ## Tokens
//!
//! Qwen2.5-Coder's tokenizer recognises three FIM control tokens:
//!
//! ```text
//! <|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
//! ```
//!
//! The `INARI_LIVE_V0_2_HANDOFF.md` § Sesión 23 prose uses the
//! fullwidth pipe `｜` (U+FF5C) as a typographic flourish; the tokens
//! the model actually expects use the **ASCII** pipe `|`. See
//! `INARI_LIVE_DECISIONS.md` 2026-05-01 § Sesión 23 for the
//! reconciliation.
//!
//! ## Context window
//!
//! S23 ships a naive ±N-line slice: `cursor's line ± N` lines, sliced
//! at the cursor's byte offset. S24 replaces this with indexer-aware
//! context selection (top-3 relevant symbols prepended, per-language
//! tuned) — see HANDOFF § Sesión 24.

const FIM_PREFIX_OPEN: &str = "<|fim_prefix|>";
const FIM_SUFFIX_OPEN: &str = "<|fim_suffix|>";
const FIM_MIDDLE_OPEN: &str = "<|fim_middle|>";

/// Default context window. The HANDOFF spec locks ±200 lines for S23.
pub const DEFAULT_CONTEXT_LINES: usize = 200;

/// Wrap `prefix` + `suffix` with Qwen2.5-Coder's FIM control tokens.
///
/// Pure string concat — no parsing, no escaping. The tokens are
/// reserved by the GGUF tokenizer; the model treats anything between
/// them as the prefix/suffix verbatim.
pub fn build_fim_prompt(prefix: &str, suffix: &str) -> String {
    let mut s = String::with_capacity(
        FIM_PREFIX_OPEN.len()
            + prefix.len()
            + FIM_SUFFIX_OPEN.len()
            + suffix.len()
            + FIM_MIDDLE_OPEN.len(),
    );
    s.push_str(FIM_PREFIX_OPEN);
    s.push_str(prefix);
    s.push_str(FIM_SUFFIX_OPEN);
    s.push_str(suffix);
    s.push_str(FIM_MIDDLE_OPEN);
    s
}

/// Slice `±lines_each_side` lines around the cursor at `byte_offset`
/// inside `text`. Returns `(prefix, suffix)` — `prefix` is the bytes
/// from the start of `cursor.line - N` up to the cursor; `suffix` is
/// the bytes from the cursor through the end of `cursor.line + N`.
///
/// Out-of-range `byte_offset` clamps to `[0, text.len()]`.
///
/// TODO(S24): replace with indexer-aware context selection (top-3
/// relevant symbols + per-language tuning).
pub fn extract_context(
    text: &str,
    byte_offset: usize,
    lines_each_side: usize,
) -> (String, String) {
    if text.is_empty() {
        return (String::new(), String::new());
    }
    let cursor = byte_offset.min(text.len());

    // Index of every line-start byte. `line_starts[0] == 0` always; a
    // newline at byte i pushes a start of (i + 1). Final entry may be
    // == text.len() if the document ends with a trailing newline (an
    // empty trailing line) — that's harmless for the slicing math.
    let mut line_starts: Vec<usize> = Vec::with_capacity(64);
    line_starts.push(0);
    for (i, b) in text.as_bytes().iter().enumerate() {
        if *b == b'\n' {
            line_starts.push(i + 1);
        }
    }

    // Cursor's line index. `binary_search(&cursor)` returns Ok(i) when
    // cursor lands exactly on a line-start; Err(i) otherwise (i is
    // where cursor WOULD be inserted, so cursor's line == i - 1).
    let cursor_line = match line_starts.binary_search(&cursor) {
        Ok(i)  => i,
        Err(i) => i.saturating_sub(1),
    };
    let last_line = line_starts.len().saturating_sub(1);

    let start_line = cursor_line.saturating_sub(lines_each_side);
    let end_line   = (cursor_line + lines_each_side).min(last_line);

    let prefix_start = line_starts[start_line];
    let suffix_end = if end_line + 1 < line_starts.len() {
        line_starts[end_line + 1]
    } else {
        text.len()
    };

    let prefix = text[prefix_start..cursor].to_string();
    let suffix = text[cursor..suffix_end].to_string();
    (prefix, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_sandwiches_with_qwen_tokens() {
        let s = build_fim_prompt("fn add(a, b) {\n  ", "\n}\n");
        assert!(s.starts_with("<|fim_prefix|>"));
        assert!(s.contains("<|fim_suffix|>"));
        assert!(s.ends_with("<|fim_middle|>"));
        let prefix_start = s.find("<|fim_prefix|>").unwrap() + "<|fim_prefix|>".len();
        let suffix_open  = s.find("<|fim_suffix|>").unwrap();
        assert_eq!(&s[prefix_start..suffix_open], "fn add(a, b) {\n  ");
    }

    #[test]
    fn build_prompt_handles_empty_inputs() {
        let s = build_fim_prompt("", "");
        assert_eq!(s, "<|fim_prefix|><|fim_suffix|><|fim_middle|>");
    }

    #[test]
    fn extract_context_empty_text() {
        let (p, s) = extract_context("", 0, 200);
        assert_eq!(p, "");
        assert_eq!(s, "");
    }

    #[test]
    fn extract_context_clamps_byte_offset() {
        let text = "let x = 1;";
        let (p, s) = extract_context(text, 9999, 200);
        assert_eq!(p, "let x = 1;");
        assert_eq!(s, "");
    }

    #[test]
    fn extract_context_slices_n_lines_each_side() {
        // 6 lines. Cursor at start of line 3 ("d"). N = 2.
        let text   = "a\nb\nc\nd\ne\nf";
        let cursor = text.find('d').unwrap();
        let (p, s) = extract_context(text, cursor, 2);
        // prefix = lines (cursor_line - 2) .. cursor
        assert_eq!(p, "b\nc\n");
        // suffix = cursor .. end-of-(cursor_line + 2). Last line "f"
        // has no trailing newline, so suffix runs to end of text.
        assert_eq!(s, "d\ne\nf");
    }

    #[test]
    fn extract_context_clamps_to_doc_edges() {
        let text   = "a\nb\nc";
        let cursor = text.find('b').unwrap();
        let (p, s) = extract_context(text, cursor, 200);
        assert_eq!(p, "a\n");
        assert_eq!(s, "b\nc");
    }

    #[test]
    fn extract_context_zero_lines_keeps_cursor_line_only() {
        let text   = "a\nb\nc";
        let cursor = text.find('b').unwrap();
        let (p, s) = extract_context(text, cursor, 0);
        // Prefix is empty (cursor sits at column 0 of its line).
        assert_eq!(p, "");
        // Suffix is the cursor's own line up to (but not including)
        // the next line's start — i.e. through the trailing newline.
        assert_eq!(s, "b\n");
    }

    #[test]
    fn extract_context_mid_line_cursor_keeps_both_sides() {
        // cursor in the middle of line "let x = 1;".
        let text   = "fn main() {\n    let x = 1;\n}\n";
        let cursor = text.find("= 1").unwrap() + 2; // just before '1'
        let (p, s) = extract_context(text, cursor, 200);
        assert!(p.ends_with("= "));
        assert!(s.starts_with("1;\n"));
    }

    #[test]
    fn build_prompt_with_extract_round_trip() {
        let text   = "fn main() {\n    let x = ;\n}\n";
        let cursor = text.find(';').unwrap();
        let (p, s) = extract_context(text, cursor, 200);
        let prompt = build_fim_prompt(&p, &s);
        assert!(prompt.contains("fn main() {"));
        assert!(prompt.contains("<|fim_middle|>"));
        // Cursor's split is preserved between fim_prefix and fim_suffix.
        let pre_idx = prompt.find("<|fim_prefix|>").unwrap() + "<|fim_prefix|>".len();
        let suf_idx = prompt.find("<|fim_suffix|>").unwrap();
        let mid_idx = prompt.find("<|fim_middle|>").unwrap();
        assert_eq!(&prompt[pre_idx..suf_idx], &p);
        assert_eq!(&prompt[(suf_idx + "<|fim_suffix|>".len())..mid_idx], &s);
    }
}
