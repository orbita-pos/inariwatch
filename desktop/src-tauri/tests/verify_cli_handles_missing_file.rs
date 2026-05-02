//! Sesión 28 — the verifier exits 2 (file/parse error) when the
//! receipt file is missing, unreadable, not JSON, or carries an
//! unsupported version.
//!
//! Exit 2 is intentionally distinct from exit 1 (FAIL):
//!   - 0 = PASS (signature valid OR Merkle-only)
//!   - 1 = FAIL (signature invalid OR receipt malformed)
//!   - 2 = could-not-attempt (file/parse/version)
//!
//! Auditor scripts piping `inari-verify` into other tools rely on this
//! split: a 2 means "give me a different file"; a 1 means "this file
//! is wrong". Conflating them would let a malformed input masquerade
//! as a verification failure.

use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_inari-verify")
}

#[test]
fn missing_file_exits_two() {
    // A path that demonstrably does not exist on Windows + Unix.
    let out = Command::new(bin())
        .arg("does-not-exist-on-this-machine.eap.json")
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("cannot read receipt"),
        "stderr should explain the read failure: {stderr}"
    );
}

#[test]
fn invalid_json_exits_two() {
    let tmp = tempfile::NamedTempFile::with_suffix(".eap.json").expect("tempfile");
    std::fs::write(tmp.path(), "{not valid json").expect("write");

    let out = Command::new(bin())
        .arg(tmp.path())
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("cannot read receipt"));
}

#[test]
fn unsupported_version_exits_two() {
    let receipt = serde_json::json!({
        "version":     "eap-99",
        "receipt_id":  "0".repeat(64),
        "merkle_root": "0".repeat(64),
    });
    let tmp = tempfile::NamedTempFile::with_suffix(".eap.json").expect("tempfile");
    std::fs::write(tmp.path(), receipt.to_string()).expect("write");

    let out = Command::new(bin())
        .arg(tmp.path())
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn no_arguments_exits_two_with_usage() {
    let out = Command::new(bin()).output().expect("spawn");
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("missing argument"),
        "stderr should explain the missing arg: {stderr}"
    );
}

#[test]
fn help_flag_exits_zero() {
    let out = Command::new(bin())
        .arg("--help")
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("inari-verify") && stdout.contains("USAGE"),
        "help output should include name + USAGE: {stdout}"
    );
}
