//! Sesión 19 — `orchestrator::apply_diff` writes files + commits.
//!
//! Sets up a tempdir git repo with one committed file, hands a known
//! unified diff to `apply_diff`, asserts: the file's new content
//! matches expected, `git log -1` shows the commit with the right
//! message + the returned `commit_sha` matches the actual HEAD.

use std::path::PathBuf;
use std::process::Command;

use inariwatch_desktop_lib::ai::remediate::orchestrator::apply_diff;

fn run(cmd: &mut Command, ctx: &str) -> std::process::Output {
    let out = cmd.output().expect(ctx);
    if !out.status.success() {
        panic!(
            "{ctx} failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    out
}

fn init_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let p   = dir.path();

    run(Command::new("git").current_dir(p).args(["init", "-q", "-b", "main"]), "git init");
    run(Command::new("git").current_dir(p).args(["config", "user.email", "test@inariwatch.test"]), "config email");
    run(Command::new("git").current_dir(p).args(["config", "user.name",  "Inari Test"]), "config name");
    run(Command::new("git").current_dir(p).args(["config", "commit.gpgsign", "false"]), "config gpg");

    std::fs::create_dir_all(p.join("src")).expect("mkdir src");
    std::fs::write(
        p.join("src/main.rs"),
        "fn off_by_one() -> usize { 1 }\nfn main() {}\n",
    )
    .expect("write main.rs");

    run(Command::new("git").current_dir(p).args(["add", "."]), "git add");
    run(Command::new("git").current_dir(p).args(["commit", "-q", "-m", "initial"]), "git commit");

    dir
}

#[test]
fn apply_diff_writes_and_commits() {
    let dir       = init_repo();
    let repo_path: PathBuf = dir.path().to_path_buf();

    let diff = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,2 +1,2 @@\n-fn off_by_one() -> usize { 1 }\n+fn off_by_one() -> usize { 0 }\n fn main() {}\n";
    let result = apply_diff(&repo_path, diff, "test fix").expect("apply succeeds");

    // File on disk reflects the patch.
    let body = std::fs::read_to_string(repo_path.join("src/main.rs")).expect("read");
    assert!(body.contains("usize { 0 }"), "expected patched body; got {body:?}");
    assert!(!body.contains("usize { 1 }"));

    // Commit landed.
    let head = run(
        Command::new("git").current_dir(&repo_path).args(["rev-parse", "HEAD"]),
        "rev-parse",
    );
    let head_sha = String::from_utf8(head.stdout).unwrap().trim().to_string();
    assert_eq!(head_sha, result.commit_sha);

    let log = run(
        Command::new("git").current_dir(&repo_path).args(["log", "-1", "--format=%s"]),
        "log",
    );
    let msg = String::from_utf8(log.stdout).unwrap().trim().to_string();
    assert_eq!(msg, "test fix");

    assert_eq!(result.files_touched, vec!["src/main.rs".to_string()]);
}
