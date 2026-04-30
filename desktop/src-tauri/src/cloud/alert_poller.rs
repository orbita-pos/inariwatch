//! Alert polling loop EXTRACTED from `lib.rs::start_alert_poller`.
//!
//! Polls `/api/desktop/alerts` every 60s using the dashboard token from
//! the SQL settings store. New alerts surface as platform notifications,
//! gated by the user's `notifications_enabled` setting.
//!
//! Skipped silently when the user has not yet connected (no
//! `dashboard_token`) — the loop keeps running so adding a token later
//! takes effect on the next tick without a relaunch.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::store::{settings, Store};

use super::api::read_dashboard_creds;

const FIRST_POLL_DELAY: Duration = Duration::from_secs(30);
const POLL_INTERVAL:    Duration = Duration::from_secs(60);
const HTTP_TIMEOUT:     Duration = Duration::from_secs(10);

/// Spawn the polling loop on the Tauri async runtime. Idempotent
/// across the app's lifetime — call once from `setup`.
pub fn start(app: AppHandle, store: Arc<Store>) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("reqwest client builds with default config");

        let mut seen: HashSet<String> = HashSet::new();
        // Stagger first poll so the window has time to load.
        tokio::time::sleep(FIRST_POLL_DELAY).await;

        loop {
            poll_once(&app, &store, &client, &mut seen).await;
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

async fn poll_once(
    app:    &AppHandle,
    store:  &Store,
    client: &reqwest::Client,
    seen:   &mut HashSet<String>,
) {
    let creds = read_dashboard_creds(store);
    if !creds.is_connected() {
        return; // not connected yet — skip silently
    }
    let token = creds.token.unwrap();

    let url = format!(
        "{}/api/desktop/alerts",
        creds.base_url.trim_end_matches('/'),
    );

    let res = client.get(&url).bearer_auth(&token).send().await;
    let Ok(res) = res else { return };
    if !res.status().is_success() { return; }

    let Ok(alerts) = res.json::<Vec<serde_json::Value>>().await else { return };

    let notifications_on = settings::notifications_enabled(store);

    for alert in &alerts {
        let id = match alert["id"].as_str() {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };

        if seen.contains(&id) { continue; }
        seen.insert(id);

        if !notifications_on { continue; }

        let title    = alert["title"].as_str().unwrap_or("New alert").to_string();
        let severity = alert["severity"].as_str().unwrap_or("info").to_uppercase();
        let body     = alert["body"].as_str().unwrap_or("").to_string();

        let _ = app
            .notification()
            .builder()
            .title(format!("[{severity}] {title}"))
            .body(body)
            .show();
    }
}
