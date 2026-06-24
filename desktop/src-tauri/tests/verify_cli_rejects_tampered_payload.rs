//! Sesión 28 — tampered receipt is rejected with a non-zero exit.
//!
//! Three variants cover the most common tampering vectors a verifier
//! must defend against:
//!   1. Signature byte flipped — Ed25519 verify fails.
//!   2. Receipt id changed but signature kept — verify fails (digest
//!      input no longer matches what the attestor signed).
//!   3. Merkle root mutated to disagree with receipt id — structural
//!      Malformed (the content-address invariant).
//!
//! All three MUST exit with code 1 (FAIL). Exit 2 is reserved for
//! file/parse errors — we never want a tampered-payload response to
//! be confused with "couldn't read the file".

use std::process::Command;

use ed25519_dalek::{Signer, SigningKey};
use inariwatch_desktop_lib::lib_eap_verify::{hex_encode, signed_digest};

const RECEIPT_ID: &str =
    "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8";
const FAKE_RECEIPT_ID: &str =
    "0000000000000000000000000000000000000000000000000000000000000001";

fn build_signed_receipt() -> serde_json::Value {
    let signing_key = SigningKey::from_bytes(&[42u8; 32]);
    let pubkey = signing_key.verifying_key();
    let digest = signed_digest(RECEIPT_ID);
    let signature = signing_key.sign(&digest);
    serde_json::json!({
        "version":     "eap-1",
        "receipt_id":  RECEIPT_ID,
        "merkle_root": RECEIPT_ID,
        "signed":      true,
        "signature":   hex_encode(&signature.to_bytes()),
        "public_key":  hex_encode(pubkey.as_bytes()),
        "attestor":    "inariwatch",
    })
}

fn run_and_capture(json: &serde_json::Value) -> (Option<i32>, String, String) {
    let tmp = tempfile::NamedTempFile::with_suffix(".eap.json").expect("tempfile");
    std::fs::write(tmp.path(), json.to_string()).expect("write");

    let bin = env!("CARGO_BIN_EXE_inari-verify");
    let out = Command::new(bin)
        .arg(tmp.path())
        .output()
        .expect("spawn inari-verify");

    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn tampered_signature_byte_fails_with_exit_one() {
    let mut receipt = build_signed_receipt();
    let sig = receipt
        .get_mut("signature")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .expect("signature present");
    // Flip the LAST hex char so the signature decodes to 64 bytes
    // (still a syntactically valid signature) but Ed25519 rejects it.
    let mut flipped = sig.clone();
    let last = flipped.pop().unwrap();
    let new_last = if last == '0' { '1' } else { '0' };
    flipped.push(new_last);
    receipt["signature"] = serde_json::Value::String(flipped);

    let (code, stdout, _) = run_and_capture(&receipt);
    assert_eq!(code, Some(1), "expected FAIL exit 1, got {:?}", code);
    assert!(stdout.contains("FAIL"), "stdout should report FAIL: {stdout}");
}

#[test]
fn receipt_id_swapped_but_signature_kept_fails() {
    let mut receipt = build_signed_receipt();
    receipt["receipt_id"] = serde_json::Value::String(FAKE_RECEIPT_ID.into());
    receipt["merkle_root"] = serde_json::Value::String(FAKE_RECEIPT_ID.into());
    // signature still covers the original RECEIPT_ID's digest.

    let (code, stdout, _) = run_and_capture(&receipt);
    assert_eq!(code, Some(1));
    assert!(stdout.contains("FAIL"));
    // Specifically should be SignatureInvalid (the structure is fine).
    assert!(
        stdout.contains("signature does NOT verify")
            || stdout.contains("does NOT verify"),
        "stdout: {stdout}"
    );
}

#[test]
fn merkle_root_disagrees_with_receipt_id_is_malformed() {
    let mut receipt = build_signed_receipt();
    // Mutate ONLY the merkle root to break the content-address invariant.
    receipt["merkle_root"] = serde_json::Value::String(FAKE_RECEIPT_ID.into());

    let (code, stdout, _) = run_and_capture(&receipt);
    assert_eq!(code, Some(1));
    assert!(stdout.contains("FAIL"));
    assert!(
        stdout.contains("malformed"),
        "should call out malformed: {stdout}"
    );
}
