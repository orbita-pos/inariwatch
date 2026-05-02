//! Sesión 28 — `inari-verify` happy path.
//!
//! Generate a real Ed25519 keypair in-test, sign `SHA-256(receipt_id)`,
//! emit a `.eap.json` file matching the format `EAPReceiptChip`'s
//! "Export receipt" button writes, then run the `inari-verify` binary
//! against it. Asserts exit code 0 + a `PASS` line on stdout.
//!
//! This test does NOT touch the EAP server, the desktop daemon, the
//! local SQLite store, or the network. It exercises the cryptographic
//! protocol end-to-end as a third-party auditor would experience it:
//! receive a JSON file → run the binary → trust the verdict.

use std::process::Command;

use ed25519_dalek::{Signer, SigningKey};
use inariwatch_desktop_lib::lib_eap_verify::{derive_key_id, hex_encode, signed_digest};

/// 64-hex Merkle root used as the receipt id.
const RECEIPT_ID: &str =
    "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8";

#[test]
fn verifies_a_real_signature_with_exit_zero() {
    // ── Build a signed receipt ─────────────────────────────────────────
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let pubkey = signing_key.verifying_key();
    let digest = signed_digest(RECEIPT_ID);
    let signature = signing_key.sign(&digest);

    let pubkey_hex = hex_encode(pubkey.as_bytes());
    let signature_hex = hex_encode(&signature.to_bytes());

    let receipt_json = serde_json::json!({
        "version":      "eap-1",
        "receipt_id":   RECEIPT_ID,
        "merkle_root":  RECEIPT_ID,
        "signed":       true,
        "signature":    signature_hex,
        "public_key":   pubkey_hex,
        "key_id":       derive_key_id(&pubkey_hex),
        "attestor":     "inariwatch",
        "model":        "gpt-5.4",
        "prompt_hash":  "0".repeat(64),
        "timestamp":    "2026-05-01T00:00:00Z",
        "tools":        [{"name": "read_file", "args": {"path": "src/main.rs"}}],
        "files_read":   ["src/main.rs", "tests/main.rs"],
    });

    let tmp = tempfile::NamedTempFile::with_suffix(".eap.json").expect("tempfile");
    std::fs::write(
        tmp.path(),
        serde_json::to_string_pretty(&receipt_json).unwrap(),
    )
    .expect("write receipt");

    // ── Run the binary ────────────────────────────────────────────────
    let bin = env!("CARGO_BIN_EXE_inari-verify");
    let out = Command::new(bin)
        .arg(tmp.path())
        .output()
        .expect("inari-verify spawn");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    assert_eq!(
        out.status.code(),
        Some(0),
        "expected exit 0 (PASS); got {:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status.code(),
        stdout,
        stderr,
    );
    assert!(
        stdout.contains("PASS"),
        "expected PASS on stdout; got:\n{stdout}"
    );
    assert!(
        stdout.contains(RECEIPT_ID),
        "expected receipt_id on stdout; got:\n{stdout}"
    );
}

#[test]
fn merkle_only_receipt_passes_with_exit_zero() {
    // No signature, no public key, signed=false → Merkle-only PASS.
    let receipt_json = serde_json::json!({
        "version":     "eap-1",
        "receipt_id":  RECEIPT_ID,
        "merkle_root": RECEIPT_ID,
        "signed":      false,
        "attestor":    "inariwatch",
    });

    let tmp = tempfile::NamedTempFile::with_suffix(".eap.json").expect("tempfile");
    std::fs::write(tmp.path(), receipt_json.to_string()).expect("write");

    let bin = env!("CARGO_BIN_EXE_inari-verify");
    let out = Command::new(bin)
        .arg(tmp.path())
        .output()
        .expect("inari-verify spawn");

    assert_eq!(
        out.status.code(),
        Some(0),
        "Merkle-only must exit 0 (informational PASS)"
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("PASS"));
    assert!(
        stdout.contains("Merkle-only"),
        "stdout should call out the Merkle-only nature; got:\n{stdout}"
    );
}
