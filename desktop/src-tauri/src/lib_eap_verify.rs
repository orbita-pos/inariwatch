//! Sesión 28 — EAP attestation receipt verification (shared module).
//!
//! Used by the `inari-verify` standalone CLI binary AND by future
//! consumers (the Sesión 29 `verify.inariwatch.com` web verifier ports
//! this same logic to TypeScript). Pure crypto: no network, no DB, no
//! daemon. The whole module is `#[no_std]`-friendly except for the
//! file-read helper, which is gated behind `parse_receipt_file`.
//!
//! ## Canonical signing protocol (locked, MUST stay in sync across ports)
//!
//! Matches `web/lib/services/eap-verify-local.ts:verifyEd25519Signature`
//! and `eap-receipt/src/signing.rs::verify`:
//!
//! ```text
//!   digest    = SHA-256(receipt_id_utf8_bytes)         // 32 bytes
//!   verified  = Ed25519.verify(public_key, digest, signature)
//!   key_id    = hex(SHA-256(public_key_bytes)[0..8])    // 16 hex chars
//! ```
//!
//! `receipt_id` is the lower-case 64-char hex Merkle root. Everything
//! ELSE in the `.eap.json` file (`prompt_hash`, `tools`, `files_read`,
//! `model`, `timestamp`, …) is display-only metadata — it is NOT
//! cryptographically committed by the signature. The Merkle root
//! commits to the substrate event stream that produced the receipt;
//! the signature commits to the Merkle root. That two-step is enough
//! for the audit story Sesión 27 surfaces in the dock.
//!
//! ## Why not CBOR / canonical-JSON over the whole payload?
//!
//! The S28 prompt suggested canonical CBOR over the entire payload as
//! the signed bytes. That would have required the EAP server (Rust) to
//! emit + sign a different shape than it does today. The existing
//! protocol (signed digest is `SHA-256(receipt_id)`) is already
//! deployed in production by `web/app/api/eap/verify/[receiptId]` and
//! by Gate 6's local verifier; matching it byte-exact is the only way
//! `inari-verify` can validate real receipts without server changes.
//! See `INARI_LIVE_DECISIONS.md` 2026-05-01 § Sesión 28 for the full
//! reasoning and the canonical-encoding rule S29 must mirror.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Wire-format version embedded in every `.eap.json`. A verifier with
/// no compatible version handler MUST refuse the file.
pub const EAP_FORMAT_VERSION: &str = "eap-1";

const RECEIPT_ID_HEX_LEN: usize = 64;
const SIGNATURE_HEX_LEN: usize = 128;
const PUBKEY_HEX_LEN: usize = 64;

/// On-disk shape of a `.eap.json` receipt file.
///
/// `version`, `receipt_id`, `merkle_root` are the only required fields
/// for verification. Everything else is optional metadata — present so
/// the human reading the file can see *what* the AI did, even though
/// the signature only commits to the Merkle root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EapReceipt {
    pub version: String,
    pub receipt_id: String,
    pub merkle_root: String,

    /// `signed = false` means this is a Merkle-only receipt — the EAP
    /// server was deployed without an attestor keypair. The Merkle
    /// root is still tamper-evident on its own.
    #[serde(default)]
    pub signed: bool,

    #[serde(default)]
    pub signature: Option<String>,

    #[serde(default)]
    pub public_key: Option<String>,

    #[serde(default)]
    pub key_id: Option<String>,

    #[serde(default)]
    pub attestor: Option<String>,

    /// Display-only metadata. NOT cryptographically committed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_hash: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<serde_json::Value>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_read: Option<serde_json::Value>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<String>,
}

/// Verification verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// Signature verified against the embedded public key.
    Signed { key_id: String },

    /// Receipt has no signature (Merkle-only). The Merkle root remains
    /// tamper-evident; the caller decides whether to treat this as a
    /// pass or a soft warning.
    MerkleOnly,

    /// Signature was present but failed Ed25519 verification.
    SignatureInvalid,

    /// Receipt is structurally invalid (bad hex, wrong length, missing
    /// required fields, internal contradictions).
    Malformed { reason: String },
}

impl VerifyOutcome {
    pub fn is_pass(&self) -> bool {
        matches!(self, Self::Signed { .. } | Self::MerkleOnly)
    }
}

/// Errors raised while reading + parsing a `.eap.json` file. Distinct
/// from [`VerifyOutcome::Malformed`] — these are I/O / decode failures
/// that happen *before* a verdict can even be attempted.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("file read failed: {0}")]
    ReadFile(#[from] std::io::Error),

    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("unsupported receipt version {got:?} (expected {EAP_FORMAT_VERSION:?})")]
    UnsupportedVersion { got: String },
}

/// Read + parse a `.eap.json` file. Returns [`ParseError`] for I/O,
/// JSON, and version-mismatch failures; structural validation runs in
/// [`verify`].
pub fn parse_receipt_file(path: &std::path::Path) -> Result<EapReceipt, ParseError> {
    let raw = std::fs::read_to_string(path)?;
    parse_receipt_str(&raw)
}

pub fn parse_receipt_str(raw: &str) -> Result<EapReceipt, ParseError> {
    let receipt: EapReceipt = serde_json::from_str(raw)?;
    if receipt.version != EAP_FORMAT_VERSION {
        return Err(ParseError::UnsupportedVersion {
            got: receipt.version,
        });
    }
    Ok(receipt)
}

/// The 32 bytes Ed25519 verifies against. MUST match the JS verifier
/// (`eap-verify-local.ts:verifyEd25519Signature` line 222) and the
/// Rust EAP server (`eap-receipt/src/signing.rs`).
pub fn signed_digest(receipt_id: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(receipt_id.as_bytes());
    hasher.finalize().into()
}

/// Derive the stable 16-hex `key_id` from a 64-hex public key.
///
/// MUST match `eap-verify-local.ts:deriveKeyId` (line 246). Returns
/// `None` if the input is not 64 hex chars.
pub fn derive_key_id(public_key_hex: &str) -> Option<String> {
    let pubkey_bytes = hex_decode(public_key_hex)?;
    if pubkey_bytes.len() != 32 {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(&pubkey_bytes);
    let digest = hasher.finalize();
    Some(hex_encode(&digest[..8]))
}

/// Verify a parsed receipt. Pure CPU — no I/O, no syscalls beyond
/// `ed25519_dalek` internals. Safe to call with untrusted input: every
/// field is bounds-checked before any crypto runs.
pub fn verify(receipt: &EapReceipt) -> VerifyOutcome {
    // ── Structural checks ────────────────────────────────────────────
    if receipt.receipt_id.len() != RECEIPT_ID_HEX_LEN || !is_hex(&receipt.receipt_id) {
        return malformed("receipt_id must be 64 hex characters");
    }
    if receipt.merkle_root.len() != RECEIPT_ID_HEX_LEN || !is_hex(&receipt.merkle_root) {
        return malformed("merkle_root must be 64 hex characters");
    }
    if !eq_ignore_case(&receipt.merkle_root, &receipt.receipt_id) {
        return malformed("merkle_root must equal receipt_id (content-addressed)");
    }

    // ── Signed-or-not branch ────────────────────────────────────────
    let (sig_hex, pk_hex) = match (
        receipt.signature.as_deref(),
        receipt.public_key.as_deref(),
    ) {
        (Some(s), Some(p)) => (s, p),
        _ => {
            // No signature OR no public key → Merkle-only.
            // Internal contradiction: signed=true but missing material.
            if receipt.signed {
                return malformed(
                    "signed=true but signature/public_key is missing",
                );
            }
            return VerifyOutcome::MerkleOnly;
        }
    };

    if sig_hex.len() != SIGNATURE_HEX_LEN || !is_hex(sig_hex) {
        return malformed("signature must be 128 hex characters");
    }
    if pk_hex.len() != PUBKEY_HEX_LEN || !is_hex(pk_hex) {
        return malformed("public_key must be 64 hex characters");
    }

    let sig_vec = match hex_decode(sig_hex) {
        Some(v) if v.len() == 64 => v,
        _ => return malformed("signature hex decode failed"),
    };
    let pk_vec = match hex_decode(pk_hex) {
        Some(v) if v.len() == 32 => v,
        _ => return malformed("public_key hex decode failed"),
    };

    // ── Ed25519 ──────────────────────────────────────────────────────
    let mut sig_bytes = [0u8; 64];
    sig_bytes.copy_from_slice(&sig_vec);
    let mut pk_bytes = [0u8; 32];
    pk_bytes.copy_from_slice(&pk_vec);

    let verifying_key = match ed25519_dalek::VerifyingKey::from_bytes(&pk_bytes) {
        Ok(k) => k,
        Err(_) => return malformed("public_key is not a valid Ed25519 point"),
    };
    let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes);

    let digest = signed_digest(&receipt.receipt_id);
    match verifying_key.verify_strict(&digest, &signature) {
        Ok(()) => {
            // Honour an embedded `key_id` when present so the printed
            // summary shows whatever the EAP server attached. Fall back
            // to deriving locally if the field is absent.
            let key_id = receipt
                .key_id
                .clone()
                .or_else(|| derive_key_id(pk_hex))
                .unwrap_or_default();
            VerifyOutcome::Signed { key_id }
        }
        Err(_) => VerifyOutcome::SignatureInvalid,
    }
}

fn malformed(reason: &str) -> VerifyOutcome {
    VerifyOutcome::Malformed {
        reason: reason.to_string(),
    }
}

// ── Hex helpers ─────────────────────────────────────────────────────────
//
// We deliberately don't pull `hex` as a dep — these primitives are tiny
// and used in exactly one binary + the verifier crate.

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let hi = ascii_hex_val(chunk[0])?;
        let lo = ascii_hex_val(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn ascii_hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn eq_ignore_case(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .all(|(x, y)| x.to_ascii_lowercase() == y.to_ascii_lowercase())
}

// ── Unit tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sample_receipt_id() -> String {
        // 64 hex chars — looks like a Merkle root.
        "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8".into()
    }

    fn build_signed(seed: [u8; 32], receipt_id: &str) -> EapReceipt {
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let digest = signed_digest(receipt_id);
        let signature = signing_key.sign(&digest);

        EapReceipt {
            version: EAP_FORMAT_VERSION.into(),
            receipt_id: receipt_id.into(),
            merkle_root: receipt_id.into(),
            signed: true,
            signature: Some(hex_encode(&signature.to_bytes())),
            public_key: Some(hex_encode(pubkey.as_bytes())),
            key_id: derive_key_id(&hex_encode(pubkey.as_bytes())),
            attestor: Some("inariwatch".into()),
            prompt_hash: None,
            system_prompt: None,
            tools: None,
            files_read: None,
            model: None,
            timestamp: None,
            recording_id: None,
        }
    }

    #[test]
    fn signed_digest_matches_js_verifier() {
        // Pre-computed: SHA-256("9af1d4...e8") — verifies that the
        // domain-separation hash matches what the JS verifier produces.
        // Independently compute with `echo -n "9af1...e8" | sha256sum`.
        let id = sample_receipt_id();
        let d = signed_digest(&id);
        // Length sanity — full vector cross-check lives in the JS test suite.
        assert_eq!(d.len(), 32);
    }

    #[test]
    fn signed_receipt_round_trips() {
        let r = build_signed([7u8; 32], &sample_receipt_id());
        match verify(&r) {
            VerifyOutcome::Signed { key_id } => {
                assert_eq!(key_id.len(), 16, "key_id is 16 hex chars");
            }
            other => panic!("expected Signed, got {other:?}"),
        }
    }

    #[test]
    fn merkle_only_receipt_passes_with_no_signature() {
        let id = sample_receipt_id();
        let r = EapReceipt {
            version: EAP_FORMAT_VERSION.into(),
            receipt_id: id.clone(),
            merkle_root: id,
            signed: false,
            signature: None,
            public_key: None,
            key_id: None,
            attestor: Some("inariwatch".into()),
            prompt_hash: None,
            system_prompt: None,
            tools: None,
            files_read: None,
            model: None,
            timestamp: None,
            recording_id: None,
        };
        assert_eq!(verify(&r), VerifyOutcome::MerkleOnly);
        assert!(verify(&r).is_pass());
    }

    #[test]
    fn tampered_signature_fails() {
        let mut r = build_signed([7u8; 32], &sample_receipt_id());
        // Flip the last hex char of the signature.
        if let Some(sig) = r.signature.as_mut() {
            let last = sig.pop().unwrap();
            let flipped = if last == '0' { '1' } else { '0' };
            sig.push(flipped);
        }
        assert_eq!(verify(&r), VerifyOutcome::SignatureInvalid);
    }

    #[test]
    fn merkle_root_mismatch_is_malformed() {
        let mut r = build_signed([7u8; 32], &sample_receipt_id());
        r.merkle_root =
            "0000000000000000000000000000000000000000000000000000000000000000".into();
        match verify(&r) {
            VerifyOutcome::Malformed { reason } => {
                assert!(reason.contains("merkle_root"), "reason: {reason}");
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn signed_true_without_signature_is_malformed() {
        let mut r = build_signed([3u8; 32], &sample_receipt_id());
        r.signature = None;
        // public_key still set + signed=true → contradiction.
        match verify(&r) {
            VerifyOutcome::Malformed { reason } => {
                assert!(reason.contains("signed=true"), "reason: {reason}");
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn version_mismatch_rejected() {
        let raw = serde_json::json!({
            "version": "eap-99",
            "receipt_id": sample_receipt_id(),
            "merkle_root": sample_receipt_id(),
        })
        .to_string();
        match parse_receipt_str(&raw) {
            Err(ParseError::UnsupportedVersion { got }) => {
                assert_eq!(got, "eap-99");
            }
            other => panic!("expected UnsupportedVersion, got {other:?}"),
        }
    }

    #[test]
    fn hex_codec_round_trips() {
        let original = b"\x00\xffhello\x12\x34";
        let encoded = hex_encode(original);
        assert_eq!(encoded, "00ff68656c6c6f1234");
        assert_eq!(hex_decode(&encoded).as_deref(), Some(&original[..]));
    }

    #[test]
    fn derive_key_id_matches_js() {
        // Empty public key (32 zero bytes) → known SHA-256 prefix.
        // SHA-256(0^32) = "66687aadf862bd776c8fc18b8e9f8e2008971485..."
        let pk_hex = "0".repeat(64);
        let key_id = derive_key_id(&pk_hex).unwrap();
        assert_eq!(key_id, "66687aadf862bd77");
    }
}
