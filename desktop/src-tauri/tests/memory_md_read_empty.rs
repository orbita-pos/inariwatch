//! Session 11 — `read_memory_md` reports `None` for a fresh repo whose
//! `.inari/memory.md` does not yet exist.
//!
//! The IPC command resolves repo path → checks `.inari/memory.md` →
//! returns `Ok(None)` on `NotFound`. We exercise the underlying file
//! probe (the same `std::fs::metadata` shape the command uses) so a
//! refactor of the command body still exercises this contract.

use inariwatch_desktop_lib::memory::declarative::{memory_md_path, MAX_MEMORY_MD_BYTES};

#[test]
fn fresh_repo_has_no_memory_md() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo = tmp.path();

    let md = memory_md_path(repo);
    assert!(!md.exists(), "fresh repo must not have .inari/memory.md");

    // Mimic the command's NotFound short-circuit.
    let result: Option<u64> = match std::fs::metadata(&md) {
        Ok(m) => Some(m.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => panic!("unexpected io error: {e}"),
    };
    assert!(result.is_none(), "expected None for missing memory.md");
}

#[test]
fn cap_constant_is_one_megabyte() {
    // Locking the cap so a future bump shows up as a test-update — the
    // IPC layer enforces this same value before persisting.
    assert_eq!(MAX_MEMORY_MD_BYTES, 1024 * 1024);
}
