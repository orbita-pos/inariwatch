//! Sesión 27 — EAP chip backend smoke test.
//!
//! Exercises the read path the dock's `EAPReceiptChip` follows: insert
//! a remediation session row + an `eap_receipts` row, then call
//! `queries::get_eap_receipt_by_remediation_session` and assert the
//! returned row carries the merkle root + signature + tools/files
//! payload bit-identical to the seed.
//!
//! The IPC command itself takes `tauri::State`; this test reaches into
//! the read helper directly to keep the test free of a Tauri runtime —
//! same pattern as `single_shot_remediation_flow.rs`.

use std::sync::Arc;

use inariwatch_desktop_lib::store::queries::{
    self, NewEapReceipt, NewRemediationSession, RemediationMode,
};
use inariwatch_desktop_lib::store::Store;

fn open_store() -> Arc<Store> {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("eap_chip.db")).expect("open store"),
    );
    std::mem::forget(dir);
    store
}

#[test]
fn eap_chip_renders_seeds_and_reads_back() {
    let store = open_store();

    queries::upsert_repo(&store, "repo-1", "/tmp/repo", "demo", 0)
        .expect("upsert_repo");
    queries::insert_remediation_session(
        &store,
        &NewRemediationSession {
            id:                "sess-1",
            repo_id:           "repo-1",
            mode:              RemediationMode::Local,
            error_fingerprint: Some("fp-eap"),
            error_message:     Some("test error"),
            created_at_ms:     0,
        },
    )
    .expect("insert session");

    let merkle = "9af3c8b2d6e5f4c3a2b1d0e9f8c7b6a59f1c3a8b7d6e5f4c3a2b1d0e9f8c7b6a";
    let signature = "ed25519:abc123";
    let tools_json = r#"[{"name":"read_file","args":{"path":"src/main.rs"}}]"#;
    let files_json = r#"["src/main.rs","tests/main.rs"]"#;

    let inserted = queries::insert_eap_receipt(
        &store,
        &NewEapReceipt {
            receipt_id:             merkle,
            remediation_session_id: "sess-1",
            merkle_root:            merkle,
            signature:              Some(signature),
            signed:                 true,
            prompt_hash:            Some("hash_xyz"),
            system_prompt:          Some("You are Inari, an AI fix engineer."),
            tools_called_json:      tools_json,
            files_read_json:        files_json,
            model:                  Some("gpt-5.4"),
            recording_id:           Some("rec_abc"),
            attestor:               "inariwatch",
            created_at_ms:          1_000,
        },
    )
    .expect("insert receipt");
    assert_eq!(inserted, 1, "insert should report 1 new row");

    // PK collision → INSERT OR IGNORE keeps the original row.
    let dup = queries::insert_eap_receipt(
        &store,
        &NewEapReceipt {
            receipt_id:             merkle,
            remediation_session_id: "sess-1",
            merkle_root:            merkle,
            signature:              Some(signature),
            signed:                 true,
            prompt_hash:            None,
            system_prompt:          None,
            tools_called_json:      "[]",
            files_read_json:        "[]",
            model:                  None,
            recording_id:           Some("rec_abc"),
            attestor:               "inariwatch",
            created_at_ms:          2_000,
        },
    )
    .expect("re-insert");
    assert_eq!(dup, 0, "re-insert of same Merkle root must be a no-op");

    let row = queries::get_eap_receipt_by_remediation_session(&store, "sess-1")
        .expect("query")
        .expect("row present");

    assert_eq!(row.receipt_id, merkle);
    assert_eq!(row.merkle_root, merkle);
    assert_eq!(row.signature.as_deref(), Some(signature));
    assert!(row.signed);
    assert_eq!(row.prompt_hash.as_deref(), Some("hash_xyz"));
    assert!(row.system_prompt.unwrap().contains("Inari"));
    assert_eq!(row.tools_called_json, tools_json);
    assert_eq!(row.files_read_json,   files_json);
    assert_eq!(row.model.as_deref(),         Some("gpt-5.4"));
    assert_eq!(row.recording_id.as_deref(),  Some("rec_abc"));
    assert_eq!(row.attestor, "inariwatch");
    assert_eq!(row.created_at_ms, 1_000);

    let none = queries::get_eap_receipt_by_remediation_session(&store, "sess-missing")
        .expect("query");
    assert!(none.is_none(), "unattested session must read None");
}
