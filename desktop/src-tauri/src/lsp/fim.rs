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
//! S23 shipped a naive ±200-line slice. **S24 layers indexer-aware
//! context selection on top** ([`build_context_for_completion`]):
//!
//! 1. Local prefix/suffix is still the ±N-line slice ([`extract_context`]).
//! 2. The indexer's tree-sitter parser ([`crate::indexer::parser`]) walks
//!    the open document and pulls top-level symbols (functions, classes,
//!    interfaces, structs, type aliases, traits).
//! 3. The top-3 most relevant symbols (see [`rank_symbols`]) plus the
//!    file's import block are condensed into a header that gets prepended
//!    to the local prefix.
//! 4. The combined `(header + local_prefix, local_suffix)` is fed to
//!    [`build_fim_prompt`] — its API contract is unchanged.
//!
//! Per-language tuning lives in [`SymbolFilter`]: TS/JS prioritise
//! imports + interface/type defs, Python prioritises class defs +
//! helpers, Rust prioritises trait/struct + impls, Go prioritises
//! interface/struct defs.

use crate::indexer::lang::Lang;
use crate::indexer::parser::{parse_file, Symbol, SymbolKind};

const FIM_PREFIX_OPEN: &str = "<|fim_prefix|>";
const FIM_SUFFIX_OPEN: &str = "<|fim_suffix|>";
const FIM_MIDDLE_OPEN: &str = "<|fim_middle|>";

/// Default context window for the local ±N-line slice. The HANDOFF
/// spec locks ±200 lines; S24 keeps that for the local slice and
/// PREPENDS the indexer-derived symbol header.
pub const DEFAULT_CONTEXT_LINES: usize = 200;

/// Top-K symbols pulled from the indexer header. Higher than 3 hits
/// the model's context budget on Qwen-1.5B (4 k tokens); lower loses
/// useful structural context. 3 is the sweet spot from the HANDOFF.
pub const SYMBOLS_PER_HEADER: usize = 3;

/// How many leading source lines we treat as the file's import / use
/// block. Walking the parser is overkill for a header summary — the
/// import block is conventionally at the top of the file in every
/// supported language.
const IMPORT_BLOCK_HEAD_LINES: usize = 25;

/// Per-language `n_predict` budget. Tab completions are short by
/// nature; Python wants slightly more for block bodies (4-space
/// indented multi-line completions are common), Rust wants slightly
/// less for one-line expression completions.
pub fn max_tokens_for_lang(lang: Option<Lang>) -> u32 {
    match lang {
        Some(Lang::Python)               => 96,
        Some(Lang::Go)                   => 80,
        Some(Lang::TypeScript)
            | Some(Lang::JavaScript)     => 64,
        Some(Lang::Rust)                 => 48,
        None                             => 64,
    }
}

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

// ─────────────────────────────────────────────────────────────────────
// S24 — indexer-aware context selection.
// ─────────────────────────────────────────────────────────────────────

/// Per-language priority filter. Earlier `SymbolKind`s are preferred
/// when ranking. The list is intentionally small and ordered: the
/// ranker walks it in order and breaks ties by proximity-to-cursor +
/// name-mentioned-in-prefix.
struct SymbolFilter {
    /// Prefer these kinds, in priority order.
    priorities: &'static [SymbolKind],
}

impl SymbolFilter {
    fn for_lang(lang: Lang) -> Self {
        // Per-language tuning — see HANDOFF § Sesión 24 step 1.
        let priorities: &'static [SymbolKind] = match lang {
            Lang::TypeScript | Lang::JavaScript => &[
                SymbolKind::Interface, // export interface User { … }
                SymbolKind::Type,      // type Id = string
                SymbolKind::Class,
                SymbolKind::Function,
            ],
            Lang::Python => &[
                SymbolKind::Class,
                SymbolKind::Function, // helpers + module-level fns
            ],
            Lang::Rust => &[
                SymbolKind::Interface, // trait
                SymbolKind::Struct,
                SymbolKind::Type,
                SymbolKind::Enum,
                SymbolKind::Function,
            ],
            Lang::Go => &[
                SymbolKind::Interface,
                SymbolKind::Struct,
                SymbolKind::Type,
                SymbolKind::Function,
            ],
        };
        Self { priorities }
    }

    /// Rank score for `kind`. Lower = preferred. Returns `usize::MAX`
    /// for kinds outside this language's priority list.
    fn rank_kind(&self, kind: SymbolKind) -> usize {
        self.priorities
            .iter()
            .position(|&k| k == kind)
            .unwrap_or(usize::MAX)
    }
}

/// Score a symbol relative to the cursor. Lower = more relevant.
///
/// Tie-break order (low → high):
///   1. Per-language kind priority — interface defs beat function
///      defs in TS, etc.
///   2. Name appears verbatim in `prefix_text` — the user is likely
///      typing against this symbol → strong relevance bonus.
///   3. Distance to cursor in lines — closer beats farther.
fn symbol_score(
    sym:         &Symbol,
    cursor_line: u32,
    prefix_text: &str,
    filter:      &SymbolFilter,
) -> u64 {
    let kind_rank        = filter.rank_kind(sym.kind) as u64;
    let mentioned: u64   = if !sym.name.is_empty() && prefix_text.contains(sym.name.as_str()) {
        0
    } else {
        1
    };
    let distance    = (sym.line_start as i64 - cursor_line as i64).unsigned_abs();
    // Pack: kind dominates (×10_000_000), mention is the next bit
    // (×1_000_000), distance breaks remaining ties (capped at 1M
    // lines — a doc that big is theoretical).
    kind_rank.saturating_mul(10_000_000)
        + mentioned.saturating_mul(1_000_000)
        + distance.min(1_000_000 - 1)
}

/// Pick the top-K symbols for the indexer-aware header. Pure ranking,
/// no formatting — returns the `Symbol`s themselves so the formatter
/// can decide truncation strategy.
pub fn rank_symbols(
    symbols:     &[Symbol],
    cursor_line: u32,
    prefix_text: &str,
    lang:        Lang,
    k:           usize,
) -> Vec<Symbol> {
    let filter = SymbolFilter::for_lang(lang);
    let mut scored: Vec<(u64, Symbol)> = symbols
        .iter()
        .filter(|s| filter.rank_kind(s.kind) != usize::MAX)
        // Drop symbols that ENCLOSE the cursor — those are what the
        // user is currently editing and would just bloat the header
        // with a copy of the local prefix.
        .filter(|s| !(cursor_line >= s.line_start && cursor_line <= s.line_end))
        .map(|s| (symbol_score(s, cursor_line, prefix_text, &filter), s.clone()))
        .collect();
    scored.sort_by_key(|(score, _)| *score);
    scored.into_iter().take(k).map(|(_, s)| s).collect()
}

/// Render the top-K symbols + the import block as a comment-style
/// header. Each symbol is truncated to `signature_lines` lines so the
/// header stays compact.
fn render_symbol_header(
    symbols:         &[Symbol],
    import_block:    &str,
    lang:            Lang,
    signature_lines: usize,
) -> String {
    let comment_open = comment_token_for(lang);
    let mut out = String::new();

    if !import_block.trim().is_empty() {
        // Keep the import block verbatim — it's already in source form
        // and the model prefers seeing real imports over a paraphrase.
        out.push_str(import_block);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(comment_open);
        out.push_str(" ─── relevant context ───\n");
    } else if !symbols.is_empty() {
        out.push_str(comment_open);
        out.push_str(" ─── relevant context ───\n");
    }

    for sym in symbols {
        // Truncate the symbol's source to its first N lines (the
        // signature + opening brace, typically). This keeps the header
        // compact while still letting the model see the public shape.
        let truncated: String = sym.source_text
            .lines()
            .take(signature_lines.max(1))
            .collect::<Vec<_>>()
            .join("\n");
        out.push_str(&truncated);
        if !truncated.ends_with('\n') {
            out.push('\n');
        }
    }
    if !symbols.is_empty() || !import_block.trim().is_empty() {
        out.push('\n'); // visual separator before the local slice
    }
    out
}

fn comment_token_for(lang: Lang) -> &'static str {
    match lang {
        Lang::Python                   => "#",
        Lang::Go                       => "//",
        Lang::Rust                     => "//",
        Lang::TypeScript | Lang::JavaScript => "//",
    }
}

/// Extract the leading import block. We do not fully parse it — we
/// take the first contiguous run of lines that look like imports (per
/// language) and stop at the first blank line OR the first
/// non-import-shaped line, capped at [`IMPORT_BLOCK_HEAD_LINES`].
fn extract_import_block(text: &str, lang: Lang) -> String {
    let mut out = String::new();
    let mut taken = 0usize;
    for line in text.lines().take(IMPORT_BLOCK_HEAD_LINES) {
        let trimmed = line.trim_start();
        let is_import = looks_like_import(lang, trimmed);
        let is_blank  = trimmed.is_empty();
        let is_comment = is_comment_line(lang, trimmed);
        if is_import {
            out.push_str(line);
            out.push('\n');
            taken += 1;
        } else if is_blank || is_comment {
            // skip blank / comment lines inside the leading block
            if taken > 0 {
                // preserve a trailing blank inside the import block
                if is_blank {
                    out.push('\n');
                }
            }
        } else {
            break;
        }
    }
    out
}

fn looks_like_import(lang: Lang, line: &str) -> bool {
    match lang {
        Lang::TypeScript | Lang::JavaScript => {
            line.starts_with("import ")
                || line.starts_with("export ")  // re-exports
                || line.starts_with("const ") && line.contains("require(")
        }
        Lang::Python => {
            line.starts_with("import ") || line.starts_with("from ")
        }
        Lang::Rust => {
            line.starts_with("use ") || line.starts_with("extern crate ")
        }
        Lang::Go => {
            line.starts_with("import ")
                || line.starts_with("package ")
                || (line.starts_with('"') && !line.contains(' '))
                || line == "("
                || line == ")"
        }
    }
}

fn is_comment_line(lang: Lang, line: &str) -> bool {
    match lang {
        Lang::Python                              => line.starts_with('#'),
        Lang::TypeScript
            | Lang::JavaScript
            | Lang::Rust
            | Lang::Go                            => line.starts_with("//") || line.starts_with("/*"),
    }
}

/// One-shot helper: build the `(prefix, suffix)` pair to feed
/// [`build_fim_prompt`]. Falls back to the S23 ±N-line slice when:
///   * `lang` is `None` (unknown languageId)
///   * the parser fails or returns no symbols
///   * the import block is empty AND no relevant symbols rank above
///     the per-language priority floor.
///
/// The contract is identical to [`extract_context`] from S23 — same
/// `(prefix, suffix) -> String` swap point — so the call site in
/// `handlers/completion.rs` does not change shape.
pub fn build_context_for_completion(
    text:             &str,
    byte_offset:      usize,
    lines_each_side:  usize,
    lang:             Option<Lang>,
) -> (String, String) {
    let (local_prefix, local_suffix) = extract_context(text, byte_offset, lines_each_side);

    let Some(lang) = lang else { return (local_prefix, local_suffix) };

    let symbols = match parse_file(lang, text) {
        Ok(v) if !v.is_empty() => v,
        _                       => return (local_prefix, local_suffix),
    };

    // Cursor's line (1-indexed to match Symbol::line_start).
    let cursor_line = {
        let cursor = byte_offset.min(text.len());
        let prefix_bytes = &text.as_bytes()[..cursor];
        prefix_bytes.iter().filter(|b| **b == b'\n').count() as u32 + 1
    };

    let import_block = extract_import_block(text, lang);
    let top = rank_symbols(&symbols, cursor_line, &local_prefix, lang, SYMBOLS_PER_HEADER);

    if top.is_empty() && import_block.trim().is_empty() {
        return (local_prefix, local_suffix);
    }

    let header = render_symbol_header(&top, &import_block, lang, 5);
    let combined_prefix = format!("{header}{local_prefix}");
    (combined_prefix, local_suffix)
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

    // ── S24 — context selection ───────────────────────────────────────

    #[test]
    fn max_tokens_per_lang_matches_handoff() {
        assert_eq!(max_tokens_for_lang(Some(Lang::Python)),     96);
        assert_eq!(max_tokens_for_lang(Some(Lang::Rust)),       48);
        assert_eq!(max_tokens_for_lang(Some(Lang::TypeScript)), 64);
        assert_eq!(max_tokens_for_lang(Some(Lang::Go)),         80);
        assert_eq!(max_tokens_for_lang(None),                   64);
    }

    #[test]
    fn build_context_falls_back_when_lang_unknown() {
        let text   = "fn main() {\n    let x = ;\n}\n";
        let cursor = text.find(';').unwrap();
        let (p, s) = build_context_for_completion(text, cursor, 200, None);
        let (raw_p, raw_s) = extract_context(text, cursor, 200);
        assert_eq!(p, raw_p);
        assert_eq!(s, raw_s);
    }

    #[test]
    fn build_context_prepends_imports_for_typescript() {
        let text = "\
import { User } from \"./user\";
import { fetch } from \"./http\";

interface Profile {
  id: string;
  user: User;
}

function load() {

}
";
        let cursor = text.find("    \n}").unwrap() + 4;
        let (prefix, _suffix) =
            build_context_for_completion(text, cursor, 200, Some(Lang::TypeScript));
        assert!(prefix.contains("import { User }"));
        assert!(prefix.contains("import { fetch }"));
        // Local prefix at the cursor still arrives intact.
        assert!(prefix.contains("function load() {"));
    }

    #[test]
    fn rank_symbols_prioritises_kind_then_proximity() {
        // Two interfaces on either side of the cursor; closer one wins.
        let text = "\
interface Far {}
function pad1() {}
function pad2() {}
function pad3() {}
function pad4() {}
function pad5() {}
function pad6() {}
function here() {

}
interface Near {}
";
        let cursor_line = text.lines().position(|l| l.trim().is_empty()).unwrap() as u32 + 1;
        let symbols = parse_file(Lang::TypeScript, text).unwrap();
        let top = rank_symbols(&symbols, cursor_line, "", Lang::TypeScript, 1);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].kind, SymbolKind::Interface);
        assert_eq!(top[0].name, "Near", "closer interface should win on proximity tie");
    }

    #[test]
    fn rank_symbols_skips_enclosing_function() {
        let text = "\
fn helper() {
    let x = 1;
}

fn main() {

}
";
        let cursor_line = text.lines().position(|l| l == "    " || l.is_empty()).unwrap() as u32 + 1;
        // Cursor sits inside `main`. The ranker should not return
        // `main` itself — only the *other* relevant symbol(s).
        let syms = parse_file(Lang::Rust, text).unwrap();
        let top = rank_symbols(&syms, cursor_line, "", Lang::Rust, 3);
        assert!(top.iter().all(|s| s.name != "main"));
        assert!(top.iter().any(|s| s.name == "helper"));
    }
}
