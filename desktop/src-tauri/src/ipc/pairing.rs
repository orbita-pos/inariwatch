//! v0.3 S8 — pairing IPC surface.
//!
//! Six commands that drive the Settings → Channels UI:
//!
//! | Command                        | Purpose                                       |
//! |--------------------------------|-----------------------------------------------|
//! | `desktop_pairing_generate`     | Issue a fresh Crockford code.                 |
//! | `desktop_pairing_list`         | List active paired entities for the workspace.|
//! | `desktop_pairing_revoke`       | Soft-revoke a paired entity.                  |
//! | `desktop_pairing_confirm`      | Yes/No on a SAS challenge. Yes → row inserted.|
//! | `desktop_pairing_pending_count`| Telemetry: how many active pending codes.     |
//! | `desktop_pairing_cleanup`      | Sweep expired pending rows + stale challenges.|
//!
//! ## Workspace scoping
//!
//! Inari Live's local store is single-workspace today (the dashboard
//! returns one and we persist its UUID under the
//! `current_workspace_id` setting once the user connects). Until a
//! workspace switcher exists, the IPC commands resolve the workspace
//! from that setting; an unset setting yields an
//! [`IpcError::Internal`] so the frontend can prompt the user to
//! finish the desktop-auth flow.
//!
//! ## What this module does NOT do
//!
//! - `redeem` — that path is exclusively driven by the messenger
//!   gateway (a frontend caller redeeming would mean the desktop
//!   itself was the remote messenger, which is a different feature).
//!   Frontend can pass `redeem` calls through the SAS flow only via
//!   the SAS confirm command.

use std::sync::Arc;

use serde::Serialize;
use uuid::Uuid;

use crate::pairing::{EntityKind, PairedEntity, PairingError, PairingInitiator, PairingService};
use crate::store::{settings, Store};

use super::error::IpcError;

const WORKSPACE_SETTING_KEY: &str = "current_workspace_id";

// ── Wire shapes ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PendingPairingDto {
    pub id: String,
    pub code: String,
    /// User-friendly chunked form (`ABCD-EFGH`).
    pub code_chunked: String,
    pub kind: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairedEntityDto {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    /// Already redacted for the UI (last 4 of phone, etc.). Frontend
    /// should never see the full identifier.
    pub redacted_identifier: String,
    pub paired_at_ms: i64,
    pub last_seen_at_ms: i64,
}

impl PairedEntityDto {
    fn from_entity(entity: PairedEntity) -> Self {
        let kind_str = match entity.kind {
            EntityKind::Phone => "phone",
            EntityKind::Device => "device",
        };
        let channel = match entity.kind {
            EntityKind::Phone  => crate::messenger::ChannelKind::WhatsApp,
            // S12 — mobile-paired devices redact via the mobile channel
            // (device-pubkey shape, not phone shape).
            EntityKind::Device => crate::messenger::ChannelKind::MobileDevice,
        };
        let redacted_identifier =
            crate::messenger::redact_identifier(channel, &entity.identifier);
        Self {
            id: entity.id.simple().to_string(),
            kind: kind_str.to_string(),
            display_name: entity.display_name,
            redacted_identifier,
            paired_at_ms: entity.paired_at_ms,
            last_seen_at_ms: entity.last_seen_at_ms,
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn current_workspace(store: &Arc<Store>) -> Result<Uuid, IpcError> {
    let raw = settings::get(store, WORKSPACE_SETTING_KEY)
        .map_err(IpcError::from)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| IpcError::Internal {
            message: "no workspace selected — finish desktop login first".to_string(),
        })?;
    Uuid::parse_str(&raw).map_err(|e| IpcError::Internal {
        message: format!("workspace id malformed in settings: {e}"),
    })
}

fn pairing_err_to_ipc(err: PairingError) -> IpcError {
    IpcError::Internal {
        message: err.to_string(),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn desktop_pairing_generate(
    kind: String,
    store: tauri::State<'_, Arc<Store>>,
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<PendingPairingDto, IpcError> {
    let entity_kind = match kind.as_str() {
        "phone" => EntityKind::Phone,
        "device" => EntityKind::Device,
        other => {
            return Err(IpcError::Internal {
                message: format!("unknown pairing kind {other:?}"),
            })
        }
    };
    let ws = current_workspace(&store.inner().clone())?;
    let pending = pairing
        .inner()
        .generate(entity_kind, ws, &PairingInitiator::user())
        .await
        .map_err(pairing_err_to_ipc)?;

    Ok(PendingPairingDto {
        id: pending.id.simple().to_string(),
        code: pending.code.as_str().to_string(),
        code_chunked: pending.code.chunked(),
        kind: kind,
        created_at_ms: pending.created_at_ms,
        expires_at_ms: pending.expires_at_ms,
    })
}

#[tauri::command]
pub async fn desktop_pairing_list(
    store: tauri::State<'_, Arc<Store>>,
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<Vec<PairedEntityDto>, IpcError> {
    let ws = current_workspace(&store.inner().clone())?;
    let entities = pairing
        .inner()
        .list(ws)
        .await
        .map_err(pairing_err_to_ipc)?;
    Ok(entities.into_iter().map(PairedEntityDto::from_entity).collect())
}

#[tauri::command]
pub async fn desktop_pairing_revoke(
    entity_id: String,
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<(), IpcError> {
    let id = Uuid::parse_str(&entity_id).map_err(|e| IpcError::Internal {
        message: format!("invalid entity_id: {e}"),
    })?;
    pairing
        .inner()
        .revoke(id)
        .await
        .map_err(pairing_err_to_ipc)
}

#[tauri::command]
pub async fn desktop_pairing_confirm(
    challenge_id: String,
    approve: bool,
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<Option<PairedEntityDto>, IpcError> {
    let id = Uuid::parse_str(&challenge_id).map_err(|e| IpcError::Internal {
        message: format!("invalid challenge_id: {e}"),
    })?;
    let entity = pairing
        .inner()
        .confirm_sas(id, approve)
        .await
        .map_err(pairing_err_to_ipc)?;
    Ok(entity.map(PairedEntityDto::from_entity))
}

#[tauri::command]
pub async fn desktop_pairing_cleanup(
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<usize, IpcError> {
    pairing
        .inner()
        .cleanup_expired()
        .await
        .map_err(pairing_err_to_ipc)
}

// ── /whatsapp slash-command resolver ────────────────────────────────────────

/// Wire shape for `desktop_whatsapp_list_paired`. UNREDACTED — this is
/// the only IPC that hands the full E.164 to the frontend, and ONLY
/// for the slash command that needs it (to feed `comm.send_whatsapp`'s
/// `to` parameter). Surface name is `_list_paired` not `_list` so the
/// privacy-relaxed semantics are obvious at the call site.
#[derive(Debug, Clone, Serialize)]
pub struct WhatsAppPairedDto {
    pub entity_id: String,
    pub display_name: String,
    /// E.164 with leading `+`. Slash dispatcher uses this verbatim as
    /// the `to` arg of `comm.send_whatsapp`.
    pub phone: String,
    /// Same redacted form `desktop_pairing_list` returns — used by the
    /// slash dispatcher's "ambiguous match" disambiguation hint.
    pub redacted: String,
}

/// List all active paired WhatsApp entities WITH unredacted phone.
/// Used exclusively by the `/whatsapp` slash command to resolve a
/// display-name typed by the user into an E.164 the messenger tool
/// accepts. Filters out revoked entities + non-phone kinds.
#[tauri::command]
pub async fn desktop_whatsapp_list_paired(
    store: tauri::State<'_, Arc<Store>>,
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<Vec<WhatsAppPairedDto>, IpcError> {
    let ws = current_workspace(&store.inner().clone())?;
    let entities = pairing
        .inner()
        .list(ws)
        .await
        .map_err(pairing_err_to_ipc)?;
    let out = entities
        .into_iter()
        .filter(|e| matches!(e.kind, EntityKind::Phone) && e.revoked_at_ms.is_none())
        .map(|e| {
            let redacted = crate::messenger::redact_identifier(
                crate::messenger::ChannelKind::WhatsApp,
                &e.identifier,
            );
            WhatsAppPairedDto {
                entity_id: e.id.simple().to_string(),
                display_name: e.display_name,
                phone: e.identifier,
                redacted,
            }
        })
        .collect();
    Ok(out)
}
