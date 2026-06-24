//! Single-slot store for the most recent alert the user saw.
//!
//! Populated by [`super::show_alert_toast`] when an alert arrives;
//! read by the tray's "Quick Actions" submenu so "Fix Last Alert" /
//! "Investigate Last" / "Open Latest Stacktrace" all act on the same
//! payload the toast surfaced.
//!
//! In-memory only. We intentionally do NOT persist this to SQLite:
//! "last alert" is a session concept ("the alert I just dismissed"),
//! and the audit log already keeps the durable record of every
//! ambient action the user took. After a process restart there is no
//! "last alert" until the next one arrives — that is the correct UX.

use std::sync::RwLock;

use super::AlertSnapshot;

/// Thread-safe single-slot store.
///
/// The store is `pub` so `lib.rs::run` can register it as Tauri
/// managed state via `app.manage(Arc::new(LastAlertStore::new()))`,
/// and so tests can construct one directly. There is no constructor
/// argument because the slot starts empty.
#[derive(Debug, Default)]
pub struct LastAlertStore {
    slot: RwLock<Option<AlertSnapshot>>,
}

impl LastAlertStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the slot with `alert`. Subsequent [`Self::get`] calls
    /// return a clone of this snapshot until the next `set`.
    pub fn set(&self, alert: AlertSnapshot) {
        if let Ok(mut slot) = self.slot.write() {
            *slot = Some(alert);
        }
    }

    /// Snapshot of the current alert, if any. Cheap to clone (the
    /// snapshot is short strings).
    pub fn get(&self) -> Option<AlertSnapshot> {
        self.slot.read().ok().and_then(|s| s.clone())
    }

    /// Drop the current alert. Used by tests + the eventual "clear
    /// session" UX.
    pub fn clear(&self) {
        if let Ok(mut slot) = self.slot.write() {
            *slot = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_store_returns_none() {
        let store = LastAlertStore::new();
        assert!(store.get().is_none());
    }

    #[test]
    fn set_then_get_returns_snapshot() {
        let store = LastAlertStore::new();
        let alert = AlertSnapshot::new("a-1", "Title", "Body", "");
        store.set(alert.clone());
        assert_eq!(store.get(), Some(alert));
    }

    #[test]
    fn second_set_overwrites_first() {
        let store = LastAlertStore::new();
        store.set(AlertSnapshot::new("a-1", "T1", "B1", ""));
        store.set(AlertSnapshot::new("a-2", "T2", "B2", ""));
        let got = store.get().expect("some");
        assert_eq!(got.id, "a-2");
        assert_eq!(got.title, "T2");
    }

    #[test]
    fn clear_drops_the_slot() {
        let store = LastAlertStore::new();
        store.set(AlertSnapshot::new("a-1", "T", "B", ""));
        store.clear();
        assert!(store.get().is_none());
    }
}
