//! `inari-verify` — standalone EAP attestation receipt verifier.
//!
//! Sesión 28 (v0.2). Reads a `.eap.json` file (the format the dock
//! "Export receipt" button writes) and validates the Ed25519 signature
//! over `SHA-256(receipt_id)`. Pure crypto: no daemon, no DB, no
//! network. Distributable as a standalone binary (Mac/Win/Linux) so
//! third-party auditors can verify InariWatch receipts without
//! installing the desktop app.
//!
//! Usage:
//!     inari-verify <path-to-receipt.eap.json>
//!     inari-verify --help
//!
//! Exit codes:
//!     0 — PASS  (signed + verified, OR Merkle-only receipt)
//!     1 — FAIL  (signature invalid OR receipt structurally malformed)
//!     2 — file/parse error (cannot read file, invalid JSON, version
//!         mismatch, etc.) — i.e. couldn't even attempt verification

use std::path::PathBuf;
use std::process::ExitCode;

use inariwatch_desktop_lib::lib_eap_verify::{
    parse_receipt_file, verify, EapReceipt, VerifyOutcome,
};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let path_arg = match args.next() {
        Some(s) if matches!(s.as_str(), "-h" | "--help") => {
            print_usage();
            return ExitCode::SUCCESS;
        }
        Some(s) if matches!(s.as_str(), "-V" | "--version") => {
            println!("inari-verify {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some(s) => s,
        None => {
            eprintln!("inari-verify: missing argument <path-to-receipt.eap.json>\n");
            print_usage();
            return ExitCode::from(2);
        }
    };
    if args.next().is_some() {
        eprintln!("inari-verify: too many arguments\n");
        print_usage();
        return ExitCode::from(2);
    }

    let path = PathBuf::from(&path_arg);
    let receipt = match parse_receipt_file(&path) {
        Ok(r) => r,
        Err(err) => {
            eprintln!(
                "inari-verify: cannot read receipt at {} — {err}",
                path.display()
            );
            return ExitCode::from(2);
        }
    };

    let outcome = verify(&receipt);
    print_summary(&path, &receipt, &outcome);

    match outcome {
        // Merkle-only is informational PASS — the file is well-formed
        // and the Merkle root is tamper-evident on its own. Callers
        // that need a stronger signal can grep stdout for "signed".
        VerifyOutcome::Signed { .. } | VerifyOutcome::MerkleOnly => ExitCode::SUCCESS,
        VerifyOutcome::SignatureInvalid | VerifyOutcome::Malformed { .. } => {
            ExitCode::from(1)
        }
    }
}

fn print_usage() {
    println!(
        "inari-verify — verify an InariWatch EAP attestation receipt.\n\
         \n\
         USAGE:\n    \
         inari-verify <path-to-receipt.eap.json>\n\
         \n\
         FLAGS:\n    \
         -h, --help       Print this message and exit.\n    \
         -V, --version    Print the inari-verify version.\n\
         \n\
         EXIT CODES:\n    \
         0    PASS — signature verified, OR Merkle-only receipt.\n    \
         1    FAIL — signature invalid OR receipt malformed.\n    \
         2    File/parse error — couldn't even attempt verification.\n\
         \n\
         The verifier does NOT touch the network. It validates the\n\
         Ed25519 signature embedded in the file against SHA-256 of\n\
         the receipt_id. The Merkle root commits to the recorded\n\
         events; the signature commits to the Merkle root.\n\
         \n\
         Learn more: https://verify.inariwatch.com",
    );
}

fn print_summary(path: &std::path::Path, receipt: &EapReceipt, outcome: &VerifyOutcome) {
    let header = match outcome {
        VerifyOutcome::Signed { key_id } => {
            format!("PASS  signature verified (attestor key {key_id})")
        }
        VerifyOutcome::MerkleOnly => {
            "PASS  Merkle-only receipt (no signature minted by attestor)".into()
        }
        VerifyOutcome::SignatureInvalid => {
            "FAIL  Ed25519 signature does NOT verify against the embedded public key".into()
        }
        VerifyOutcome::Malformed { reason } => {
            format!("FAIL  receipt is malformed — {reason}")
        }
    };
    println!("{header}");
    println!();
    println!("  file         {}", path.display());
    println!("  version      {}", receipt.version);
    println!("  receipt_id   {}", receipt.receipt_id);
    println!("  merkle_root  {}", receipt.merkle_root);

    if let Some(att) = &receipt.attestor {
        println!("  attestor     {att}");
    }
    if let Some(pk) = &receipt.public_key {
        println!("  public_key   {pk}");
    }
    if let Some(kid) = &receipt.key_id {
        println!("  key_id       {kid}");
    }
    if let Some(ts) = &receipt.timestamp {
        println!("  timestamp    {ts}");
    }
    if let Some(model) = &receipt.model {
        println!("  model        {model}");
    }
    if let Some(ph) = &receipt.prompt_hash {
        println!("  prompt_hash  {ph}");
    }
    if let Some(rid) = &receipt.recording_id {
        println!("  recording_id {rid}");
    }
    if let Some(sp) = &receipt.system_prompt {
        let trimmed = if sp.chars().count() > 200 {
            let mut s: String = sp.chars().take(200).collect();
            s.push('…');
            s
        } else {
            sp.clone()
        };
        println!("  system       {trimmed}");
    }
    if let Some(serde_json::Value::Array(t)) = &receipt.tools {
        if !t.is_empty() {
            println!("  tools        {} tool call(s)", t.len());
        }
    }
    if let Some(serde_json::Value::Array(f)) = &receipt.files_read {
        if !f.is_empty() {
            println!("  files_read   {} file(s)", f.len());
        }
    }

    println!();
    match outcome {
        VerifyOutcome::Signed { .. } => {
            println!(
                "The Ed25519 signature commits to SHA-256(receipt_id). The Merkle"
            );
            println!(
                "root commits to the recorded events. Together they prove the AI"
            );
            println!(
                "fix is the one the attestor signed, against the events recorded."
            );
        }
        VerifyOutcome::MerkleOnly => {
            println!(
                "No signature was minted (the EAP server was deployed without an"
            );
            println!(
                "attestor keypair). The Merkle root remains tamper-evident on its"
            );
            println!("own — but cannot be tied back to a specific attestor identity.");
        }
        VerifyOutcome::SignatureInvalid => {
            println!(
                "The receipt has been tampered, OR the embedded public_key is not"
            );
            println!(
                "the one the attestor used. Re-export from the dock to refresh."
            );
        }
        VerifyOutcome::Malformed { .. } => {
            println!(
                "The receipt is structurally invalid. If you exported it from the"
            );
            println!(
                "dock and got this error, please report at https://inariwatch.com/help"
            );
        }
    }
}
