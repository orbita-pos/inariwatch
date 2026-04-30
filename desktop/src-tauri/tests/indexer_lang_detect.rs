//! Language detection from file paths. Pure function — no IO, no
//! parser load.

use std::path::Path;

use inariwatch_desktop_lib::indexer::{detect_from_path, Lang};

#[test]
fn detects_typescript() {
    assert_eq!(detect_from_path(Path::new("foo.ts")),  Some(Lang::TypeScript));
    assert_eq!(detect_from_path(Path::new("foo.tsx")), Some(Lang::TypeScript));
}

#[test]
fn detects_javascript() {
    for ext in ["js", "jsx", "mjs", "cjs"] {
        let p = format!("foo.{ext}");
        assert_eq!(
            detect_from_path(Path::new(&p)),
            Some(Lang::JavaScript),
            ".{ext} should map to JavaScript"
        );
    }
}

#[test]
fn detects_python() {
    assert_eq!(detect_from_path(Path::new("script.py")), Some(Lang::Python));
}

#[test]
fn detects_rust() {
    assert_eq!(detect_from_path(Path::new("lib.rs")), Some(Lang::Rust));
}

#[test]
fn detects_go() {
    assert_eq!(detect_from_path(Path::new("main.go")), Some(Lang::Go));
}

#[test]
fn returns_none_for_unsupported() {
    assert_eq!(detect_from_path(Path::new("README.md")), None);
    assert_eq!(detect_from_path(Path::new("Cargo.toml")), None);
    assert_eq!(detect_from_path(Path::new("no_extension")), None);
    assert_eq!(detect_from_path(Path::new("data.json")), None);
}
