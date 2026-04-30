//! Sesión 8 — `git_hook_token` is generated on first call, persisted,
//! idempotent on subsequent calls, and (on Unix) has 0600 perms.

use inariwatch_desktop_lib::sensors::git::token::{ensure_token, regenerate, resolve_path};

#[test]
fn ensure_token_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let a = ensure_token(dir.path()).unwrap();
    let b = ensure_token(dir.path()).unwrap();
    assert_eq!(a, b, "token should be stable across calls");
    assert!(a.starts_with("gh_"), "token shape: gh_<hex>");
    assert_eq!(a.len(), 35);
}

#[test]
fn regenerate_changes_token() {
    let dir = tempfile::tempdir().unwrap();
    let a = ensure_token(dir.path()).unwrap();
    let b = regenerate(dir.path()).unwrap();
    assert_ne!(a, b);
    let c = ensure_token(dir.path()).unwrap();
    assert_eq!(b, c, "post-regenerate ensure should return new value");
}

#[cfg(unix)]
#[test]
fn token_file_has_secure_perms() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    ensure_token(dir.path()).unwrap();
    let path = resolve_path(dir.path());
    let perms = std::fs::metadata(&path).unwrap().permissions();
    let mode = perms.mode() & 0o777;
    assert_eq!(mode, 0o600, "token file should be owner-only");
}

#[cfg(not(unix))]
#[test]
fn token_file_exists_on_windows() {
    let dir = tempfile::tempdir().unwrap();
    ensure_token(dir.path()).unwrap();
    let path = resolve_path(dir.path());
    assert!(path.exists(), "token file should be on disk");
}
