//! Sesión 9 — `installer::install` for zsh writes exactly one
//! `source` line into the rc file and refreshes the hook payload.
//! Running it a second time leaves both invariants intact (the
//! line count stays at 1, and the line is recognisably ours).

use std::fs;

use inariwatch_desktop_lib::sensors::shell::{install, ShellKind, INARI_MARKER};

#[test]
fn zsh_install_writes_one_source_line_idempotently() {
    let home = tempfile::tempdir().unwrap();

    // First install: no rc file, no hook on disk.
    let first = install(ShellKind::Zsh, home.path()).unwrap();
    assert!(!first.already_present, "fresh install reported already_present");

    let zshrc_path = home.path().join(".zshrc");
    let hook_path  = home.path().join(".inari/shell/inari.zsh");
    assert!(zshrc_path.exists(), ".zshrc not created on first install");
    assert!(hook_path.exists(),   "hook payload not written on first install");

    let zshrc_after_first = fs::read_to_string(&zshrc_path).unwrap();
    let count_after_first = zshrc_after_first
        .lines()
        .filter(|l| line_is_ours(l))
        .count();
    assert_eq!(count_after_first, 1, "expected exactly one source line, got {count_after_first}");

    // Hook payload is one of the bundled templates — sanity check it
    // actually wrote one of the expected scrubber patterns.
    let hook_body = fs::read_to_string(&hook_path).unwrap();
    assert!(
        hook_body.contains("KEY") && hook_body.contains("SECRET"),
        "hook payload missing scrubber pattern keywords",
    );

    // Second install: idempotent — same line, no duplication.
    let second = install(ShellKind::Zsh, home.path()).unwrap();
    assert!(second.already_present, "second install did not detect existing line");

    let zshrc_after_second = fs::read_to_string(&zshrc_path).unwrap();
    let count_after_second = zshrc_after_second
        .lines()
        .filter(|l| line_is_ours(l))
        .count();
    assert_eq!(count_after_second, 1, "second install duplicated the source line");
}

#[test]
fn install_preserves_user_lines() {
    let home = tempfile::tempdir().unwrap();
    let zshrc_path = home.path().join(".zshrc");
    fs::write(&zshrc_path, "alias gs='git status'\nexport EDITOR=vim\n").unwrap();

    install(ShellKind::Zsh, home.path()).unwrap();

    let after = fs::read_to_string(&zshrc_path).unwrap();
    assert!(after.contains("alias gs="),    "user alias was clobbered");
    assert!(after.contains("export EDITOR"), "user export was clobbered");
    assert!(after.lines().any(line_is_ours), "our source line missing");
}

fn line_is_ours(line: &str) -> bool {
    line.contains(INARI_MARKER) && line.trim_start().starts_with("source ")
}
