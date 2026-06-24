//! S12 — IPC commands that drive the Settings → Channels → Mobile
//! section.
//!
//! Three commands:
//!
//! | Command                                | Purpose                                      |
//! |----------------------------------------|----------------------------------------------|
//! | `desktop_mobile_pairing_generate`      | Mint Crockford code + announce to web.       |
//! | `desktop_mobile_pairing_confirm`       | Forward Yes/No to web's `_confirm` webhook.  |
//! | `desktop_mobile_pairing_handle_relay`  | Test-mode entry point for the relay handler. |
//!
//! The Crockford code itself is generated locally via the S8
//! `PairingService::generate(EntityKind::Device, ws)` call. We DO
//! consume that primitive (still inserts the row in desktop SQLite's
//! `pending_pairings`) so the desktop's own audit / cleanup paths see
//! the mobile flow, even though the source-of-truth state lives in
//! web Postgres.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::messenger::{handle_relay_pair_event, MobileSasShownPayload, MessengerEvent};
use crate::pairing::{EntityKind, PairingInitiator, PairingService};
use crate::store::{settings, Store};

use super::error::IpcError;

const WORKSPACE_SETTING_KEY: &str = "current_workspace_id";
const WEB_BASE_URL_SETTING:  &str = "api_url";
const CRON_SECRET_SETTING:   &str = "cron_secret";

// ── Wire shapes ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct MobilePairingStartDto {
    pub challenge_id:     String,
    pub code:             String,
    pub code_chunked:     String,
    pub created_at_ms:    i64,
    pub expires_at_ms:    i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MobilePairingConfirmDto {
    pub resolved:     bool,
    pub approved:     bool,
    pub device_id:    Option<String>,
}

// ── HTTP helpers ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct AnnounceBody {
    workspace_id:  String,
    pairing_code:  String,
    created_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Debug, Deserialize)]
struct AnnounceResp {
    challenge_id: String,
}

#[derive(Debug, Serialize)]
struct ConfirmBody<'a> {
    challenge_id: &'a str,
    approve:      bool,
}

#[derive(Debug, Deserialize)]
struct ConfirmResp {
    resolved: bool,
    approved: Option<bool>,
    device:   Option<ConfirmDevice>,
}

#[derive(Debug, Deserialize)]
struct ConfirmDevice {
    #[serde(rename = "deviceId")]
    device_id: String,
}

fn web_base_url(store: &Arc<Store>) -> Result<String, IpcError> {
    let raw = settings::get(store, WEB_BASE_URL_SETTING)
        .map_err(IpcError::from)?
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://app.inariwatch.com".to_string());
    Ok(raw.trim_end_matches('/').to_string())
}

fn cron_secret(store: &Arc<Store>) -> Result<String, IpcError> {
    settings::get(store, CRON_SECRET_SETTING)
        .map_err(IpcError::from)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| IpcError::Internal {
            message: "no cron_secret in settings — finish desktop login first".to_string(),
        })
}

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

// ── Commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn desktop_mobile_pairing_generate(
    store: tauri::State<'_, Arc<Store>>,
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<MobilePairingStartDto, IpcError> {
    let store = store.inner().clone();
    let ws = current_workspace(&store)?;

    // 1. Mint locally (desktop SQLite + Crockford generator).
    let pending = pairing
        .inner()
        .generate(EntityKind::Device, ws, &PairingInitiator::user())
        .await
        .map_err(|e| IpcError::Internal { message: e.to_string() })?;

    // 2. Announce to web. We use reqwest (same dep the rest of the
    //    app uses for HTTP); on failure we surface but DON'T roll back
    //    the desktop SQLite row — the user can retry the announce by
    //    regenerating, and the original row TTLs after 1h.
    let base = web_base_url(&store)?;
    let secret = cron_secret(&store)?;
    let body = AnnounceBody {
        workspace_id:  ws.simple().to_string(),
        pairing_code:  pending.code.as_str().to_string(),
        created_at_ms: pending.created_at_ms,
        expires_at_ms: pending.expires_at_ms,
    };
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/mobile/pair/_announce"))
        .bearer_auth(secret)
        .json(&body)
        .send()
        .await
        .map_err(|e| IpcError::Internal {
            message: format!("announce request failed: {e}"),
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(IpcError::Internal {
            message: format!("announce returned {status}: {text}"),
        });
    }
    let parsed = resp.json::<AnnounceResp>().await.map_err(|e| IpcError::Internal {
        message: format!("announce response parse: {e}"),
    })?;

    Ok(MobilePairingStartDto {
        challenge_id: parsed.challenge_id,
        code:         pending.code.as_str().to_string(),
        code_chunked: pending.code.chunked(),
        created_at_ms: pending.created_at_ms,
        expires_at_ms: pending.expires_at_ms,
    })
}

#[tauri::command]
pub async fn desktop_mobile_pairing_confirm(
    challenge_id: String,
    approve: bool,
    store: tauri::State<'_, Arc<Store>>,
    pairing: tauri::State<'_, Arc<PairingService>>,
) -> Result<MobilePairingConfirmDto, IpcError> {
    let store = store.inner().clone();
    let base = web_base_url(&store)?;
    let secret = cron_secret(&store)?;
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/mobile/pair/_confirm"))
        .bearer_auth(secret)
        .json(&ConfirmBody {
            challenge_id: &challenge_id,
            approve,
        })
        .send()
        .await
        .map_err(|e| IpcError::Internal {
            message: format!("confirm request failed: {e}"),
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(IpcError::Internal {
            message: format!("confirm returned {status}: {text}"),
        });
    }
    let parsed = resp.json::<ConfirmResp>().await.map_err(|e| IpcError::Internal {
        message: format!("confirm response parse: {e}"),
    })?;

    // Audit symmetry: mirror the paired-device row into desktop SQLite
    // so the existing `desktop_pairing_list` IPC surfaces it too. We
    // only do this on approve=true + when the web returned a device.
    // Local-mirror gap (intentional, S12):
    //
    // We could insert a `paired_entities` row in desktop SQLite here so
    // the existing `desktop_pairing_list` IPC surfaces mobile devices
    // alongside WhatsApp phones (Settings → Channels → Mobile). We
    // deliberately do NOT — PairingService's public surface goes
    // generate -> redeem -> confirm_sas, which assumes a SAS challenge
    // exists in the local in-memory map. Mobile pairings keep the
    // challenge in web Postgres, so calling confirm_sas here would
    // need a private bypass we don't want to introduce on the locked
    // S8 contract.
    //
    // The Settings → Channels → Mobile list will instead fetch from
    // web via a separate IPC in S12.5. Suppress the unused-binding
    // warnings until then.
    let _ = (&pairing, &store, approve, &parsed);

    Ok(MobilePairingConfirmDto {
        resolved:  parsed.resolved,
        approved:  parsed.approved.unwrap_or(false),
        device_id: parsed.device.map(|d| d.device_id),
    })
}

/// Test-only entry point for the relay handler. Production wires this
/// from `relay_client.rs`'s frame dispatcher — not yet implemented in
/// S12 (it lands when the relay's reverse-direction publish endpoint
/// arrives in S12.5). Exposing as `pub` so integration tests in
/// `tests/messenger_mobile.rs` can drive it directly.
pub fn dispatch_relay_pair_event(
    bus: &broadcast::Sender<MessengerEvent>,
    payload: MobileSasShownPayload,
) -> bool {
    handle_relay_pair_event(bus, payload)
}
