//! Lockdown enforcement test — v0.3 S7.
//!
//! Walks every `.rs` file under `cli/src/` and `desktop/src-tauri/src/`
//! and fails the build if any of them contains a literal cloud-LLM
//! provider URL. After v0.3 S7, those URLs are allowed only inside this
//! crate's `src/providers/` directory.
//!
//! The list mirrors the rules in [`ai_router_rs::providers::openai_compat`]
//! and [`ai_router_rs::providers::anthropic`] — if those add a new
//! provider URL, both the production list and the audit list below must
//! grow in lock-step.
//!
//! Why an integration test instead of `cargo deny`:
//! - `cargo deny` enforces dependency-graph constraints (licenses,
//!   advisories, source registries) but does not grep source. The
//!   lockdown is a *source* boundary, not a dependency boundary.
//! - cargo-deny in a multi-crate path-dep tree (no workspace root) has
//!   known false positives. We use cargo-deny only for `[advisories]`
//!   in CI; the integration test owns lockdown.
//!
//! The test is hermetic: it walks the file system from the crate's
//! `CARGO_MANIFEST_DIR`, ignoring `target/` and any nested
//! `crates/ai-router-rs/`. It is fast (<200 ms on a warm tree).

use std::fs;
use std::path::{Path, PathBuf};

/// Forbidden URL fragments. Must match the strings inside
/// [`ai_router_rs::providers`].
const FORBIDDEN_FRAGMENTS: &[&str] = &[
    "api.openai.com",
    "api.anthropic.com",
    "api.groq.com",
    "api.x.ai",
    "api.deepseek.com",
    "generativelanguage.googleapis.com",
];

/// Surfaces under audit. Relative to the repo root.
const AUDITED_PATHS: &[&str] = &[
    "cli/src",
    "desktop/src-tauri/src",
];

/// Paths to skip when walking. Relative to the repo root. The crate's
/// own source tree is the obvious one — it owns the lockdown URLs.
const ALLOW_LIST: &[&str] = &[
    "crates/ai-router-rs",
    "target",
    "node_modules",
];

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points at `crates/ai-router-rs`; go up two levels.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .expect("crate sits at <repo>/crates/ai-router-rs")
}

fn is_allowed_path(rel: &Path) -> bool {
    let s = rel.to_string_lossy().replace('\\', "/");
    ALLOW_LIST.iter().any(|allow| s.starts_with(allow))
}

fn walk_rs(root: &Path, rel: PathBuf, out: &mut Vec<PathBuf>) {
    if is_allowed_path(&rel) {
        return;
    }
    let abs = root.join(&rel);
    let meta = match fs::metadata(&abs) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.is_dir() {
        let entries = match fs::read_dir(&abs) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let mut next = rel.clone();
            next.push(&name);
            walk_rs(root, next, out);
        }
    } else if meta.is_file() {
        if rel.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(rel);
        }
    }
}

fn audit_path(root: &Path, rel_root: &str) -> Vec<(PathBuf, String, &'static str)> {
    let mut files: Vec<PathBuf> = Vec::new();
    walk_rs(root, PathBuf::from(rel_root), &mut files);
    let mut violations: Vec<(PathBuf, String, &'static str)> = Vec::new();
    for rel in files {
        let abs = root.join(&rel);
        let body = match fs::read_to_string(&abs) {
            Ok(b) => b,
            Err(_) => continue,
        };
        for fragment in FORBIDDEN_FRAGMENTS {
            if body.contains(fragment) {
                let (line, snippet) = locate_first(&body, fragment);
                violations.push((
                    rel.clone(),
                    format!("line {line}: {snippet}"),
                    fragment,
                ));
            }
        }
    }
    violations
}

fn locate_first(body: &str, needle: &str) -> (usize, String) {
    for (idx, line) in body.lines().enumerate() {
        if line.contains(needle) {
            let preview: String = line.trim().chars().take(120).collect();
            return (idx + 1, preview);
        }
    }
    (0, String::new())
}

#[test]
fn no_provider_urls_outside_router_crate() {
    let root = repo_root();
    let mut all_violations: Vec<(PathBuf, String, &'static str)> = Vec::new();

    for path in AUDITED_PATHS {
        let mut v = audit_path(&root, path);
        all_violations.append(&mut v);
    }

    if !all_violations.is_empty() {
        let mut report = String::new();
        report.push_str("\nLOCKDOWN VIOLATION — provider URL found outside crates/ai-router-rs/.\n");
        report.push_str("Per INARI_AI_ARCHITECTURE.md §9 (LOCKED 2026-05-02), every Rust HTTP\n");
        report.push_str("call to a cloud LLM provider must go through ai-router-rs::dispatch.\n\n");
        for (path, location, fragment) in &all_violations {
            report.push_str(&format!(
                " - {} → {} ({})\n",
                path.display(),
                location,
                fragment,
            ));
        }
        report.push_str("\nFix: replace the direct call with dispatch() / dispatch_stream().\n");
        panic!("{report}");
    }
}

/// Sanity test: the audit walker actually finds files. Catches a class
/// of "we changed paths and the audit silently went green" bugs.
#[test]
fn audit_walker_finds_files_under_audited_paths() {
    let root = repo_root();
    for path in AUDITED_PATHS {
        let mut files = Vec::new();
        walk_rs(&root, PathBuf::from(path), &mut files);
        assert!(
            !files.is_empty(),
            "no .rs files under {path} — did the path move?",
        );
    }
}

/// Sanity test: the crate's own source tree IS skipped (otherwise the
/// audit would report itself as a violation, which would defeat the
/// purpose).
#[test]
fn audit_skips_own_crate_directory() {
    let rel = PathBuf::from("crates/ai-router-rs/src/providers/openai_compat.rs");
    assert!(is_allowed_path(&rel));
}
