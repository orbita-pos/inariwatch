//! Tauri-command shells for "Connect Project". Impl in
//! [`crate::cli::run`].

use std::sync::Arc;

use serde_json::Value;
use tauri::AppHandle;

use crate::cli::run::{
    self, ConnectArgs, ConnectResult, ConnectState,
};

#[tauri::command]
pub async fn desktop_connect_project(
    app:   AppHandle,
    state: tauri::State<'_, Arc<ConnectState>>,
    args:  ConnectArgs,
) -> Result<ConnectResult, String> {
    let st = state.inner().clone();
    run::connect_project(&app, &st, args).await
}

#[tauri::command]
pub async fn desktop_disconnect_project(
    app:   AppHandle,
    state: tauri::State<'_, Arc<ConnectState>>,
) -> Result<(), String> {
    let st = state.inner().clone();
    run::disconnect_project(&app, &st).await
}

#[tauri::command]
pub fn desktop_connect_status(
    state: tauri::State<'_, Arc<ConnectState>>,
) -> Value {
    let pid = state.pid();
    serde_json::json!({
        "connected": pid != 0,
        "pid":       pid,
    })
}
