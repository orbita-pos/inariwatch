//! Tauri-command shells for the device-flow auth.
//!
//! Implementation lives in [`crate::cloud::auth`]; this module is only
//! the `#[tauri::command]` surface that the webview invokes.

use std::sync::Arc;

use tauri::AppHandle;

use crate::cloud::auth::{self, AuthStatus, DeviceFlowStarted};
use crate::store::Store;

#[tauri::command]
pub async fn desktop_auth_start(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
) -> Result<DeviceFlowStarted, String> {
    auth::start(&app, &state).await
}

#[tauri::command]
pub async fn desktop_auth_poll(
    state:   tauri::State<'_, Arc<Store>>,
    code:    String,
    api_url: String,
) -> Result<String, String> {
    let store = state.inner().clone();
    auth::poll(&store, code, api_url).await
}

#[tauri::command]
pub fn desktop_auth_status(
    state: tauri::State<'_, Arc<Store>>,
) -> AuthStatus {
    let store = state.inner().clone();
    auth::status(&store)
}
