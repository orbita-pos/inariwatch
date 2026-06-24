//! Bug-saved counter helpers (RENAMED from `src/saves.rs`).
//!
//! Reads dashboard creds from the SQL-backed settings store and fetches
//! `/api/desktop/saves`. Returns an empty summary when the user is not
//! connected — never errors in that case.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::store::Store;

use super::api::read_dashboard_creds;

#[derive(Default, Serialize, Debug, Clone)]
pub struct SavesSummary {
    pub total_saves:                 i64,
    pub total_value_saved_usd_cents: i64,
    pub total_value_saved_usd:       i64,
    pub connected:                   bool,
}

pub async fn fetch_summary(store: &Arc<Store>) -> Result<SavesSummary, String> {
    let creds = read_dashboard_creds(store);
    if !creds.is_connected() {
        return Ok(SavesSummary::default());
    }
    let token = creds.token.unwrap();
    let base_url = creds.base_url;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    let url = format!("{}/api/desktop/saves", base_url.trim_end_matches('/'));

    let res = http
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("parse: {}", e))?;

    Ok(SavesSummary {
        total_saves: body
            .get("total_saves")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        total_value_saved_usd_cents: body
            .get("total_value_saved_usd_cents")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        total_value_saved_usd: body
            .get("total_value_saved_usd")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        connected: true,
    })
}
