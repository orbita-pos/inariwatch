//! Sesión 8 — installer creates 4 hook scripts under `.git/hooks/`,
//! each containing the Inari marker, the bearer token, the repo id,
//! and a curl invocation. Idempotent re-install does not stack
//! backups, and a pre-existing user hook is moved aside.

use std::fs;

use inariwatch_desktop_lib::sensors::git::installer::{
    install_for, BACKUP_SUFFIX, HOOK_NAMES, INARI_MARKER,
};

fn make_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".git").join("hooks")).unwrap();
    dir
}

#[test]
fn install_writes_four_hooks_with_marker_token_and_curl() {
    let repo = make_repo();
    let port_file = repo.path().join("port.txt");
    let outcome = install_for(repo.path(), &port_file, "gh_test123", "repo-XYZ").unwrap();
    assert_eq!(outcome.installed.len(), HOOK_NAMES.len());
    for name in HOOK_NAMES {
        let p = repo.path().join(".git").join("hooks").join(name);
        assert!(p.exists(), "{name} not created");
        let body = fs::read_to_string(&p).unwrap();
        assert!(body.contains(INARI_MARKER), "{name} missing marker");
        assert!(body.contains("gh_test123"), "{name} missing token");
        assert!(body.contains("repo-XYZ"), "{name} missing repo id");
        assert!(body.contains("curl"), "{name} missing curl call");
        assert!(body.contains("port.txt"), "{name} missing port file ref");
    }
}

#[test]
fn install_is_idempotent() {
    let repo = make_repo();
    let port_file = repo.path().join("port.txt");
    let a = install_for(repo.path(), &port_file, "gh_a", "r").unwrap();
    let b = install_for(repo.path(), &port_file, "gh_a", "r").unwrap();
    assert_eq!(a.installed, b.installed);
    // Second run sees its own previous output → already_ours, no
    // backups created on the second pass.
    assert!(b.backed_up.is_empty(), "second install should not back up");
    assert_eq!(b.already_ours.len(), 4, "all four are recognised as ours");
}

#[test]
fn pre_existing_user_hook_is_backed_up() {
    let repo = make_repo();
    let port_file = repo.path().join("port.txt");
    // Pre-existing user hook (not ours).
    let user_hook = repo.path().join(".git").join("hooks").join("pre-commit");
    fs::write(&user_hook, "#!/bin/sh\necho 'user-defined'\n").unwrap();

    let outcome = install_for(repo.path(), &port_file, "gh_x", "r1").unwrap();
    assert!(outcome.backed_up.contains(&"pre-commit".to_string()));

    let backup = user_hook.with_extension(BACKUP_SUFFIX);
    assert!(backup.exists(), "backup not created");
    let body = fs::read_to_string(&backup).unwrap();
    assert!(body.contains("user-defined"), "backup lost user content");
}
