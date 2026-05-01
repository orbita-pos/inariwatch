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

use std::sync::Arc;

use serde::{Deserialize, Serialize};

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
