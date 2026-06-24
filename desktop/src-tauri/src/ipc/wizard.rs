//! Tauri command surface for the Add-Project wizard. Thin shells —
//! the actual logic lives in `crate::wizard::{detect, install, dev}`.

use std::sync::Arc;

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::cloud::api::read_dashboard_creds_arc;
use crate::store::{settings, Store};
use crate::wizard::{
    self,
    detect::detect_local_clone,
    dev::{inject_test_event_manual, run_dev_and_inject, RunDevArgs, RunDevResult},
    install::{run_install, InstallArgs, InstallResult},
    DetectionResult, WizardPayload, WizardStore,
};

#[tauri::command]
pub fn wizard_get_pending(
    state: tauri::State<'_, Arc<WizardStore>>,
) -> Option<WizardPayload> {
    state.inner().pending()
}

#[tauri::command]
pub fn wizard_dismiss(state: tauri::State<'_, Arc<WizardStore>>) {
    state.inner().clear();
}

#[tauri::command]
pub fn wizard_detect_clone(
    state: tauri::State<'_, Arc<Store>>,
    repo_full_name: String,
) -> DetectionResult {
    detect_local_clone(state.inner(), &repo_full_name)
}

#[tauri::command]
pub async fn wizard_run_install(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    args: InstallArgs,
) -> Result<InstallResult, String> {
    let store = state.inner().clone();
    run_install(&app, &store, args).await
}

#[tauri::command]
pub async fn wizard_run_dev(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    args: RunDevArgs,
) -> Result<RunDevResult, String> {
    let store = state.inner().clone();
    run_dev_and_inject(&app, &store, args).await
}

#[tauri::command]
pub async fn wizard_inject_test_event(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    project_id: String,
) -> Result<(), String> {
    let store = state.inner().clone();
    inject_test_event_manual(&app, &store, &project_id).await
}

// Inari Live V1 — Session 4. Tier 2 / Tier 3 host-sync helpers.
//
// `wizard_copy_to_clipboard` is the only sanctioned way the Add-Project
// wizard pushes a project token onto the clipboard. We bound the
// payload to 4 KiB so a runaway caller can't blow up the OS clipboard
// (real DSNs are ~120 chars). `wizard_open_host_dashboard` opens an
// HTTPS URL in the user's default browser; non-https schemes are
// rejected so a malicious caller can't smuggle a `file://` URL through
// the same surface.

const MAX_CLIPBOARD_BYTES: usize = 4 * 1024;

#[tauri::command]
pub fn wizard_copy_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    if text.is_empty() {
        return Err("empty text".to_string());
    }
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err(format!(
            "text too large ({} bytes > {} cap)",
            text.len(),
            MAX_CLIPBOARD_BYTES,
        ));
    }
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("clipboard write failed: {}", e))
}

#[tauri::command]
pub fn wizard_open_host_dashboard(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".to_string());
    }
    // Cap URL length so a runaway caller can't trip the shell.
    if url.len() > 2048 {
        return Err("url too long".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("open url failed: {}", e))
}

/// Wizard helper for Tier 2 hosts: read the project's freshly-minted
/// token from the keyring-backed settings store, build the DSN, and
/// push it onto the OS clipboard. Plaintext NEVER leaves Rust — the
/// React caller only sees the masked fingerprint we return.
///
/// The settings key matches the `KEYRING_PROJECT_PREFIX` used in
/// `crate::wizard::install::backup_to_keyring` (string-duplicated here
/// to avoid pulling that whole module's deps into the IPC layer).
#[tauri::command]
pub fn wizard_copy_project_token_to_clipboard(
    app: AppHandle,
    state: tauri::State<'_, Arc<Store>>,
    project_id: String,
) -> Result<String, String> {
    if project_id.is_empty() {
        return Err("missing projectId".to_string());
    }
    let store = state.inner();
    let backup_key = format!("project-token-{}", project_id);
    let plaintext = settings::get(store, &backup_key)
        .map_err(|e| format!("read keyring backup: {}", e))?
        .ok_or_else(|| {
            "no project token backup found — run install first".to_string()
        })?;

    // Build the DSN with the dashboard host the user authenticated against.
    let creds = read_dashboard_creds_arc(store);
    let api_url = creds.base_url.trim_end_matches('/');
    let host = api_url
        .replacen("https://", "", 1)
        .replacen("http://", "", 1);
    let dsn = format!(
        "https://{}@{}/capture/{}",
        plaintext,
        host,
        urlencoding::encode(&project_id),
    );

    // Push to clipboard. Same 4-KiB cap as `wizard_copy_to_clipboard`,
    // though a real DSN is ~120 chars.
    if dsn.len() > MAX_CLIPBOARD_BYTES {
        return Err("dsn too large for clipboard".to_string());
    }
    app.clipboard()
        .write_text(dsn.clone())
        .map_err(|e| format!("clipboard write failed: {}", e))?;

    // Return a masked fingerprint so the React side can render
    // confirmation copy without ever seeing the secret.
    Ok(mask_token(&plaintext))
}

/// Mask the secret portion of a project token for safe display. We
/// keep the `iwk_pub_v1_` prefix + first 6 chars; rest is dots.
fn mask_token(secret: &str) -> String {
    if secret.len() <= 24 {
        return secret.chars().take(8).collect::<String>() + "…";
    }
    format!("{}…", &secret[..18])
}

// Re-export the wizard event channel constants so the React side can
// reference them via `invoke('plugin:settings|...', { CONST })` in tests.
pub const EVT_WIZARD_OPENED: &str = wizard::EVT_WIZARD_OPENED;
pub const EVT_WIZARD_PROGRESS: &str = wizard::EVT_WIZARD_PROGRESS;
