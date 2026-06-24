//! Session 1 — Tauri-command shells for the device-management surface.
//!
//! Thin pass-throughs to `crate::cloud::devices`. The IPC layer keeps
//! its no-`reqwest` rule by delegating networking to the cloud module.

use std::sync::Arc;

use tauri::AppHandle;

use crate::cloud::devices::{self, DeviceList, SignOutAllResult};
use crate::store::Store;

#[tauri::command]
pub async fn desktop_devices_list(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
) -> Result<DeviceList, String> {
    let store = state.inner().clone();
    devices::list(Some(&app), &store).await
}

#[tauri::command]
pub async fn desktop_devices_rename(
    app:       AppHandle,
    state:     tauri::State<'_, Arc<Store>>,
    device_id: String,
    label:     String,
) -> Result<(), String> {
    let store = state.inner().clone();
    devices::rename(Some(&app), &store, &device_id, &label).await
}

#[tauri::command]
pub async fn desktop_devices_revoke(
    app:       AppHandle,
    state:     tauri::State<'_, Arc<Store>>,
    device_id: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    devices::revoke(Some(&app), &store, &device_id).await
}

#[tauri::command]
pub async fn desktop_devices_sign_out_all(
    app:   AppHandle,
    state: tauri::State<'_, Arc<Store>>,
) -> Result<SignOutAllResult, String> {
    let store = state.inner().clone();
    devices::sign_out_all(Some(&app), &store).await
}
