//! Tauri commands for the EAP receipt chip (Sesión 27).
//!
//! One read: `get_receipt_for_session(session_id)`. Returns the
//! mirrored EAP attestation row (Merkle root, prompt hash, tools
//! called, files read, model, signature, timestamp) so the dock's
//! `EAPReceiptChip` can render the chip + popover without a
//! round-trip to the cloud.
//!
//! Heavy fields (`tools_called`, `files_read`) ship as JSON strings
//! so the wire shape stays schema-agnostic; the chip's popover
//! decodes them client-side. The IPC payload is bounded by the
//! row's TEXT columns — well below the 100 KB heavy-data ceiling.
//!
//! Absence is *not* an error: an unattested session returns
//! `Ok(None)` and the chip renders its "Unsigned" affordance.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::lib_eap_verify::{derive_key_id, EAP_FORMAT_VERSION};
use crate::store::{queries, Store};

use super::error::IpcError;

/// Wire shape for an EAP receipt. Deliberately mirrors
/// [`queries::EapReceiptRow`] so the IPC seam is a thin renaming
/// pass — no business logic. `signed` reflects whether the EAP
/// server had an attestor keypair when the receipt was minted; the
/// chip uses it to swap between "signed" and "Merkle-only" copy.
#[derive(Debug, Clone, Serialize)]
pub struct EapReceiptDto {
    pub receipt_id:             String,
    pub remediation_session_id: String,
    pub merkle_root:            String,
    pub signature:              Option<String>,
    pub signed:                 bool,
    pub prompt_hash:            Option<String>,
    pub system_prompt:          Option<String>,
    /// JSON-encoded array. Free shape — decoded by the popover.
    pub tools_called_json:      String,
    /// JSON-encoded array. Free shape — decoded by the popover.
    pub files_read_json:        String,
    pub model:                  Option<String>,
    pub recording_id:           Option<String>,
    pub attestor:               String,
    pub created_at_ms:          i64,
}

impl From<queries::EapReceiptRow> for EapReceiptDto {
    fn from(row: queries::EapReceiptRow) -> Self {
        Self {
            receipt_id:             row.receipt_id,
            remediation_session_id: row.remediation_session_id,
            merkle_root:            row.merkle_root,
            signature:              row.signature,
            signed:                 row.signed,
            prompt_hash:            row.prompt_hash,
            system_prompt:          row.system_prompt,
            tools_called_json:      row.tools_called_json,
            files_read_json:        row.files_read_json,
            model:                  row.model,
            recording_id:           row.recording_id,
            attestor:               row.attestor,
            created_at_ms:          row.created_at_ms,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct GetReceiptArgs {
    pub session_id: String,
}

#[tauri::command]
pub async fn get_receipt_for_session(
    state: tauri::State<'_, Arc<Store>>,
    args:  GetReceiptArgs,
) -> Result<Option<EapReceiptDto>, IpcError> {
    let store_arc: Arc<Store> = state.inner().clone();
    let row = queries::get_eap_receipt_by_remediation_session(&store_arc, &args.session_id)?;
    Ok(row.map(EapReceiptDto::from))
}

// ── Sesión 28 — export receipt as `.eap.json` ─────────────────────────
//
// Writes a self-contained receipt file the standalone `inari-verify`
// CLI binary (and the future `verify.inariwatch.com` web verifier)
// can validate without hitting any InariWatch service. The file
// format mirrors `lib_eap_verify::EapReceipt`.
//
// Network is best-effort: when `EAP_SERVER_URL` is set, we fetch the
// attestor's public key from `/attestor` so the exported file is
// fully verifiable. When unset / unreachable / the server has no
// keypair, we still write the file but with `public_key: null` →
// `inari-verify` prints a Merkle-only PASS in that case.
//
// The native save-dialog runs INSIDE this command (via DialogExt,
// same pattern as `desktop_pick_watch_dir` in `ipc/onboarding.rs`).
// The frontend therefore needs zero new deps — no JS shim, no
// `@tauri-apps/plugin-dialog` package — it just calls the IPC
// command and lets the daemon handle picker → write atomically.
// `Ok(None)` represents the user cancelling the picker; `Err(...)`
// is reserved for genuine failures (DB miss, write failure, etc).

#[derive(Debug, Deserialize)]
pub struct ExportReceiptArgs {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
pub struct ExportReceiptResult {
    pub path:       String,
    /// True when we were able to bake the attestor public key into the
    /// file. When false, the consumer (`inari-verify`) will report a
    /// Merkle-only PASS instead of a signature-verified PASS.
    pub has_public_key: bool,
}

#[tauri::command]
pub async fn export_eap_receipt(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    args:  ExportReceiptArgs,
) -> Result<Option<ExportReceiptResult>, IpcError> {
    let store_arc: Arc<Store> = state.inner().clone();
    let row = queries::get_eap_receipt_by_remediation_session(&store_arc, &args.session_id)?
        .ok_or_else(|| IpcError::internal(format!(
            "no EAP receipt mirrored for session {}", args.session_id,
        )))?;

    // ── Native save dialog ──────────────────────────────────────────
    // Same oneshot-channel pattern as `desktop_pick_watch_dir`. The
    // dialog plugin's `save_file` invokes our callback once with the
    // user's pick (or None on cancel).
    let truncated = if row.receipt_id.len() >= 12 {
        &row.receipt_id[..12]
    } else {
        &row.receipt_id
    };
    let default_name = format!("inari-receipt-{truncated}.eap.json");

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    let tx = std::sync::Mutex::new(Some(tx));

    app.dialog()
        .file()
        .set_title("Export EAP attestation receipt")
        .set_file_name(&default_name)
        .add_filter("EAP Receipt", &["json"])
        .save_file(move |selected| {
            if let Some(sender) = tx.lock().ok().and_then(|mut s| s.take()) {
                let _ = sender.send(selected.and_then(|p| p.into_path().ok()));
            }
        });

    let dest = match rx.await {
        Ok(Some(p)) => p,
        Ok(None) => return Ok(None), // user cancelled
        Err(e) => {
            return Err(IpcError::internal(format!(
                "save dialog channel closed: {e}"
            )));
        }
    };

    // ── Build + write ───────────────────────────────────────────────
    let public_key = fetch_attestor_public_key().await;
    let key_id = public_key.as_deref().and_then(derive_key_id);

    let body = build_eap_json(&row, public_key.as_deref(), key_id.as_deref());
    std::fs::write(&dest, body.as_bytes())
        .map_err(|e| IpcError::Io { message: format!("write {}: {e}", dest.display()) })?;

    Ok(Some(ExportReceiptResult {
        path:           dest.to_string_lossy().into_owned(),
        has_public_key: public_key.is_some(),
    }))
}

/// Best-effort fetch of the EAP server's current attestor public key.
/// Returns `None` when:
///   - `EAP_SERVER_URL` is unset.
///   - The HTTP call fails / times out / returns non-200.
///   - The server reports `key_available: false`.
///
/// We deliberately swallow errors here — the export still produces a
/// valid `.eap.json` (Merkle-only) when the server is unreachable, so
/// the user is never blocked from saving an audit artifact.
async fn fetch_attestor_public_key() -> Option<String> {
    let base = std::env::var("EAP_SERVER_URL").ok()?;
    let endpoint = format!("{}/attestor", base.trim_end_matches('/'));

    let res = reqwest::Client::new()
        .get(&endpoint)
        .header("accept", "application/json")
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body: serde_json::Value = res.json().await.ok()?;
    if !body.get("key_available").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }
    body.get("public_key")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Render the on-disk `.eap.json` body. Pure function — no I/O — so the
/// shape is unit-testable without a Tauri runtime / SQLite store /
/// network. Pretty-prints (2-space indent) so a human auditor opening
/// the file in a text editor can read it directly.
pub(crate) fn build_eap_json(
    row:        &queries::EapReceiptRow,
    public_key: Option<&str>,
    key_id:     Option<&str>,
) -> String {
    let tools: serde_json::Value =
        serde_json::from_str(&row.tools_called_json).unwrap_or_else(|_| serde_json::json!([]));
    let files: serde_json::Value =
        serde_json::from_str(&row.files_read_json).unwrap_or_else(|_| serde_json::json!([]));

    // Render `created_at_ms` as a stable ISO-8601 UTC string. Using
    // `chrono` (already a workspace dep for the OpenAI client) keeps
    // us off `time` to avoid pulling a second date crate.
    let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(row.created_at_ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default();

    let value = serde_json::json!({
        "version":       EAP_FORMAT_VERSION,
        "receipt_id":    row.receipt_id,
        "merkle_root":   row.merkle_root,
        "signed":        row.signed,
        "signature":     row.signature,
        "public_key":    public_key,
        "key_id":        key_id,
        "attestor":      row.attestor,
        "prompt_hash":   row.prompt_hash,
        "system_prompt": row.system_prompt,
        "tools":         tools,
        "files_read":    files,
        "model":         row.model,
        "timestamp":     timestamp,
        "recording_id":  row.recording_id,
    });

    serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row() -> queries::EapReceiptRow {
        queries::EapReceiptRow {
            receipt_id:             "9af3c8b2d6e5f4c3a2b1d0e9f8c7b6a59f1c3a8b7d6e5f4c3a2b1d0e9f8c7b6a".into(),
            remediation_session_id: "sess-1".into(),
            merkle_root:            "9af3c8b2d6e5f4c3a2b1d0e9f8c7b6a59f1c3a8b7d6e5f4c3a2b1d0e9f8c7b6a".into(),
            signature:              Some("ed25519:abc".into()),
            signed:                 true,
            prompt_hash:            Some("hashxyz".into()),
            system_prompt:          Some("You are Inari".into()),
            tools_called_json:      r#"[{"name":"read","args":"src/main.rs"}]"#.into(),
            files_read_json:        r#"["src/main.rs"]"#.into(),
            model:                  Some("gpt-5.4".into()),
            recording_id:           Some("rec-1".into()),
            attestor:               "inariwatch".into(),
            created_at_ms:          1_700_000_000_000, // 2023-11-14T22:13:20Z
        }
    }

    #[test]
    fn build_eap_json_roundtrips_through_lib_eap_verify_parser() {
        let json = build_eap_json(&sample_row(), Some(&"a".repeat(64)), Some("ab".repeat(8).as_str()));
        let parsed = crate::lib_eap_verify::parse_receipt_str(&json)
            .expect("export must parse with the verifier");
        assert_eq!(parsed.version, EAP_FORMAT_VERSION);
        assert_eq!(parsed.receipt_id, sample_row().receipt_id);
        assert_eq!(parsed.merkle_root, sample_row().receipt_id);
        assert_eq!(parsed.public_key.as_deref(), Some(&*"a".repeat(64)));
        assert!(parsed.attestor.as_deref() == Some("inariwatch"));
        assert!(parsed.timestamp.as_deref().unwrap().starts_with("2023"));
    }

    #[test]
    fn build_eap_json_omits_public_key_when_none() {
        let json = build_eap_json(&sample_row(), None, None);
        let parsed = crate::lib_eap_verify::parse_receipt_str(&json).unwrap();
        assert!(parsed.public_key.is_none());
        assert!(parsed.key_id.is_none());
    }
}
