//! Device-flow IMPL.
//!
//! Mirrors the CLI device flow — `POST /api/cli/auth/start` →
//! browser-side login → `GET /api/cli/auth/poll?client=desktop` → token.
//! The IPC layer (`crate::ipc::auth`) provides the Tauri-command
//! surface; the actual networking + persistence lives here.
//!
//! Session 1 changes:
//!   * Token storage moved from the SQL settings store to the OS
//!     keyring (with a transparent settings-store fallback for Linux
//!     without Secret Service / kwallet — see `cloud::keyring`).
//!   * Each successful poll mints a NEW server-side `device_tokens`
//!     row, so multiple Inari Live installs on one account no longer
//!     overwrite each other. The server's `deviceId` is persisted
//!     alongside the bearer so the desktop can self-revoke on logout.
//!   * `start` and `poll` send a `label` / `os` / `hostname` /
//!     `app_version` query string so the web Settings → Devices panel
//!     can render meaningful rows from the very first connect.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::cloud::keyring::SecretStore;
use crate::store::{settings, Store};

use super::api::{http_client, DEFAULT_API_URL};

const POLL_INTERVAL_MS: u64 = 2000;
const POLL_MAX_TRIES:   u32 = 5 * 60 / 2; // 5 min at 2s/tick

/// Tauri event the frontend listens on for auth invalidation. Already
/// emitted by `cloud::widgets` on HTTP 401 — Session 1 reuses the same
/// channel so the React side has one clearing path to wire up.
pub const EVT_AUTH_REQUIRED: &str = "cloud-auth-required";

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
    #[serde(rename = "deviceId", default)]
    device_id: Option<String>,
}

/// Stable snapshot of the host metadata that gets attached as query
/// params on the verify URL + poll URL. Captured once per device-flow
/// attempt so the values can't drift between start and poll.
#[derive(Debug, Clone)]
struct HostInfo {
    label:       String,
    os:          &'static str,
    hostname:    String,
    app_version: &'static str,
}

impl HostInfo {
    fn current() -> Self {
        let hostname = gethostname::gethostname()
            .to_string_lossy()
            .into_owned();
        let label = if hostname.trim().is_empty() {
            "Inari Live".to_string()
        } else {
            hostname.clone()
        };
        Self {
            label,
            os: std::env::consts::OS,
            hostname,
            app_version: env!("CARGO_PKG_VERSION"),
        }
    }

    /// Render as a `&label=...&os=...&hostname=...&app_version=...`
    /// fragment ready to glue onto a URL with either `?` or `&`
    /// separator. Empty values are dropped so we never emit
    /// `&hostname=` (server falls back to defaults on missing values).
    fn as_query_fragment(&self) -> String {
        let mut out = String::new();
        for (k, v) in [
            ("label",       self.label.as_str()),
            ("os",          self.os),
            ("hostname",    self.hostname.as_str()),
            ("app_version", self.app_version),
        ] {
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            out.push('&');
            out.push_str(k);
            out.push('=');
            out.push_str(&urlencoding::encode(v));
        }
        out
    }
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
    let host    = HostInfo::current();
    let client  = http_client();

    let res = client
        .post(format!("{}/api/cli/auth/start", api_url.trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| format!("start request: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("start returned {}", res.status()));
    }

    let parsed: StartResponse = res.json().await.map_err(|e| format!("start parse: {}", e))?;

    // Browser URL: explicit `?client=desktop` flag plus the device
    // metadata so the web verify page can render a meaningful prompt.
    let host_q = host.as_query_fragment();
    let verify_with_client = if parsed.verify_url.contains('?') {
        format!("{}&client=desktop{}", parsed.verify_url, host_q)
    } else {
        format!("{}?client=desktop{}", parsed.verify_url, host_q)
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
/// expires. On success, persists the bearer + the server-issued
/// `deviceId` to the OS keyring (with settings-store fallback) and
/// returns the bearer to the IPC caller so the UI can update.
pub async fn poll(store: &Arc<Store>, code: String, api_url: String) -> Result<String, String> {
    let host = HostInfo::current();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    let url = format!(
        "{}/api/cli/auth/poll?code={}&client=desktop{}",
        api_url.trim_end_matches('/'),
        urlencoding::encode(&code),
        host.as_query_fragment(),
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
                persist_token(store, &api_url, &token, parsed.device_id.as_deref())?;
                // Best-effort: hit /api/desktop/me with the new bearer to learn
                // the user's workspace_id and persist it. Pairing IPCs (S8) read
                // `current_workspace_id` from settings — without this, every
                // pair attempt fails with "no workspace selected — finish
                // desktop login first". Network failure here is non-fatal:
                // user can re-pair to retry.
                let _ = fetch_and_persist_workspace(store, &api_url, &token).await;
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
    /// Session 1 — server-issued device_tokens.device_id when paired
    /// post-S1. Null for pre-S1 installs (legacy api_keys path).
    pub device_id: Option<String>,
}

/// Step 3 — surface to the UI whether a token is currently configured.
pub fn status(store: &Arc<Store>) -> AuthStatus {
    let url = settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| default_api_url(store));
    let secrets = SecretStore::new(store.clone());
    let (token, device_id) = secrets.get();
    let watch_dir = settings::get(store, "watch_dir").ok().flatten();
    AuthStatus {
        connected: token.as_deref().map(|t| !t.is_empty()).unwrap_or(false),
        api_url: url,
        watch_dir,
        device_id,
    }
}

/// Logout — best-effort server-side revoke followed by an
/// unconditional local clear.
///
/// "Best-effort": if the server is unreachable or returns an error we
/// STILL clear the keyring locally so the user isn't stranded with a
/// stale token they can't get rid of. Matches the Sentry / Vercel CLI
/// pattern (per S1 R4).
pub async fn logout(app: &AppHandle, store: &Arc<Store>) -> Result<(), String> {
    let secrets = SecretStore::new(store.clone());
    let (token, device_id) = secrets.get();
    let api_url = settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_API_URL.to_string());

    if let (Some(token), Some(dev)) = (token.as_deref(), device_id.as_deref()) {
        // Fire-and-forget revoke — short timeout so logout stays snappy
        // even when the user is offline.
        let url = format!(
            "{}/api/desktop/devices/{}",
            api_url.trim_end_matches('/'),
            urlencoding::encode(dev),
        );
        match reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| format!("client: {}", e))?
            .delete(&url)
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => {
                tracing::info!(device_id = %dev, "logout revoked device server-side");
            }
            Ok(res) => {
                tracing::warn!(status = %res.status(), "logout server revoke returned non-2xx — clearing locally anyway");
            }
            Err(e) => {
                tracing::warn!(error = %e, "logout server revoke failed — clearing locally anyway");
            }
        }
    }

    secrets.clear();
    let _ = settings::delete(store, "dashboard_url");
    let _ = app.emit(EVT_AUTH_REQUIRED, ());
    Ok(())
}

/// Helper: emit `cloud-auth-required` and clear the local bearer so
/// the frontend bounces back to the Connect screen. Used by callers
/// that detect a 401 from a cloud API call.
///
/// Unlike [`logout`], this leaves `dashboard_url` in settings so the
/// next Connect attempt remembers the user's workspace endpoint — only
/// the (now-known-invalid) token is wiped. Logout is the only path
/// that intentionally tears down everything.
pub fn invalidate(app: &AppHandle, store: &Arc<Store>) {
    SecretStore::new(store.clone()).clear();
    let _ = app.emit(EVT_AUTH_REQUIRED, ());
}

/// `&Store` flavor of [`invalidate`] for callers that don't already
/// own an `Arc<Store>`. Cheap — `Store` is `Clone` and its inner pool
/// is Arc-shared.
pub fn invalidate_with_store(app: &AppHandle, store: &Store) {
    invalidate(app, &Arc::new(store.clone()))
}

fn persist_token(
    store: &Arc<Store>,
    api_url: &str,
    token: &str,
    device_id: Option<&str>,
) -> Result<(), String> {
    let trimmed = api_url.trim_end_matches('/');
    settings::set(store, "dashboard_url", trimmed)
        .map_err(|e| format!("settings write: {}", e))?;
    SecretStore::new(store.clone())
        .set(token, device_id)
        .map(|_| ())
}

/// Boot-time backfill: if the user is already authenticated but
/// `current_workspace_id` is missing (paired before the workspace-id
/// fix landed in 4792b195), fetch /api/desktop/me once and cache it.
/// Without this, `Channels` pairing still surfaces "no workspace
/// selected — finish desktop login first" until the user re-pairs.
///
/// All branches return Ok — this is purely a convenience and never
/// fatal. Logging happens server-side in any caller that cares.
pub async fn backfill_workspace_if_missing(store: &Arc<Store>) {
    let creds = crate::cloud::api::read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return;
    }
    let token = match creds.token.clone() {
        Some(t) if !t.is_empty() => t,
        _ => return,
    };
    let already = settings::get(store, "current_workspace_id")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    if already.is_some() {
        return;
    }
    let api_url = creds.base_url.trim_end_matches('/').to_string();
    let _ = fetch_and_persist_workspace(store, &api_url, &token).await;
}

/// Best-effort follow-up after a successful device-flow pair: fetch the
/// authenticated user's primary workspace and persist its UUID into
/// `current_workspace_id` so S8's pairing IPCs (and any future
/// workspace-aware code) can resolve it without a server round-trip.
///
/// All errors are swallowed by the caller — pairing is the source of
/// truth for "logged in"; this is just a convenience cache.
async fn fetch_and_persist_workspace(
    store: &Arc<Store>,
    api_url: &str,
    token: &str,
) -> Result<(), String> {
    #[derive(Deserialize)]
    struct MeResp {
        #[serde(rename = "workspaceId")]
        workspace_id: Option<String>,
    }

    let url = format!("{}/api/desktop/me", api_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {}", e))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("desktop/me: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("desktop/me: HTTP {}", resp.status()));
    }
    let me: MeResp = resp
        .json()
        .await
        .map_err(|e| format!("desktop/me parse: {}", e))?;
    if let Some(wid) = me.workspace_id {
        settings::set(store, "current_workspace_id", &wid)
            .map_err(|e| format!("settings write: {}", e))?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::HostInfo;

    #[test]
    fn host_info_query_skips_empty_values() {
        let info = HostInfo {
            label: "".to_string(),
            os: "macos",
            hostname: "".to_string(),
            app_version: "9.9.9",
        };
        let q = info.as_query_fragment();
        assert!(!q.contains("label="));
        assert!(!q.contains("hostname="));
        assert!(q.contains("os=macos"));
        assert!(q.contains("app_version=9.9.9"));
    }

    #[test]
    fn host_info_query_url_encodes_label() {
        let info = HostInfo {
            label: "Jesus's MacBook Pro".to_string(),
            os: "macos",
            hostname: "Jesus-MacBook.local".to_string(),
            app_version: "1.0.0",
        };
        let q = info.as_query_fragment();
        // Spaces → %20 — apostrophe is unreserved per RFC 3986 so it
        // stays literal. urlencoding crate matches that contract.
        assert!(q.contains("label=Jesus%27s%20MacBook%20Pro"), "fragment: {}", q);
        assert!(q.contains("hostname=Jesus-MacBook.local"));
    }

    #[test]
    fn host_info_current_resolves_label_to_hostname_or_default() {
        let info = HostInfo::current();
        // Either the actual hostname or the "Inari Live" fallback —
        // never empty, since the server treats empty label as missing.
        assert!(!info.label.is_empty());
    }
}
