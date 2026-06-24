//! Language detection + tree-sitter Language plumbing.
//!
//! Inari Live indexes 5 languages today. Adding a sixth means adding a
//! variant here, a tree-sitter grammar dep in `Cargo.toml`, an arm in
//! [`tree_sitter_language`], and the matching extraction queries in
//! `parser.rs`. Files outside the supported set are silently skipped
//! (no error) so the indexer doesn't drown logs on a polyglot repo.

use std::path::Path;

use tree_sitter::Language;

/// One of the 5 languages we extract symbols from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    TypeScript,
    JavaScript,
    Python,
    Rust,
    Go,
}

impl Lang {
    /// Human-readable label, matches what `code_symbols.kind` consumers
    /// log + what the dock surfaces.
    pub fn name(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Python     => "python",
            Self::Rust       => "rust",
            Self::Go         => "go",
        }
    }
}

/// Detect language from a path's extension. Returns `None` for any
/// extension we don't have a grammar for — caller skips the file.
pub fn detect_from_path(path: &Path) -> Option<Lang> {
    // Match on extension only: shebang detection requires reading the
    // file, which the caller is about to do anyway. If we miss
    // extension-less scripts in v0.1, that's fine.
    let ext = path.extension().and_then(|s| s.to_str())?;
    match ext {
        "ts"  | "tsx"        => Some(Lang::TypeScript),
        "js"  | "jsx"
            | "mjs" | "cjs"  => Some(Lang::JavaScript),
        "py"                 => Some(Lang::Python),
        "rs"                 => Some(Lang::Rust),
        "go"                 => Some(Lang::Go),
        _                    => None,
    }
}

/// Map `Lang` to its tree-sitter `Language`. Each grammar crate ships
/// a `language()` (or `language_*()` for multi-grammar crates like
/// `tree-sitter-typescript`, which exposes `language_typescript()`
/// + `language_tsx()`). v0.1 uses the TypeScript grammar for both
/// `.ts` and `.tsx` — the TSX grammar is a strict superset for
/// extraction purposes; the loss of fidelity is irrelevant for
/// symbol detection.
pub fn tree_sitter_language(lang: Lang) -> Language {
    match lang {
        Lang::TypeScript => tree_sitter_typescript::language_typescript(),
        Lang::JavaScript => tree_sitter_javascript::language(),
        Lang::Python     => tree_sitter_python::language(),
        Lang::Rust       => tree_sitter_rust::language(),
        Lang::Go         => tree_sitter_go::language(),
    }
}
