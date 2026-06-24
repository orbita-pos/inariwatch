//! Sesión 19 — `apply_diff` MUST reject diffs that try to escape the
//! repo. Any `+++ b/<path>` containing `..` or starting at root is a
//! security incident: we never apply it, never write to disk, and the
//! caller surfaces a friendly "blocked" message to the user.
//!
//! Two scenarios:
//!   1. A relative `..` path. Most realistic — a hostile model could
//!      try `../../etc/passwd` if the prompt mishandled file paths.
//!   2. An absolute path. Even if `git apply` would resolve it
//!      relative to the repo, we rejected it explicitly.

use std::path::PathBuf;

use inariwatch_desktop_lib::ai::remediate::orchestrator::{apply_diff, ApplyError};

#[test]
fn diff_with_parent_dir_is_rejected_and_disk_untouched() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_path: PathBuf = dir.path().to_path_buf();

    // Snapshot of what's in the repo BEFORE the call (nothing).
    let entries_before: Vec<_> = std::fs::read_dir(&repo_path)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();

    // Diff that targets `../../etc/passwd` — same `--- a/` and `+++ b/`
    // shape a real diff uses.
    let diff = "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -0,0 +1 @@\n+pwned\n";
    let err = apply_diff(&repo_path, diff, "should not commit").expect_err("must reject");
    assert!(
        matches!(err, ApplyError::PathTraversal(_)),
        "expected PathTraversal, got {err:?}",
    );

    // Disk untouched.
    let entries_after: Vec<_> = std::fs::read_dir(&repo_path)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    assert_eq!(
        entries_before.len(),
        entries_after.len(),
        "no entries should have been created"
    );
}

#[test]
fn diff_with_absolute_path_is_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_path: PathBuf = dir.path().to_path_buf();

    // Use a Windows-style absolute path so the test is portable —
    // `PathBuf::is_absolute` recognises both `/...` and `C:\...`.
    let absolute = if cfg!(windows) { "C:/Windows/System32/cmd.exe" } else { "/etc/passwd" };
    let diff = format!(
        "--- a/{absolute}\n+++ b/{absolute}\n@@ -0,0 +1 @@\n+pwned\n",
    );
    let err = apply_diff(&repo_path, &diff, "should not commit").expect_err("must reject");
    assert!(
        matches!(err, ApplyError::PathTraversal(_)),
        "expected PathTraversal, got {err:?}",
    );
}

#[test]
fn empty_diff_is_rejected_as_invalid_patch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo_path: PathBuf = dir.path().to_path_buf();

    let err = apply_diff(&repo_path, "", "no-op").expect_err("must reject empty diff");
    assert!(
        matches!(err, ApplyError::InvalidPatch(_)),
        "expected InvalidPatch, got {err:?}",
    );
}
