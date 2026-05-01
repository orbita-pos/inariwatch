//! Shared cloud-API helpers.
//!
//! De-duplicates the four pre-Session-4 copies of `read_dashboard_creds`
//! that lived in `desktop_auth.rs`, `saves.rs`, `autofix.rs`, and
//! `lib.rs::read_desktop_config`. Each copy parsed `desktop.toml` from
//! `dirs::config_dir()`. Post-Session-4 we read from the SQL-backed
//! settings store instead.

use std::sync::Arc;
use std::time::Duration;

use crate::store::{settings, Store};

/// Default production base URL when no `dashboard_url` is configured.
pub const DEFAULT_API_URL: &str = "https://app.inariwatch.com";

/// Whatever the user has stored — base URL plus optional bearer token.
#[derive(Debug, Clone)]
pub struct DashboardCreds {
    pub base_url: String,
    pub token:    Option<String>,
}

impl DashboardCreds {
    /// True iff a non-empty token is present. Used by callers that
    /// silently skip when not connected (alert poller, saves summary).
    pub fn is_connected(&self) -> bool {
        self.token.as_deref().map(|t| !t.is_empty()).unwrap_or(false)
    }
}

/// Read dashboard creds from the SQL settings store. Returns
/// `(DEFAULT_API_URL, None)` if nothing has been saved yet — callers
/// branch on `is_connected()` rather than handling an `Option`.
pub fn read_dashboard_creds(store: &Store) -> DashboardCreds {
    let base_url = settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_API_URL.to_string());
    let token = settings::get(store, "dashboard_token").ok().flatten();
    DashboardCreds { base_url, token }
}

/// Construct an HTTP client with a sensible default timeout. SSE
/// callers (e.g. `ai::remediate::proxy`) should build their own
/// long-timeout client — this helper is for short request/response
/// flows (auth, saves, alert poll).
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client builds with default config")
}

/// Wrapper that owns a long-lived `reqwest::Client` plus a handle to
/// the store. Useful for spawned background tasks (alert poller) that
/// don't want to recreate the client on every iteration.
#[derive(Clone)]
pub struct CloudClient {
    pub http:  reqwest::Client,
    pub store: Arc<Store>,
}

impl CloudClient {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            http: http_client(),
            store,
        }
    }

    pub fn creds(&self) -> DashboardCreds {
        read_dashboard_creds(&self.store)
    }
}
