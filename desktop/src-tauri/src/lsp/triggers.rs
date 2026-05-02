//! Smart triggers — Sesión 24.
//!
//! The S23 completion handler always fired a FIM call. That feels
//! ROBOTIC in real editors: completions popping up inside string
//! literals, mid-comment, in the middle of an identifier the user is
//! still typing, or inside `import { ... }` blocks where the editor's
//! native popup is more useful than ghost-text.
//!
//! `should_trigger` runs BEFORE the LocalAI call (and before the cache
//! lookup) and returns `false` when the cursor is in one of the
//! suppression contexts. The handler returns an empty completion list
//! in that case — same silent-degradation contract as every other S23
//! error path (see `INARI_LIVE_DECISIONS.md` 2026-05-01 § Sesión 23
//! "LSP completion failures degrade to empty list").
//!
//! ## Detection strategy
//!
//! * **Mid-word** — pure byte inspection of the surrounding ASCII
//!   identifier characters (`[A-Za-z0-9_]`). Cheap, language-agnostic.
//! * **String / comment / import** — tree-sitter parses the document,
//!   then `descendant_for_byte_range(byte_offset, byte_offset)` returns
//!   the deepest node enclosing the cursor; we walk the ancestor chain
//!   and bail on any node kind that matches the suppression set for
//!   the document's language.
//!
//! Tree-sitter parses are fast (~1-3 ms on a 4 MB document, well under
//! S24's 250 ms budget) and the indexer (Sesión 6) already pulls in
//! the 5 grammar crates we need.
//!
//! Files in unrecognised languages skip the AST checks entirely — we
//! only suppress on mid-word. That keeps Tab firing on plain-text /
//! markdown / unknown extensions where the user might want a
//! best-effort completion anyway.

use tree_sitter::{Node, Parser};

use crate::indexer::lang::{tree_sitter_language, Lang};

/// Map an LSP `languageId` (lowercase) to our [`Lang`] enum. Returns
/// `None` for any language we don't have a tree-sitter grammar for —
/// callers fall back to mid-word-only suppression.
pub fn lang_for_id(language_id: &str) -> Option<Lang> {
    match language_id {
        "typescript" | "typescriptreact" => Some(Lang::TypeScript),
        "javascript" | "javascriptreact" => Some(Lang::JavaScript),
        "python"                         => Some(Lang::Python),
        "rust"                           => Some(Lang::Rust),
        "go"                             => Some(Lang::Go),
        _                                => None,
    }
}

/// Decide whether to fire a completion at `byte_offset` inside `text`.
///
/// `language_id` is the LSP `languageId` from `didOpen` (lowercase).
/// `None` means "we don't know" → permissive, only mid-word is
/// suppressed.
///
/// Returns `true` to fire, `false` to suppress.
pub fn should_trigger(
    language_id: Option<&str>,
    text:        &str,
    byte_offset: usize,
) -> bool {
    if is_mid_word(text, byte_offset) {
        return false;
    }
    let Some(lang_id) = language_id else { return true };
    let Some(lang)    = lang_for_id(lang_id) else { return true };

    !is_in_suppression_context(lang, text, byte_offset)
}

/// Cursor sits between two identifier characters, e.g. `add|er`. The
/// check is intentionally ASCII-only — non-ASCII identifier characters
/// (Cyrillic, CJK) reach the parser-based path which uses tree-sitter's
/// `identifier` node handling correctly. The mid-word fast-path is just
/// a cheap "no, definitely not here" filter for the common case.
fn is_mid_word(text: &str, byte_offset: usize) -> bool {
    let bytes = text.as_bytes();
    if byte_offset == 0 || byte_offset >= bytes.len() {
        return false;
    }
    is_ident_byte(bytes[byte_offset - 1]) && is_ident_byte(bytes[byte_offset])
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Parse `text` and walk the AST node chain enclosing `byte_offset`,
/// returning `true` if any ancestor matches the per-language
/// suppression set.
fn is_in_suppression_context(lang: Lang, text: &str, byte_offset: usize) -> bool {
    let mut parser = Parser::new();
    if parser.set_language(&tree_sitter_language(lang)).is_err() {
        return false;
    }
    let Some(tree) = parser.parse(text, None) else { return false };
    let root = tree.root_node();

    // Tree-sitter's `descendant_for_byte_range` may return the root
    // when the offset is past EOF. Clamp defensively.
    let off = byte_offset.min(text.len());
    let Some(node) = root.descendant_for_byte_range(off, off) else { return false };

    let mut cur: Option<Node> = Some(node);
    while let Some(n) = cur {
        if matches_suppression(lang, n.kind()) {
            return true;
        }
        cur = n.parent();
    }
    false
}

/// Per-language node-kind set we suppress on. Kept as a flat match so
/// adding a kind for one language is a one-line edit; missing a kind
/// degrades to "we fire" rather than panicking.
fn matches_suppression(lang: Lang, kind: &str) -> bool {
    match (lang, kind) {
        // ── TypeScript / JavaScript ─────────────────────────────────
        (Lang::TypeScript, "string"
            | "string_fragment"
            | "template_string"
            | "template_substitution_open"  // unlikely but harmless
            | "regex"
            | "regex_pattern"
            | "comment"
            | "import_statement"
            | "import_clause"
            | "named_imports"
            | "namespace_import"
            | "import_specifier") => true,
        (Lang::JavaScript, "string"
            | "string_fragment"
            | "template_string"
            | "regex"
            | "regex_pattern"
            | "comment"
            | "import_statement"
            | "import_clause"
            | "named_imports"
            | "namespace_import"
            | "import_specifier") => true,

        // ── Python ──────────────────────────────────────────────────
        // `dotted_name` is intentionally NOT in the suppression set —
        // it matches both `import a.b.c` AND `obj.attr` access, so
        // suppressing on it would block legitimate completions on
        // attribute chains. The `import_statement` /
        // `import_from_statement` ancestor walks already catch the
        // import-block case via the parent chain.
        (Lang::Python, "string"
            | "string_content"
            | "concatenated_string"
            | "comment"
            | "import_statement"
            | "import_from_statement") => true,

        // ── Rust ────────────────────────────────────────────────────
        (Lang::Rust, "string_literal"
            | "raw_string_literal"
            | "char_literal"
            | "byte_string_literal"
            | "line_comment"
            | "block_comment"
            | "use_declaration"
            | "use_list"
            | "scoped_use_list") => true,

        // ── Go ──────────────────────────────────────────────────────
        (Lang::Go, "interpreted_string_literal"
            | "raw_string_literal"
            | "rune_literal"
            | "comment"
            | "import_declaration"
            | "import_spec"
            | "import_spec_list") => true,

        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Mid-word ──────────────────────────────────────────────────────

    #[test]
    fn mid_word_between_letters_suppresses() {
        let text   = "let adder = 1;";
        let cursor = text.find('d').unwrap() + 1; // between "ad" and "der"
        assert!(!should_trigger(None, text, cursor));
    }

    #[test]
    fn cursor_after_identifier_is_not_mid_word() {
        let text   = "let add = 1;";
        let cursor = text.find('d').unwrap() + 2; // after "add", before " "
        assert!(should_trigger(None, text, cursor));
    }

    #[test]
    fn cursor_before_identifier_is_not_mid_word() {
        let text   = " adder";
        let cursor = 0;
        assert!(should_trigger(None, text, cursor));
    }

    #[test]
    fn cursor_at_end_of_buffer_is_not_mid_word() {
        let text   = "let x";
        let cursor = text.len();
        assert!(should_trigger(None, text, cursor));
    }

    // ── String literals ───────────────────────────────────────────────

    #[test]
    fn ts_inside_double_quoted_string_suppresses() {
        let text   = "const x = \"hello \";";
        let cursor = text.find("\"hello").unwrap() + 7; // inside, after "hello "
        assert!(!should_trigger(Some("typescript"), text, cursor));
    }

    #[test]
    fn ts_inside_template_literal_suppresses() {
        let text   = "const x = `hello ${name}`;";
        let cursor = text.find("hello").unwrap() + 6; // inside template
        assert!(!should_trigger(Some("typescript"), text, cursor));
    }

    #[test]
    fn rust_inside_string_literal_suppresses() {
        let text   = "fn main() { let s = \"hello world\"; }";
        let cursor = text.find("hello").unwrap() + 6;
        assert!(!should_trigger(Some("rust"), text, cursor));
    }

    #[test]
    fn python_inside_triple_string_suppresses() {
        let text   = "def f():\n    s = \"\"\"hello world\"\"\"\n";
        let cursor = text.find("hello").unwrap() + 6;
        assert!(!should_trigger(Some("python"), text, cursor));
    }

    #[test]
    fn go_inside_string_suppresses() {
        let text   = "package main\nfunc f() { s := \"hello world\" }\n";
        let cursor = text.find("hello").unwrap() + 6;
        assert!(!should_trigger(Some("go"), text, cursor));
    }

    // ── Comments ──────────────────────────────────────────────────────

    #[test]
    fn ts_inside_line_comment_suppresses() {
        let text   = "// TODO: implement \nconst x = 1;";
        let cursor = text.find("implement").unwrap() + 9;
        assert!(!should_trigger(Some("typescript"), text, cursor));
    }

    #[test]
    fn ts_inside_block_comment_suppresses() {
        let text   = "/* multi-line\n   comment block\n*/\n";
        let cursor = text.find("comment").unwrap() + 7;
        assert!(!should_trigger(Some("typescript"), text, cursor));
    }

    #[test]
    fn rust_inside_line_comment_suppresses() {
        let text   = "fn main() {\n    // TODO finish \n}\n";
        let cursor = text.find("TODO").unwrap() + 5;
        assert!(!should_trigger(Some("rust"), text, cursor));
    }

    #[test]
    fn rust_inside_block_comment_suppresses() {
        let text   = "/* a\n   b\n   c\n*/\nfn x() {}\n";
        let cursor = text.find("b\n").unwrap() + 1;
        assert!(!should_trigger(Some("rust"), text, cursor));
    }

    #[test]
    fn python_inside_line_comment_suppresses() {
        let text   = "x = 1\n# todo \ny = 2\n";
        let cursor = text.find("todo").unwrap() + 4;
        assert!(!should_trigger(Some("python"), text, cursor));
    }

    #[test]
    fn go_inside_line_comment_suppresses() {
        let text   = "package main\n// trailing comment \nfunc f() {}\n";
        let cursor = text.find("trailing").unwrap() + 8;
        assert!(!should_trigger(Some("go"), text, cursor));
    }

    // ── Import blocks ────────────────────────────────────────────────

    #[test]
    fn ts_inside_named_imports_suppresses() {
        let text   = "import { foo, bar } from \"./baz\";\nconst x = 1;\n";
        let cursor = text.find("bar").unwrap() + 3;
        assert!(!should_trigger(Some("typescript"), text, cursor));
    }

    #[test]
    fn rust_inside_use_declaration_suppresses() {
        let text   = "use std::collections::HashMap;\nfn x() {}\n";
        let cursor = text.find("HashMap").unwrap() + 7;
        assert!(!should_trigger(Some("rust"), text, cursor));
    }

    // ── Permissive cases (should fire) ────────────────────────────────

    #[test]
    fn ts_in_function_body_fires() {
        let text   = "function add(a, b) {\n    return \n}\n";
        let cursor = text.find("return ").unwrap() + 7;
        assert!(should_trigger(Some("typescript"), text, cursor));
    }

    #[test]
    fn unknown_language_only_blocks_mid_word() {
        let text   = "// looks like a comment but unknown lang\nfn x() {}";
        let cursor = text.find("comment").unwrap() + 7;
        // Without a grammar we cannot tell it's a comment → fire.
        assert!(should_trigger(Some("plaintext"), text, cursor));
    }

    #[test]
    fn empty_text_is_permissive() {
        assert!(should_trigger(Some("rust"), "", 0));
    }

    #[test]
    fn lang_for_id_recognises_aliases() {
        assert_eq!(lang_for_id("typescript"),     Some(Lang::TypeScript));
        assert_eq!(lang_for_id("typescriptreact"), Some(Lang::TypeScript));
        assert_eq!(lang_for_id("javascriptreact"), Some(Lang::JavaScript));
        assert_eq!(lang_for_id("rust"),            Some(Lang::Rust));
        assert_eq!(lang_for_id("plaintext"),       None);
    }
}
