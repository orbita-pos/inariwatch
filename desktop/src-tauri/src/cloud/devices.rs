//! Session 1 — device-management HTTP helpers.
//!
//! Thin wrappers over `/api/desktop/devices*` endpoints. The IPC layer
//! (`crate::ipc::devices`) exposes Tauri-command shells; this module
//! holds the actual networking + DTO mapping so the IPC surface stays
//! free of `reqwest` calls.
//!
//! 401 handling — every call that hits a 401 invokes
//! `cloud::auth::invalidate`, which clears the local keyring + dashes
//! the `cloud-auth-required` event back to the React side. That's the
//! "device-side detects 401 next call → re-pair flow" behavior the S1
//! brief calls out in acceptance criterion 2.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::cloud::auth;
use crate::cloud::api::read_dashboard_creds_arc;
use crate::store::Store;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Wire-format row returned by `GET /api/desktop/devices`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRow {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub label: String,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(rename = "appVersion", default)]
    pub app_version: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: String,
    #[serde(rename = "isCurrent", default)]
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceList {
    pub devices: Vec<DeviceRow>,
    #[serde(rename = "currentDeviceId", default)]
    pub current_device_id: Option<String>,
}

/// `GET /api/desktop/devices` — list active devices.
pub async fn list(app: Option<&AppHandle>, store: &Arc<Store>) -> Result<DeviceList, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!("{}/api/desktop/devices", creds.base_url.trim_end_matches('/'));
    let res = http_client()?
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<DeviceList>().await.map_err(|e| format!("parse: {}", e))
}

/// `PATCH /api/desktop/devices/:id` — rename a device.
pub async fn rename(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
    device_id: &str,
    label: &str,
) -> Result<(), String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!(
        "{}/api/desktop/devices/{}",
        creds.base_url.trim_end_matches('/'),
        urlencoding::encode(device_id),
    );
    let body = serde_json::json!({ "label": label });
    let res = http_client()?
        .patch(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    Ok(())
}

/// `DELETE /api/desktop/devices/:id` — revoke a single device.
///
/// Distinct from `cloud::auth::logout` — this one revokes ANY device
/// (including the calling device when the user picks "this device" in
/// the list); logout self-revokes + clears local creds.
pub async fn revoke(app: Option<&AppHandle>, store: &Arc<Store>, device_id: &str) -> Result<(), String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!(
        "{}/api/desktop/devices/{}",
        creds.base_url.trim_end_matches('/'),
        urlencoding::encode(device_id),
    );
    let res = http_client()?
        .delete(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    Ok(())
}

/// `POST /api/desktop/devices/sign-out-all` — bulk revoke. Returns the
/// number of rows the server actually revoked so the UI can render
/// "Signed out N devices".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignOutAllResult {
    pub ok: bool,
    #[serde(rename = "revokedCount", default)]
    pub revoked_count: i64,
}

pub async fn sign_out_all(
    app: Option<&AppHandle>,
    store: &Arc<Store>,
) -> Result<SignOutAllResult, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!(
        "{}/api/desktop/devices/sign-out-all",
        creds.base_url.trim_end_matches('/'),
    );
    let res = http_client()?
        .post(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if res.status().as_u16() == 401 {
        if let Some(app) = app {
            auth::invalidate(app, store);
        }
        return Err("unauthorized".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.json::<SignOutAllResult>().await.map_err(|e| format!("parse: {}", e))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("client: {}", e))
}
