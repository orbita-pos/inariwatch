//! Inari Live V1 — projects list HTTP helper.
//!
//! Mirror of `cloud::devices`. Backs the Settings → Projects panel by
//! fetching `/api/desktop/projects`. Read-only — Add Project and
//! Resume Setup actions deeplink to the web dashboard, so this module
//! exposes a single `list` function.
//!
//! 401 handling matches the rest of the cloud surface: invalidate the
//! local keyring + emit `cloud-auth-required` so React surfaces flip
//! to the re-pair flow.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::cloud::api::read_dashboard_creds_arc;
use crate::cloud::auth;
use crate::store::Store;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Wire-format row returned by `GET /api/desktop/projects`. Mirrors
/// the Drizzle select in `web/app/api/desktop/projects/route.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRow {
    pub id:    String,
    pub name:  String,
    pub slug:  String,
    pub state: String,
    #[serde(default)]
    pub framework: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(rename = "organizationId", default)]
    pub organization_id: Option<String>,
    /// Resolved by the route — `"Personal"` when `organizationId` is
    /// null, or the org's display name otherwise. Lets the panel
    /// render workspace context inline without a second round-trip.
    #[serde(rename = "workspaceName", default)]
    pub workspace_name: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastActivityAt", default)]
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectList {
    pub projects: Vec<ProjectRow>,
}

/// `GET /api/desktop/projects` — list projects visible to this user.
pub async fn list(app: Option<&AppHandle>, store: &Arc<Store>) -> Result<ProjectList, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.as_deref().expect("checked above");
    let url = format!("{}/api/desktop/projects", creds.base_url.trim_end_matches('/'));
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
    res.json::<ProjectList>().await.map_err(|e| format!("parse: {}", e))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("client: {}", e))
}
