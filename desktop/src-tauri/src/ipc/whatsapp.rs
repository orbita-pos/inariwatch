//! v0.3 S5 — Tauri commands for the Baileys WhatsApp sidecar.
//!
//! Frontend (`desktop/src/components/WhatsappSetup.tsx`) drives the
//! login + send flow through these. The actual sidecar lifecycle lives
//! in `crate::whatsapp::SidecarManager`, which is registered as Tauri
//! managed state at app startup.
//!
//! ## Error contract
//!
//! Every command returns `Result<T, String>`. Frontend code reads the
//! string and surfaces it in a toast. The strings are deliberately
//! short and user-readable — e.g. "WhatsApp sidecar not running".

use std::sync::Arc;

use tauri::State;

use crate::whatsapp::{
    AccountInfo, SendMessageRequest, SendMessageResponse, SidecarManager,
};

/// Convert a sidecar error into the frontend-friendly string.
fn err_str(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Begin a QR-paired login. The returned future resolves when the RPC
/// `login_start` ack lands; the actual paired status comes via the
/// `whatsapp:linked` Tauri event subscribers listen to. Frontend usage:
///
/// ```ts
/// await invoke("whatsapp_login_start", { accountId: "personal", label: "Personal" });
/// listen("whatsapp:qr-update", (e) => render(e.payload.qr));
/// listen("whatsapp:linked", () => closeModal());
/// ```
#[tauri::command]
pub async fn whatsapp_login_start(
    state: State<'_, Arc<SidecarManager>>,
    account_id: String,
    label: String,
) -> Result<(), String> {
    state.login_start(&account_id, &label).await.map_err(err_str)
}

#[tauri::command]
pub async fn whatsapp_send(
    state: State<'_, Arc<SidecarManager>>,
    account_id: String,
    to: String,
    body: String,
    reply_to: Option<String>,
) -> Result<SendMessageResponse, String> {
    state
        .send_message(SendMessageRequest {
            account_id,
            to,
            body,
            reply_to,
        })
        .await
        .map_err(err_str)
}

#[tauri::command]
pub async fn whatsapp_logout(
    state: State<'_, Arc<SidecarManager>>,
    account_id: String,
) -> Result<(), String> {
    state.logout(&account_id).await.map_err(err_str)
}

#[tauri::command]
pub async fn whatsapp_list_accounts(
    state: State<'_, Arc<SidecarManager>>,
) -> Result<Vec<AccountInfo>, String> {
    Ok(state.list_accounts().await)
}

#[tauri::command]
pub async fn whatsapp_status(
    state: State<'_, Arc<SidecarManager>>,
    account_id: String,
) -> Result<Option<AccountInfo>, String> {
    Ok(state.account_status(&account_id).await)
}

