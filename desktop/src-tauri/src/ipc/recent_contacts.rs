//! Inari Live Phase 5.5 completion — IPC surface for the
//! recent-contacts buffer.
//!
//! Two commands exposed to the dock UI:
//!   - `desktop_recent_contacts_list(limit)` → top N rows by recency
//!   - `desktop_recent_contacts_touch(jid, name)` → record a send
//!
//! Implementation lives in `crate::store::recent_contacts`; this
//! module is the thin Tauri shell.

use std::sync::Arc;

use crate::store::{
    recent_contacts::{list_recent_contacts, touch_recent_contact, RecentContact},
    Store,
};

use super::error::IpcError;

/// Return the most-recently-messaged contacts, capped at `limit`
/// (clamped to [1, 20] by the storage layer). 0 or negative `limit`
/// returns the full buffer.
#[tauri::command]
pub async fn desktop_recent_contacts_list(
    limit: i64,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<Vec<RecentContact>, IpcError> {
    Ok(list_recent_contacts(&store, limit)?)
}

/// Touch `jid` + `name` with the current wall-clock time. Idempotent
/// on the `jid` PRIMARY KEY — a second touch updates the timestamp
/// AND the display name (a future SAS pairing can promote the row's
/// label from raw E.164 to "Jose").
#[tauri::command]
pub async fn desktop_recent_contacts_touch(
    jid: String,
    name: String,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<(), IpcError> {
    let now_ms: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    touch_recent_contact(&store, &jid, &name, now_ms)?;
    Ok(())
}
