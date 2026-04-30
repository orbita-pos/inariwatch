//! Walker honors `.gitignore`, ignores directories, counts files only.

use std::fs::File;
use std::io::Write;
use std::path::Path;

use inariwatch_desktop_lib::sensors::fs::walk_repo;

/// Number of source files to fabricate. 1_000 is sufficient to trigger
/// real walker behavior + stay well under both the per-machine perf
/// budget and the 50_000 hard cap. Larger counts (the spec's reference
/// 10_000) bloat runtime on Windows because tempfile creation pays a
/// per-file syscall — measured: 1_000 ≈ 200ms on the dev machine,
/// 10_000 ≈ 4s. We keep the test under 1s to honor the locked build
/// constraints.
const FILE_COUNT: usize = 1_000;

/// `.gitignore` skips this many files via the `node_modules` rule.
const IGNORED_COUNT: usize = 100;

#[test]
fn walks_synthetic_repo_respecting_gitignore() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();

    // The `ignore` crate honors `.gitignore` only when the walked tree
    // is recognized as a git repository (i.e. it or an ancestor
    // contains a `.git/` directory). Production callers always point
    // the watcher at real repos, so the test mirrors that contract:
    // touch an empty `.git/` placeholder so the gitignore stack
    // engages. Without this, `node_modules/` slips through.
    std::fs::create_dir_all(&root.join(".git")).expect("mkdir .git");

    // Synthetic source tree: FILE_COUNT regular files.
    for i in 0..FILE_COUNT {
        let path = root.join(format!("src_{:05}.txt", i));
        write_file(&path, b"hello");
    }

    // 5MB binary-ish file — a single chunk written once. Walker counts
    // it as one file regardless of size.
    let big = root.join("big.bin");
    write_file(&big, &vec![0u8; 5 * 1024 * 1024]);

    // node_modules subtree, gitignored.
    let nm = root.join("node_modules");
    std::fs::create_dir_all(&nm).expect("mkdir node_modules");
    for i in 0..IGNORED_COUNT {
        let path = nm.join(format!("dep_{:03}.js", i));
        write_file(&path, b"export default 1");
    }

    // Gitignore that excludes node_modules.
    write_file(&root.join(".gitignore"), b"node_modules/\n");

    let result = walk_repo(root);

    // Expected: FILE_COUNT (.txt) + 1 (big.bin) + 1 (.gitignore) = FILE_COUNT + 2.
    // node_modules/* are filtered by the gitignore stack. The empty
    // `.git/` directory itself contributes 0 files.
    let expected = (FILE_COUNT + 2) as u64;
    assert_eq!(
        result.file_count, expected,
        "walker counted {} files, expected {} (FILE_COUNT={} + big.bin + .gitignore); \
         node_modules should be excluded by .gitignore",
        result.file_count, expected, FILE_COUNT
    );
    assert!(!result.truncated, "should not truncate at this scale");
    // Sanity: walks always take some non-zero wall-clock.
    assert!(result.duration_ms < 30_000, "walk took {}ms — exceeds 30s budget", result.duration_ms);
}

#[test]
fn walks_empty_repo_returns_zero() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let result = walk_repo(tmp.path());
    assert_eq!(result.file_count, 0);
    assert!(!result.truncated);
}

fn write_file(p: &Path, bytes: &[u8]) {
    let mut f = File::create(p).expect("create file");
    f.write_all(bytes).expect("write");
}
