//! Recent-contacts ring buffer — drives the contact-picker promotion.
//!
//! Mirrors [`recent_paths`](super::recent_paths) shape-for-shape so
//! the picker has the same "newest first, cap N" semantics on a
//! different primary key (`jid` instead of `path`).
//!
//! Touched by the `/whatsapp` slash dispatcher on every successful
//! `comm.send_whatsapp` invocation. Survives app restarts (the
//! sidecar's Baileys creds resume separately — see
//! `whatsapp::SidecarManager::resume_persisted_accounts`).

use rusqlite::params;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::error::Result;
use super::Store;

/// Maximum rows kept on disk. Eviction runs on every `touch`.
const MAX_ENTRIES: usize = 20;

/// One row in the recent-contacts buffer. `jid` is the recipient
/// address the messenger tool needs verbatim (E.164 for WhatsApp);
/// `name` is what the picker shows in the row (may be the same as
/// `jid` when the user typed a raw phone).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct RecentContact {
    pub jid: String,
    pub name: String,
    pub last_used_at: i64,
}

/// Record that `jid` was messaged at `now_ms`. Idempotent on `jid`
/// — calling twice updates the timestamp (and rewrites the display
/// name in case the user later paired the same number under a
/// richer SAS label). After insertion, evicts the least-recently-
/// used rows above [`MAX_ENTRIES`].
///
/// Empty `jid` is rejected so the picker never surfaces a blank row.
pub fn touch_recent_contact(
    store: &Store,
    jid: &str,
    name: &str,
    now_ms: i64,
) -> Result<()> {
    if jid.is_empty() {
        return Err(super::error::StoreError::Internal(
            "recent_contacts.jid may not be empty".to_string(),
        ));
    }
    // Empty name falls back to jid — keeps the row useful when the
    // caller wires raw E.164 with no display.
    let display = if name.is_empty() { jid } else { name };
    let mut conn = store.conn()?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO recent_contacts (jid, name, last_used_at) \
         VALUES (?1, ?2, ?3) \
         ON CONFLICT(jid) DO UPDATE SET \
             name = excluded.name, \
             last_used_at = excluded.last_used_at",
        params![jid, display, now_ms],
    )?;
    tx.execute(
        "DELETE FROM recent_contacts \
         WHERE jid IN ( \
             SELECT jid FROM recent_contacts \
             ORDER BY last_used_at DESC \
             LIMIT -1 OFFSET ?1 \
         )",
        params![MAX_ENTRIES as i64],
    )?;
    tx.commit()?;
    Ok(())
}

/// List the most-recently-messaged contacts, capped at `limit`.
/// Rows are ordered DESC by `last_used_at`. `limit` is clamped to
/// `[1, MAX_ENTRIES]`; 0 or negative returns the full buffer.
pub fn list_recent_contacts(store: &Store, limit: i64) -> Result<Vec<RecentContact>> {
    let bounded = if limit <= 0 {
        MAX_ENTRIES as i64
    } else {
        limit.min(MAX_ENTRIES as i64)
    };
    let conn = store.conn()?;
    let mut stmt = conn.prepare(
        "SELECT jid, name, last_used_at FROM recent_contacts \
         ORDER BY last_used_at DESC \
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![bounded], |row| {
        Ok(RecentContact {
            jid: row.get(0)?,
            name: row.get(1)?,
            last_used_at: row.get(2)?,
        })
    })?;
    let mut out = Vec::with_capacity(bounded as usize);
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Forget a specific contact. Useful when the user later revokes
/// a SAS pairing — the buffer entry is still valid (raw send still
/// works) but the user may want the row off the list.
pub fn forget_recent_contact(store: &Store, jid: &str) -> Result<()> {
    let conn = store.conn()?;
    conn.execute("DELETE FROM recent_contacts WHERE jid = ?1", params![jid])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn fresh_store() -> (Store, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = Store::open_at(&tmp.path().join("store.db")).expect("store");
        (store, tmp)
    }

    #[test]
    fn touch_records_contact_and_list_returns_it() {
        let (store, _tmp) = fresh_store();
        touch_recent_contact(&store, "+5215512345678", "Jose", 1_000).unwrap();
        let rows = list_recent_contacts(&store, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].jid, "+5215512345678");
        assert_eq!(rows[0].name, "Jose");
        assert_eq!(rows[0].last_used_at, 1_000);
    }

    #[test]
    fn touch_is_idempotent_on_jid_and_updates_name() {
        let (store, _tmp) = fresh_store();
        touch_recent_contact(&store, "+1", "+1", 1_000).unwrap();
        // Later, the same jid gets a richer display name (e.g. user
        // paired it through SAS). The next touch should adopt that.
        touch_recent_contact(&store, "+1", "Jose", 2_000).unwrap();
        let rows = list_recent_contacts(&store, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "Jose");
        assert_eq!(rows[0].last_used_at, 2_000);
    }

    #[test]
    fn list_orders_by_recency_desc() {
        let (store, _tmp) = fresh_store();
        touch_recent_contact(&store, "+a", "a", 1_000).unwrap();
        touch_recent_contact(&store, "+b", "b", 3_000).unwrap();
        touch_recent_contact(&store, "+c", "c", 2_000).unwrap();
        let rows = list_recent_contacts(&store, 10).unwrap();
        let jids: Vec<&str> = rows.iter().map(|r| r.jid.as_str()).collect();
        assert_eq!(jids, vec!["+b", "+c", "+a"]);
    }

    #[test]
    fn touch_evicts_oldest_above_cap() {
        let (store, _tmp) = fresh_store();
        for i in 0..(MAX_ENTRIES as i64 + 5) {
            touch_recent_contact(&store, &format!("+{}", i), "n", 1_000 + i).unwrap();
        }
        let rows = list_recent_contacts(&store, MAX_ENTRIES as i64 + 10).unwrap();
        assert_eq!(rows.len(), MAX_ENTRIES);
        assert_eq!(rows.first().unwrap().jid, format!("+{}", MAX_ENTRIES + 4));
        assert_eq!(rows.last().unwrap().jid, format!("+{}", 5));
    }

    #[test]
    fn list_limit_is_clamped() {
        let (store, _tmp) = fresh_store();
        for i in 0..10 {
            touch_recent_contact(&store, &format!("+{}", i), "n", 1_000 + i).unwrap();
        }
        assert_eq!(list_recent_contacts(&store, 3).unwrap().len(), 3);
        assert_eq!(list_recent_contacts(&store, 999).unwrap().len(), 10);
        assert_eq!(list_recent_contacts(&store, 0).unwrap().len(), 10);
        assert_eq!(list_recent_contacts(&store, -5).unwrap().len(), 10);
    }

    #[test]
    fn forget_drops_then_touch_reinserts() {
        let (store, _tmp) = fresh_store();
        touch_recent_contact(&store, "+1", "Jose", 1_000).unwrap();
        forget_recent_contact(&store, "+1").unwrap();
        assert!(list_recent_contacts(&store, 10).unwrap().is_empty());
        touch_recent_contact(&store, "+1", "Jose", 2_000).unwrap();
        let rows = list_recent_contacts(&store, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].last_used_at, 2_000);
    }

    #[test]
    fn touch_rejects_empty_jid() {
        let (store, _tmp) = fresh_store();
        let result = touch_recent_contact(&store, "", "n", 1_000);
        assert!(result.is_err());
    }

    #[test]
    fn touch_falls_back_to_jid_when_name_is_empty() {
        let (store, _tmp) = fresh_store();
        touch_recent_contact(&store, "+1", "", 1_000).unwrap();
        let rows = list_recent_contacts(&store, 10).unwrap();
        assert_eq!(rows[0].name, "+1");
    }
}
