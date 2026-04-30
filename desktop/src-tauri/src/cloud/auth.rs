//! Device-flow IMPL (RENAMED from `desktop_auth.rs`).
//!
//! Mirrors the CLI device flow — `POST /api/cli/auth/start` →
//! browser-side login → `GET /api/cli/auth/poll?client=desktop` → token.
//! The IPC layer (`crate::ipc::auth`) provides the Tauri-command
//! surface; the actual networking + persistence lives here.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::store::{settings, Store};

use super::api::{http_client, DEFAULT_API_URL};

const POLL_INTERVAL_MS: u64 = 2000;
const POLL_MAX_TRIES:   u32 = 5 * 60 / 2; // 5 min at 2s/tick

/// Start-step response surfaced to the IPC caller.
#[derive(Serialize, Clone, Debug)]
pub struct DeviceFlowStarted {
    pub code:        String,
    pub verify_url:  String,
    pub api_url:     String,
}

#[derive(Deserialize)]
struct StartResponse {
    code: String,
    #[serde(rename = "verifyUrl")]
    verify_url: String,
}

#[derive(Deserialize)]
struct PollResponse {
    status: String,
    #[serde(rename = "apiToken")]
    api_token: Option<String>,
}

/// Read effective base URL: env override → settings store → default.
pub fn default_api_url(store: &Store) -> String {
    if let Ok(v) = std::env::var("INARI_API_URL") {
        if !v.is_empty() {
            return v;
        }
    }
    settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_API_URL.to_string())
}

/// Step 1 — request a fresh device code. Returns the code, the verify
/// URL the user must open in their browser, and the resolved API URL
/// the poll step should use.
pub async fn start(app: &AppHandle, store: &Store) -> Result<DeviceFlowStarted, String> {
    let api_url = default_api_url(store);
    let client = http_client();

    let res = client
        .post(format!("{}/api/cli/auth/start", api_url.trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| format!("start request: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("start returned {}", res.status()));
    }

    let parsed: StartResponse = res.json().await.map_err(|e| format!("start parse: {}", e))?;

    let verify_with_client = if parsed.verify_url.contains('?') {
        format!("{}&client=desktop", parsed.verify_url)
    } else {
        format!("{}?client=desktop", parsed.verify_url)
    };

    if let Err(e) = open_url(app, &verify_with_client) {
        tracing::warn!(error = %e, "could not open browser for device flow");
    }

    Ok(DeviceFlowStarted {
        code:       parsed.code,
        verify_url: verify_with_client,
        api_url,
    })
}

/// Step 2 — long-poll the server until the user approves or the code
/// expires. On success, persists `dashboard_url` + `dashboard_token`
/// in the SQL-backed settings store and returns the token to the IPC
/// caller so the UI can update.
pub async fn poll(store: &Arc<Store>, code: String, api_url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    let url = format!(
        "{}/api/cli/auth/poll?code={}&client=desktop",
        api_url.trim_end_matches('/'),
        urlencode(&code),
    );

    for _ in 0..POLL_MAX_TRIES {
        let res = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "device-flow poll error");
                tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                continue;
            }
        };

        if res.status().as_u16() == 404 {
            return Err("Code expired or invalid. Click Connect again.".to_string());
        }

        let parsed: PollResponse = match res.json().await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "device-flow poll parse");
                tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                continue;
            }
        };

        match parsed.status.as_str() {
            "approved" => {
                let token = parsed
                    .api_token
                    .ok_or_else(|| "approved without token".to_string())?;
                persist_token(store, &api_url, &token)
                    .map_err(|e| format!("persist: {}", e))?;
                return Ok(token);
            }
            "expired" | "invalid" => {
                return Err("Code expired or invalid. Click Connect again.".to_string());
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                continue;
            }
        }
    }

    Err("Timed out waiting for approval (5 min). Click Connect again.".to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct AuthStatus {
    pub connected: bool,
    pub api_url:   String,
    pub watch_dir: Option<String>,
}

/// Step 3 — surface to the UI whether a token is currently configured.
pub fn status(store: &Store) -> AuthStatus {
    let url = settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| default_api_url(store));
    let token_present = settings::get(store, "dashboard_token")
        .ok()
        .flatten()
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    let watch_dir = settings::get(store, "watch_dir").ok().flatten();
    AuthStatus {
        connected: token_present,
        api_url: url,
        watch_dir,
    }
}

fn persist_token(store: &Store, api_url: &str, token: &str) -> std::io::Result<()> {
    let trimmed = api_url.trim_end_matches('/');
    settings::set(store, "dashboard_url", trimmed)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    settings::set(store, "dashboard_token", token)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    Ok(())
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn open_url(_app: &AppHandle, url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no browser opener for this platform",
    ))
}
