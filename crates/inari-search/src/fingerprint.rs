//! Error fingerprinting — turn a raw error string into:
//!
//! 1. A stable cache key (SHA-256 of the normalized text + language).
//! 2. A best-effort `(language, family)` pair the dispatcher can use
//!    for ranking + future per-language source routing.
//!
//! Normalization rules (the "stripping" pass):
//!
//! - Lowercase the whole string.
//! - Collapse runs of whitespace to a single space.
//! - Strip line/column markers (`line 12`, `column 3`).
//! - Strip hex addresses (`0x7fff_ee01`).
//! - Strip absolute file path + line tails (`/src/foo.rs:42`).
//!
//! These are noise — every retry of the same error produces a slightly
//! different stack frame address or temp-file path, but the underlying
//! error text is the same. Stripping them keeps the cache hit ratio
//! high without losing semantic information.
//!
//! Language detection is heuristic — first match wins, ordered from
//! most specific to most general. We err on the side of "Unknown"
//! rather than guessing, because a wrong language label hurts
//! ranking more than `None` does.

use crate::types::SearchRequest;
use once_cell::sync::Lazy;
use regex::Regex;
use sha2::{Digest, Sha256};

// ── Public API ───────────────────────────────────────────────────────────────

/// Best-effort language detected from an error string. Stable
/// lowercase identifier — matches the value the frontend stores in
/// `SearchRequest.language` so a round-trip through the cache key is
/// idempotent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    JavaScript,
    TypeScript,
    Python,
    Rust,
    Go,
    Java,
    Unknown,
}

impl Language {
    pub fn as_str(self) -> &'static str {
        match self {
            Language::JavaScript => "javascript",
            Language::TypeScript => "typescript",
            Language::Python => "python",
            Language::Rust => "rust",
            Language::Go => "go",
            Language::Java => "java",
            Language::Unknown => "unknown",
        }
    }
}

/// Coarse error family — what kind of failure are we looking at? Used
/// for future per-family routing (S14 routes `ImportError` to registry
/// lookups instead of SO). Not exposed in the public response shape
/// today; lives here so the dispatcher can decide what to do without a
/// second pass over `error_text`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    /// `Cannot read property of undefined` / `is not a function`.
    TypeError,
    /// Variable / name not in scope.
    ReferenceError,
    /// Module / import resolution failure.
    ImportError,
    /// Compile-time type error (Rust E-codes, TS TS-codes).
    CompileTypeError,
    /// Generic runtime panic / unhandled exception.
    Runtime,
    /// Assertion / test failure.
    Assertion,
    /// Network / I/O error (`ECONNREFUSED`, `EHOSTUNREACH`).
    Network,
    /// Couldn't classify.
    Unknown,
}

/// Output of fingerprinting one error string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    /// Hex-encoded SHA-256 of `(normalized_text + "|" + language_or_empty)`.
    /// Stable across runs of the same error — the cache key.
    pub hash: String,
    pub language: Language,
    pub family: Family,
    /// The normalized text the hash was computed over. Useful for
    /// debugging cache hits (denormalized into `search_cache.error_text`
    /// so a future maintainer can spot-check what text collapsed to a
    /// given hash).
    pub normalized: String,
}

/// Fingerprint a request — public entry point. The optional
/// `language` hint on the request takes priority over the heuristic
/// detection (it's the user's explicit "I'm in this stack" signal
/// from the chat surface).
pub fn fingerprint(req: &SearchRequest) -> Fingerprint {
    let normalized = normalize(&req.error_text);
    let detected = detect_language(&normalized);
    let language = req
        .language
        .as_deref()
        .and_then(parse_language)
        .unwrap_or(detected);
    let family = detect_family(&normalized);
    let hash = hash(&normalized, language);
    Fingerprint {
        hash,
        language,
        family,
        normalized,
    }
}

/// Helper for callers that want the same hash without a full
/// `SearchRequest` (e.g. cache eviction tests building a synthetic
/// row). Mirrors the production shape exactly.
pub fn hash_for(normalized: &str, language: Language) -> String {
    hash(normalized, language)
}

// ── Internals ────────────────────────────────────────────────────────────────

fn hash(normalized: &str, language: Language) -> String {
    let lang = match language {
        Language::Unknown => "",
        l => l.as_str(),
    };
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hasher.update(b"|");
    hasher.update(lang.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Normalize for cache stability. Order matters — strip path tails
/// BEFORE collapsing whitespace so `/foo/bar.rs:42 ` doesn't leave a
/// trailing space.
fn normalize(input: &str) -> String {
    let lower = input.to_lowercase();
    let stripped = STRIP_NOISE.replace_all(&lower, " ");
    WHITESPACE.replace_all(&stripped, " ").trim().to_string()
}

static STRIP_NOISE: Lazy<Regex> = Lazy::new(|| {
    // Order inside the alternation is by specificity:
    //   - `0x...` hex addresses first (would otherwise match the
    //      generic numeric clause inside line/column).
    //   - Path with line-or-column tail (`/x/y.rs:42`, `/x/y.rs:42:7`).
    //   - `line 42` / `column 7` tokens.
    //   - Bare numeric memory offsets at end of frames (`+0x7fff`).
    Regex::new(
        r"(?x)
        0x[0-9a-f]+                        # hex address
      | /[\w./_\-]+:\d+(:\d+)?              # /path/file.ext:line(:col)?
      | (?:line|column)\s+\d+               # 'line 42', 'column 7'
        ",
    )
    .expect("STRIP_NOISE regex compiles")
});

static WHITESPACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").expect("WHITESPACE regex"));

// ── Language detection ──────────────────────────────────────────────────────

fn parse_language(hint: &str) -> Option<Language> {
    match hint.trim().to_lowercase().as_str() {
        "javascript" | "js" => Some(Language::JavaScript),
        "typescript" | "ts" => Some(Language::TypeScript),
        "python" | "py" => Some(Language::Python),
        "rust" | "rs" => Some(Language::Rust),
        "go" | "golang" => Some(Language::Go),
        "java" => Some(Language::Java),
        _ => None,
    }
}

fn detect_language(normalized: &str) -> Language {
    // Order: language-specific phrases first, then generic.
    if RUST_E_CODE.is_match(normalized) || normalized.contains("error[e0") {
        return Language::Rust;
    }
    if normalized.contains("traceback (most recent call last)")
        || normalized.contains("modulenotfounderror")
        || normalized.contains("attributeerror")
        || normalized.contains("indentationerror")
    {
        return Language::Python;
    }
    if normalized.contains("ts2304") || normalized.contains("ts2339") || TS_CODE.is_match(normalized)
    {
        return Language::TypeScript;
    }
    // JS errors — TypeError / ReferenceError / Cannot read property — appear
    // in BOTH Node and browser stacks. We classify as JS unless the message
    // also names TS-specific types (interface/enum).
    if normalized.contains("typeerror")
        || normalized.contains("referenceerror")
        || normalized.contains("cannot read property")
        || normalized.contains("cannot read properties of undefined")
        || normalized.contains("is not a function")
        || normalized.contains("uncaught")
    {
        return Language::JavaScript;
    }
    if normalized.contains("panic:")
        || normalized.contains("goroutine ")
        || GO_UNDEFINED.is_match(normalized)
    {
        return Language::Go;
    }
    if normalized.contains("nullpointerexception")
        || normalized.contains("classnotfoundexception")
        || normalized.contains("at java.")
        || normalized.contains("exception in thread")
    {
        return Language::Java;
    }
    Language::Unknown
}

static RUST_E_CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\berror\[e\d{3,4}\]").unwrap());
static TS_CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bts\d{4}\b").unwrap());
static GO_UNDEFINED: Lazy<Regex> = Lazy::new(|| Regex::new(r"undefined: [a-z]").unwrap());

// ── Family detection ────────────────────────────────────────────────────────

fn detect_family(normalized: &str) -> Family {
    if normalized.contains("modulenotfounderror")
        || normalized.contains("cannot find module")
        || normalized.contains("import error")
        || normalized.contains("error[e0432]")
        || normalized.contains("could not find ")
    {
        return Family::ImportError;
    }
    if normalized.contains("typeerror") || normalized.contains("ts2339") {
        return Family::TypeError;
    }
    if normalized.contains("referenceerror") || normalized.contains("ts2304") {
        return Family::ReferenceError;
    }
    if RUST_E_CODE.is_match(normalized) || TS_CODE.is_match(normalized) {
        return Family::CompileTypeError;
    }
    if normalized.contains("assertionerror") || normalized.contains("assertion failed") {
        return Family::Assertion;
    }
    if normalized.contains("econnrefused")
        || normalized.contains("ehostunreach")
        || normalized.contains("etimedout")
        || normalized.contains("enotfound")
    {
        return Family::Network;
    }
    if normalized.contains("panic:")
        || normalized.contains("uncaught")
        || normalized.contains("traceback")
    {
        return Family::Runtime;
    }
    Family::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(text: &str) -> SearchRequest {
        SearchRequest {
            error_text: text.into(),
            language: None,
            framework: None,
            max_hits: 20,
        }
    }

    fn req_lang(text: &str, lang: &str) -> SearchRequest {
        SearchRequest {
            error_text: text.into(),
            language: Some(lang.into()),
            framework: None,
            max_hits: 20,
        }
    }

    // ── Hash stability ──────────────────────────────────────────────────────

    #[test]
    fn same_text_same_hash() {
        let a = fingerprint(&req("TypeError: Cannot read property 'x' of undefined"));
        let b = fingerprint(&req("TypeError: Cannot read property 'x' of undefined"));
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn whitespace_variations_produce_same_hash() {
        let a = fingerprint(&req("TypeError: Cannot read property 'x'"));
        let b = fingerprint(&req("TypeError:   Cannot   read    property  'x'"));
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn case_variations_produce_same_hash() {
        let a = fingerprint(&req("TypeError: foo"));
        let b = fingerprint(&req("TYPEERROR: FOO"));
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn line_number_difference_is_normalized_out() {
        let a = fingerprint(&req("ReferenceError: x is not defined at /tmp/foo.js:42"));
        let b = fingerprint(&req("ReferenceError: x is not defined at /tmp/foo.js:99"));
        assert_eq!(a.hash, b.hash, "stack-frame line differences should not affect cache key");
    }

    #[test]
    fn hex_address_difference_is_normalized_out() {
        let a = fingerprint(&req("Bus error at 0x7fff8e012040"));
        let b = fingerprint(&req("Bus error at 0x7fff8e012044"));
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn line_token_normalization() {
        let a = fingerprint(&req("Syntax error: bad token at line 42"));
        let b = fingerprint(&req("Syntax error: bad token at line 99"));
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn column_token_normalization() {
        let a = fingerprint(&req("parse error column 12"));
        let b = fingerprint(&req("parse error column 312"));
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn different_errors_produce_different_hashes() {
        let a = fingerprint(&req("TypeError: x"));
        let b = fingerprint(&req("ReferenceError: x"));
        assert_ne!(a.hash, b.hash);
    }

    #[test]
    fn language_hint_changes_hash() {
        // Same text, different explicit language → distinct cache slot.
        let a = fingerprint(&req_lang("Cannot find module", "javascript"));
        let b = fingerprint(&req_lang("Cannot find module", "python"));
        assert_ne!(a.hash, b.hash);
    }

    #[test]
    fn unknown_language_collapses_to_no_suffix() {
        // Two requests, both heuristic-Unknown, same text → same hash.
        let a = fingerprint(&req("???"));
        let b = fingerprint(&req("???"));
        assert_eq!(a.hash, b.hash);
        assert_eq!(a.language, Language::Unknown);
    }

    // ── Language detection — JavaScript / TypeScript ───────────────────────

    #[test]
    fn detects_javascript_typeerror() {
        let f = fingerprint(&req(
            "TypeError: Cannot read properties of undefined (reading 'foo')",
        ));
        assert_eq!(f.language, Language::JavaScript);
    }

    #[test]
    fn detects_javascript_referenceerror() {
        let f = fingerprint(&req("ReferenceError: foo is not defined"));
        assert_eq!(f.language, Language::JavaScript);
    }

    #[test]
    fn detects_javascript_is_not_a_function() {
        let f = fingerprint(&req("Uncaught TypeError: foo is not a function"));
        assert_eq!(f.language, Language::JavaScript);
    }

    #[test]
    fn detects_typescript_via_ts_code() {
        let f = fingerprint(&req("error TS2304: Cannot find name 'Foo'"));
        assert_eq!(f.language, Language::TypeScript);
    }

    #[test]
    fn detects_typescript_via_explicit_marker() {
        let f = fingerprint(&req("ts2339: Property does not exist on type"));
        assert_eq!(f.language, Language::TypeScript);
    }

    // ── Language detection — Python ────────────────────────────────────────

    #[test]
    fn detects_python_traceback() {
        let f = fingerprint(&req(
            "Traceback (most recent call last):\n  File \"x.py\", line 1\nNameError: x",
        ));
        assert_eq!(f.language, Language::Python);
    }

    #[test]
    fn detects_python_module_not_found() {
        let f = fingerprint(&req("ModuleNotFoundError: No module named 'requests'"));
        assert_eq!(f.language, Language::Python);
    }

    #[test]
    fn detects_python_attribute_error() {
        let f = fingerprint(&req("AttributeError: 'NoneType' object has no attribute 'foo'"));
        assert_eq!(f.language, Language::Python);
    }

    #[test]
    fn detects_python_indentation_error() {
        let f = fingerprint(&req("IndentationError: unexpected indent"));
        assert_eq!(f.language, Language::Python);
    }

    // ── Language detection — Rust ──────────────────────────────────────────

    #[test]
    fn detects_rust_via_e_code() {
        let f = fingerprint(&req("error[E0432]: unresolved import `foo::bar`"));
        assert_eq!(f.language, Language::Rust);
    }

    #[test]
    fn detects_rust_via_e_code_lowercase() {
        let f = fingerprint(&req("error[e0277]: the trait bound is not satisfied"));
        assert_eq!(f.language, Language::Rust);
    }

    // ── Language detection — Go ────────────────────────────────────────────

    #[test]
    fn detects_go_panic() {
        let f = fingerprint(&req(
            "panic: runtime error: invalid memory address or nil pointer dereference",
        ));
        assert_eq!(f.language, Language::Go);
    }

    #[test]
    fn detects_go_via_undefined_marker() {
        let f = fingerprint(&req("./main.go:10:5: undefined: foo"));
        assert_eq!(f.language, Language::Go);
    }

    #[test]
    fn detects_go_via_goroutine_marker() {
        let f = fingerprint(&req("goroutine 1 [running]:\nmain.main()"));
        assert_eq!(f.language, Language::Go);
    }

    // ── Language detection — Java ──────────────────────────────────────────

    #[test]
    fn detects_java_npe() {
        let f = fingerprint(&req(
            "Exception in thread \"main\" java.lang.NullPointerException",
        ));
        assert_eq!(f.language, Language::Java);
    }

    #[test]
    fn detects_java_class_not_found() {
        let f = fingerprint(&req(
            "java.lang.ClassNotFoundException: com.example.Foo",
        ));
        assert_eq!(f.language, Language::Java);
    }

    #[test]
    fn unknown_language_for_garbage_input() {
        let f = fingerprint(&req("hello world I am not an error"));
        assert_eq!(f.language, Language::Unknown);
    }

    // ── Family detection ────────────────────────────────────────────────────

    #[test]
    fn family_module_not_found_is_import_error_python() {
        let f = fingerprint(&req("ModuleNotFoundError: No module named 'requests'"));
        assert_eq!(f.family, Family::ImportError);
    }

    #[test]
    fn family_cannot_find_module_is_import_error_node() {
        let f = fingerprint(&req("Error: Cannot find module 'foo'"));
        assert_eq!(f.family, Family::ImportError);
    }

    #[test]
    fn family_e0432_is_import_error_rust() {
        let f = fingerprint(&req("error[E0432]: unresolved import `foo::bar`"));
        assert_eq!(f.family, Family::ImportError);
    }

    #[test]
    fn family_typeerror() {
        let f = fingerprint(&req("TypeError: Cannot read property 'x'"));
        assert_eq!(f.family, Family::TypeError);
    }

    #[test]
    fn family_referenceerror() {
        let f = fingerprint(&req("ReferenceError: foo is not defined"));
        assert_eq!(f.family, Family::ReferenceError);
    }

    #[test]
    fn family_compile_type_error_for_ts_code() {
        let f = fingerprint(&req("error TS9999: Internal compiler error"));
        // Family is detected before the import-specific TS codes; TS9999
        // is generic, so it falls to CompileTypeError.
        assert_eq!(f.family, Family::CompileTypeError);
    }

    #[test]
    fn family_assertion() {
        let f = fingerprint(&req("AssertionError: expected 1 to equal 2"));
        assert_eq!(f.family, Family::Assertion);
    }

    #[test]
    fn family_network() {
        let f = fingerprint(&req("Error: connect ECONNREFUSED 127.0.0.1:5432"));
        assert_eq!(f.family, Family::Network);
    }

    #[test]
    fn family_runtime_for_go_panic() {
        let f = fingerprint(&req("panic: runtime error"));
        assert_eq!(f.family, Family::Runtime);
    }

    #[test]
    fn family_runtime_for_traceback() {
        let f = fingerprint(&req(
            "Traceback (most recent call last):\nValueError: bad",
        ));
        assert_eq!(f.family, Family::Runtime);
    }

    #[test]
    fn family_unknown_for_unrecognised_text() {
        let f = fingerprint(&req("hello"));
        assert_eq!(f.family, Family::Unknown);
    }

    // ── User-supplied language hint takes priority ──────────────────────────

    #[test]
    fn user_language_hint_overrides_detection() {
        // Heuristic would say JS (TypeError); user explicitly says python.
        let f = fingerprint(&req_lang(
            "TypeError: Cannot read property 'x'",
            "python",
        ));
        assert_eq!(f.language, Language::Python);
    }

    #[test]
    fn empty_language_hint_does_not_override() {
        let f = fingerprint(&req_lang("TypeError: x", ""));
        assert_eq!(f.language, Language::JavaScript);
    }

    #[test]
    fn nonsense_language_hint_falls_back_to_detection() {
        let f = fingerprint(&req_lang("TypeError: x", "klingon"));
        assert_eq!(f.language, Language::JavaScript);
    }
}
