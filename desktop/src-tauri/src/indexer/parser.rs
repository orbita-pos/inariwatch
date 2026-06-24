//! tree-sitter wrappers — extract top-level symbols (functions,
//! classes, methods, exported consts) per supported language.
//!
//! v0.1 uses node-kind matching rather than full tree-sitter Queries
//! (`.scm`) because:
//!   * we only extract a small set of "callable / type-shaped" nodes,
//!   * shipping query files means resource bundling work for Session 21,
//!   * node-kind matching is faster for the simple shapes we want.
//!
//! When the indexer needs richer semantics (call-graph edges, doc
//! strings, JSDoc tags), Session 13 is the natural place to switch
//! over to query files.

use sha2::{Digest, Sha256};
use tree_sitter::{Node, Parser};

use super::error::{IndexerError, Result};
use super::lang::{tree_sitter_language, Lang};

/// Categorical kind we persist into `code_symbols.kind`. Stays
/// stringly so adding a new language can extend the set without
/// migrating the schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Const,
    Interface,
    Struct,
    Enum,
    Type,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Function  => "function",
            Self::Method    => "method",
            Self::Class     => "class",
            Self::Const     => "const",
            Self::Interface => "interface",
            Self::Struct    => "struct",
            Self::Enum      => "enum",
            Self::Type      => "type",
        }
    }
}

/// One extracted symbol. `line_start` / `line_end` are 1-indexed for
/// human display; `source_text` is the raw substring tree-sitter
/// captured (used as the embedding input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub name:        String,
    pub kind:        SymbolKind,
    pub line_start:  u32,
    pub line_end:    u32,
    pub source_text: String,
    pub ast_hash:    String,
}

/// Parse `source` as `lang` and extract top-level symbols.
///
/// Errors are limited to "the parser refused this language" — typical
/// parse failures (broken syntax) yield ERROR nodes that we step over
/// silently. The indexer can still embed every well-formed symbol in
/// a half-broken file, which is the common case mid-edit.
pub fn parse_file(lang: Lang, source: &str) -> Result<Vec<Symbol>> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_language(lang))
        .map_err(|e| IndexerError::Parse(format!("set_language failed: {e}")))?;

    let tree = parser
        .parse(source, None)
        .ok_or_else(|| IndexerError::Parse("parser returned no tree".to_string()))?;

    let root = tree.root_node();
    let mut out: Vec<Symbol> = Vec::new();
    extract_top_level(lang, root, source.as_bytes(), &mut out);
    Ok(out)
}

fn extract_top_level(
    lang:   Lang,
    node:   Node<'_>,
    source: &[u8],
    out:    &mut Vec<Symbol>,
) {
    // For every direct child of the root, decide whether it's a
    // top-level symbol of interest. Recurse INSIDE class/struct
    // bodies so we capture methods.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(sym) = symbol_from_node(lang, child, source) {
            out.push(sym);
        }

        // Recurse into class/struct/impl/object bodies one level deep
        // for methods. Keeps the depth bounded — we don't extract
        // nested-function symbols (ESLint-style anonymous closures
        // would explode the symbol table).
        match (lang, child.kind()) {
            // TS/JS classes.
            (Lang::TypeScript, "class_declaration")
            | (Lang::JavaScript, "class_declaration") => {
                if let Some(body) = child.child_by_field_name("body") {
                    extract_methods(lang, body, source, out);
                }
            }
            // Python classes.
            (Lang::Python, "class_definition") => {
                if let Some(body) = child.child_by_field_name("body") {
                    extract_methods(lang, body, source, out);
                }
            }
            // Rust impl blocks — methods live as `function_item` inside
            // `declaration_list`.
            (Lang::Rust, "impl_item") => {
                if let Some(body) = child.child_by_field_name("body") {
                    extract_methods(lang, body, source, out);
                }
            }
            // Rust trait blocks.
            (Lang::Rust, "trait_item") => {
                if let Some(body) = child.child_by_field_name("body") {
                    extract_methods(lang, body, source, out);
                }
            }
            // Go interfaces — methods are listed inside `interface_type`.
            (Lang::Go, "type_declaration") => {
                // skim one level for embedded method specs
                let mut nc = child.walk();
                for c in child.children(&mut nc) {
                    if c.kind() == "type_spec" {
                        let mut nc2 = c.walk();
                        for c2 in c.children(&mut nc2) {
                            if c2.kind() == "interface_type" {
                                extract_methods(lang, c2, source, out);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn extract_methods(
    lang:   Lang,
    body:   Node<'_>,
    source: &[u8],
    out:    &mut Vec<Symbol>,
) {
    let mut cursor = body.walk();
    for child in body.children(&mut cursor) {
        if let Some(mut sym) = symbol_from_node(lang, child, source) {
            // Promote function-shaped nodes inside class/impl bodies
            // to Method.
            if matches!(sym.kind, SymbolKind::Function) {
                sym.kind = SymbolKind::Method;
            }
            out.push(sym);
        }
    }
}

fn symbol_from_node(
    lang:   Lang,
    node:   Node<'_>,
    source: &[u8],
) -> Option<Symbol> {
    let kind = match (lang, node.kind()) {
        // ── TypeScript ──────────────────────────────────────────────
        (Lang::TypeScript, "function_declaration")
        | (Lang::TypeScript, "method_definition")
        | (Lang::TypeScript, "method_signature")
        | (Lang::TypeScript, "function_signature")  => SymbolKind::Function,
        (Lang::TypeScript, "class_declaration")     => SymbolKind::Class,
        (Lang::TypeScript, "interface_declaration") => SymbolKind::Interface,
        (Lang::TypeScript, "type_alias_declaration") => SymbolKind::Type,
        (Lang::TypeScript, "enum_declaration")      => SymbolKind::Enum,
        // Exported `const`s with arrow-function bodies — common in TS.
        (Lang::TypeScript, "lexical_declaration")
        | (Lang::TypeScript, "variable_declaration") => return ts_js_const_symbol(node, source),

        // ── JavaScript ─────────────────────────────────────────────
        (Lang::JavaScript, "function_declaration")
        | (Lang::JavaScript, "method_definition")   => SymbolKind::Function,
        (Lang::JavaScript, "class_declaration")     => SymbolKind::Class,
        (Lang::JavaScript, "lexical_declaration")
        | (Lang::JavaScript, "variable_declaration") => return ts_js_const_symbol(node, source),

        // ── Python ─────────────────────────────────────────────────
        (Lang::Python, "function_definition") => SymbolKind::Function,
        (Lang::Python, "class_definition")    => SymbolKind::Class,

        // ── Rust ───────────────────────────────────────────────────
        (Lang::Rust, "function_item")  => SymbolKind::Function,
        (Lang::Rust, "struct_item")    => SymbolKind::Struct,
        (Lang::Rust, "enum_item")      => SymbolKind::Enum,
        (Lang::Rust, "trait_item")     => SymbolKind::Interface,
        (Lang::Rust, "type_item")      => SymbolKind::Type,
        (Lang::Rust, "const_item")     => SymbolKind::Const,
        (Lang::Rust, "static_item")    => SymbolKind::Const,

        // ── Go ─────────────────────────────────────────────────────
        (Lang::Go, "function_declaration")
        | (Lang::Go, "method_declaration") => SymbolKind::Function,
        (Lang::Go, "type_declaration")     => return go_type_decl_symbol(node, source),

        _ => return None,
    };

    let name = node_name(lang, node, source)?;
    Some(symbol_from_parts(name, kind, node, source))
}

/// `lexical_declaration` / `variable_declaration` are interesting only
/// when they declare a top-level binding to a function expression /
/// arrow function. Anything else — bare `const x = 1` — we skip.
fn ts_js_const_symbol(node: Node<'_>, source: &[u8]) -> Option<Symbol> {
    // Walk the variable_declarator children looking for an arrow / fn.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "variable_declarator" {
            continue;
        }
        let name_node = child.child_by_field_name("name")?;
        let value_node = child.child_by_field_name("value")?;
        let value_kind = value_node.kind();
        let is_callable = matches!(
            value_kind,
            "arrow_function" | "function" | "function_expression" | "async_function"
        );
        if !is_callable {
            continue;
        }
        let name_text = node_text(name_node, source).to_string();
        if name_text.is_empty() {
            continue;
        }
        // Use the `node` (lexical_declaration) for the line range so
        // the captured slice includes the `const` keyword.
        return Some(symbol_from_parts(name_text, SymbolKind::Function, node, source));
    }
    None
}

/// Go's `type_declaration` covers struct / interface / alias. Treat
/// each as a top-level symbol, kind decided by the `type_spec` body.
fn go_type_decl_symbol(node: Node<'_>, source: &[u8]) -> Option<Symbol> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "type_spec" {
            continue;
        }
        let name_node = child.child_by_field_name("name")?;
        let kind = match child.child_by_field_name("type")?.kind() {
            "struct_type"    => SymbolKind::Struct,
            "interface_type" => SymbolKind::Interface,
            _                => SymbolKind::Type,
        };
        let name_text = node_text(name_node, source).to_string();
        return Some(symbol_from_parts(name_text, kind, node, source));
    }
    None
}

fn symbol_from_parts(
    name:    String,
    kind:    SymbolKind,
    node:    Node<'_>,
    source:  &[u8],
) -> Symbol {
    let line_start = (node.start_position().row as u32) + 1;
    let line_end   = (node.end_position().row as u32) + 1;
    let source_text = node_text(node, source).to_string();
    let ast_hash    = compute_ast_hash(&source_text);
    Symbol {
        name,
        kind,
        line_start,
        line_end,
        source_text,
        ast_hash,
    }
}

fn node_name(lang: Lang, node: Node<'_>, source: &[u8]) -> Option<String> {
    // Most grammars expose a `name` field; a few (Rust trait_item,
    // Python class_definition, Go method_declaration with receiver)
    // need explicit handling. v0.1 falls back to scanning children
    // for the first `identifier`-shaped child if no `name` field is
    // present.
    if let Some(name_node) = node.child_by_field_name("name") {
        return Some(node_text(name_node, source).to_string());
    }

    // Go method_declaration: `name` is on the function spec. Fallback
    // to walking children for first identifier.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let k = child.kind();
        if k == "identifier"
            || k == "type_identifier"
            || k == "property_identifier"
            || (lang == Lang::Go && k == "field_identifier")
        {
            return Some(node_text(child, source).to_string());
        }
    }
    None
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or("")
}

/// AST hash policy: SHA-256 of the canonicalized source text. We
/// canonicalize by trimming trailing whitespace per line and joining
/// with `\n` (so CRLF / LF / trailing-tab differences don't reflow
/// the hash). Two functions that differ only in whitespace get the
/// same hash and skip re-embedding — important for the incremental
/// path where the user saves on every keystroke.
pub fn compute_ast_hash(source_text: &str) -> String {
    let mut hasher = Sha256::new();
    for line in source_text.lines() {
        hasher.update(line.trim_end().as_bytes());
        hasher.update(b"\n");
    }
    let bytes = hasher.finalize();
    let mut hex = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    hex
}
