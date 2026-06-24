//! Inari Live V1 — Session 3 relay bootstrap.
//!
//! Bridges the gap between v0.3 S2 (relay client coded) and S3
//! (relay-driven auto-open). Responsibilities:
//!
//!   1. Fetch the per-user relay JWT from web's
//!      `GET /api/desktop/relay/jwt` once we have a device bearer.
//!   2. Spawn `relay_client::spawn(...)` with the JWT + Wizard hooks.
//!   3. Best-effort retry on auth status changes (logout / re-pair).
//!
//! "Best effort" — if the web returns 501 (relay disabled / no
//! `INARI_LIVE_RELAY_JWT_KEY`) we log + skip. The wizard still works
//! end-to-end via the polling fallback in `wizard::poll_pending`
//! (Session 3 follow-up; for V1 the user can navigate manually to the
//! "Add Project" wizard via the dashboard's "Open in Inari Live" CTA).
//!
//! Spawning is idempotent — a second call shuts down the previous
//! supervisor (if any) before launching a fresh one. This lets login /
//! logout transitions cleanly re-issue the WS handshake without piling
//! up zombie supervisors.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::cloud::api::{http_client, read_dashboard_creds_arc};
use crate::relay_client::{self, Backoff, RelayClient, RelayConfig};
use crate::store::Store;
use crate::wizard::WizardStore;

/// Singleton handle to the live relay client. Wrapped in a Mutex so
/// re-bootstraps (logout/login cycle) can take ownership of the
/// previous client to await its shutdown.
pub struct RelayHandle {
    inner: Mutex<Option<RelayClient>>,
}

impl RelayHandle {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(None) })
    }

    /// Replace the current client (if any) with a freshly-spawned
    /// supervisor. Safe to call repeatedly — old supervisors are torn
    /// down cleanly before the new one boots.
    pub async fn replace(&self, client: RelayClient) {
        let mut g = self.inner.lock().await;
        if let Some(old) = g.take() {
            old.shutdown().await;
        }
        *g = Some(client);
    }

    /// Tear down any active client. Used on logout.
    pub async fn shutdown(&self) {
        let mut g = self.inner.lock().await;
        if let Some(old) = g.take() {
            old.shutdown().await;
        }
    }
}

/// Public entry — try to bootstrap the relay client. No-op when:
///   * not authenticated yet,
///   * `/api/desktop/relay/jwt` returns 501 (relay disabled), or
///   * any transient error (logged, skipped — caller retries later).
pub async fn bootstrap_if_authenticated(
    app: &AppHandle,
    store: &Arc<Store>,
    relay_handle: &Arc<RelayHandle>,
    wizard_store: &Arc<WizardStore>,
) {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        // Not paired yet — bootstrap will run again after device-flow
        // login completes (callsite: ipc::auth post-poll).
        return;
    }
    let token = match creds.token.clone() {
        Some(t) if !t.is_empty() => t,
        _ => return,
    };
    let api_url = creds.base_url.trim_end_matches('/').to_string();

    let res = match fetch_relay_jwt(&token, &api_url).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "relay JWT fetch failed; skipping bootstrap");
            return;
        }
    };

    let cfg = RelayConfig {
        base_url:           res.relay_url,
        jwt:                res.jwt,
        app_version:        env!("CARGO_PKG_VERSION").to_string(),
        initial_backoff:    Some(Backoff::new()),
        local_ai:           None,
        app_local_data_dir: None,
        whatsapp:           None,
        wizard_store:       Some(wizard_store.clone()),
        app_handle:         Some(app.clone()),
    };

    let client = relay_client::spawn(cfg);
    relay_handle.replace(client).await;
    tracing::info!("relay client spawned (Session 3 wizard auto-open active)");
}

/// HTTP shape of `/api/desktop/relay/jwt`. Mirrors the route handler.
#[derive(Debug, Deserialize)]
struct RelayJwtBody {
    jwt: String,
    #[serde(rename = "relayUrl")]
    relay_url: String,
}

async fn fetch_relay_jwt(bearer: &str, api_url: &str) -> Result<RelayJwtBody, String> {
    let url = format!("{}/api/desktop/relay/jwt", api_url);
    let res = http_client()
        .get(&url)
        .bearer_auth(bearer)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("relay jwt fetch: {}", e))?;
    let status = res.status();
    if status.as_u16() == 501 {
        return Err("relay_disabled".to_string());
    }
    if !status.is_success() {
        return Err(format!("relay jwt fetch returned {}", status));
    }
    res.json::<RelayJwtBody>()
        .await
        .map_err(|e| format!("relay jwt parse: {}", e))
}
