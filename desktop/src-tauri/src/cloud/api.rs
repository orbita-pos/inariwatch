//! Shared cloud-API helpers.
//!
//! De-duplicates the four pre-Session-4 copies of `read_dashboard_creds`
//! that lived in `desktop_auth.rs`, `saves.rs`, `autofix.rs`, and
//! `lib.rs::read_desktop_config`. Each copy parsed `desktop.toml` from
//! `dirs::config_dir()`. Post-Session-4 we read from the SQL-backed
//! settings store instead.
//!
//! Session 1 — bearer tokens have moved to the OS keyring (with a
//! settings-store fallback for Linux without Secret Service / kwallet).
//! `read_dashboard_creds` keeps the same call surface so existing
//! callers (alert poller, saves summary, relay client) don't need to
//! know which backend currently holds the secret.

use std::sync::Arc;
use std::time::Duration;

use crate::cloud::keyring::SecretStore;
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

/// Read dashboard creds. URL still lives in the settings store
/// (non-secret); the bearer comes from the OS keyring (with the
/// settings-store fallback handled inside `SecretStore`). Returns
/// `(DEFAULT_API_URL, None)` when nothing is configured.
pub fn read_dashboard_creds(store: &Store) -> DashboardCreds {
    let base_url = settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_API_URL.to_string());

    // SecretStore wants an Arc<Store>; `read_dashboard_creds` callers
    // typically already have one (`relay_client`, `alert_poller`, …)
    // but the older signature took a `&Store`. `Store` is `Clone` and
    // its inner `r2d2` pool handle is already Arc-shared, so cloning
    // here is just a pointer copy.
    let secrets = SecretStore::new(Arc::new(store.clone()));
    let token = secrets.token();

    DashboardCreds { base_url, token }
}

/// Same as [`read_dashboard_creds`] but takes an `Arc<Store>` directly
/// so callers that already own one (Tauri `State<Arc<Store>>`) avoid
/// the synthetic clone.
pub fn read_dashboard_creds_arc(store: &Arc<Store>) -> DashboardCreds {
    let base_url = settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_API_URL.to_string());
    let secrets = SecretStore::new(store.clone());
    DashboardCreds {
        base_url,
        token: secrets.token(),
    }
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
        read_dashboard_creds_arc(&self.store)
    }
}

