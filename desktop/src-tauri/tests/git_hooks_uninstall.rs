//! Sesión 8 — uninstaller removes the four scripts and restores any
//! `.inari-backup` it finds.

use std::fs;

use inariwatch_desktop_lib::sensors::git::installer::{
    install_for, uninstall_for, BACKUP_SUFFIX, INARI_MARKER,
};

fn make_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".git").join("hooks")).unwrap();
    dir
}

#[test]
fn uninstall_removes_inari_hooks() {
    let repo = make_repo();
    let port_file = repo.path().join("port.txt");
    install_for(repo.path(), &port_file, "gh_a", "r").unwrap();
    let out = uninstall_for(repo.path()).unwrap();
    assert_eq!(out.removed.len(), 4);
    let hook = repo.path().join(".git").join("hooks").join("pre-commit");
    assert!(!hook.exists(), "pre-commit should be gone");
}

#[test]
fn uninstall_restores_backup() {
    let repo = make_repo();
    let port_file = repo.path().join("port.txt");
    let user_hook = repo.path().join(".git").join("hooks").join("pre-push");
    fs::write(&user_hook, "#!/bin/sh\necho 'mine'\n").unwrap();

    install_for(repo.path(), &port_file, "gh_a", "r").unwrap();
    let backup = user_hook.with_extension(BACKUP_SUFFIX);
    assert!(backup.exists());

    let out = uninstall_for(repo.path()).unwrap();
    assert!(out.restored.contains(&"pre-push".to_string()));
    assert!(user_hook.exists(), "user hook should be restored");
    let body = fs::read_to_string(&user_hook).unwrap();
    assert!(body.contains("mine"));
    assert!(!body.contains(INARI_MARKER));
    assert!(!backup.exists(), "backup file should be consumed");
}

#[test]
fn uninstall_skips_user_hooks_without_marker() {
    let repo = make_repo();
    // Without ever installing, write a user-style pre-commit file.
    let user_hook = repo.path().join(".git").join("hooks").join("pre-commit");
    fs::write(&user_hook, "#!/bin/sh\necho 'user-only'\n").unwrap();

    let out = uninstall_for(repo.path()).unwrap();
    assert!(!out.removed.contains(&"pre-commit".to_string()));
    // The user file is left untouched.
    assert!(user_hook.exists());
    let body = fs::read_to_string(&user_hook).unwrap();
    assert!(body.contains("user-only"));
}
