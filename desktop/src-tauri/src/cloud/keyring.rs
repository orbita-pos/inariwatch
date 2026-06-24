//! Session 1 — OS keyring storage for Inari Live device-flow tokens.
//!
//! The auth bearer token + the server-issued device id live in the OS
//! keyring (Windows Credential Manager / macOS Keychain / Linux Secret
//! Service). Pre-S1 installs persisted the bearer in the SQL settings
//! store under key `dashboard_token`; we transparently migrate that on
//! first read so existing logins survive the upgrade.
//!
//! On Linux without Secret Service or kwallet the keyring crate's
//! `Entry::*` methods fail; per Session 1 R1 we fall back to the SQL
//! settings store with a warning log so the binary never refuses to
//! authenticate just because the platform lacks a credential vault.
//!
//! Test-friendliness: in `#[cfg(test)]` builds we transparently route
//! all reads/writes through an in-process `Mutex<HashMap>` so cargo
//! test runs don't touch the real keyring (which would prompt the GUI
//! credential helper on macOS / pollute the user's vault on Windows).

use std::sync::Arc;

use crate::store::{settings, Store};

/// `service` slug used for the keyring entries — same on every platform.
/// Picking `inariwatch.desktop` keeps the value collision-free against
/// the legacy `rdr_*` manual token (which only ever lived on disk under
/// `~/.config/inari/desktop.toml`, never in the keyring).
const SERVICE: &str = "inariwatch.desktop";

/// `username` slugs used for the two keyring entries. Splitting the
/// bearer + device id into separate entries lets us delete the device
/// id on legacy installs without touching the bearer (and vice versa).
const KEY_AUTH_TOKEN: &str = "auth-token";
const KEY_DEVICE_ID:  &str = "device-id";

/// Legacy SQL settings keys we migrate FROM on first read.
const LEGACY_TOKEN_KEY: &str = "dashboard_token";
const LEGACY_DEVICE_ID_KEY: &str = "device_id";

/// Result of a credential write — surfaced so the caller can log
/// telemetry about which backend ended up holding the secret. We don't
/// surface this to the UI directly; `cloud::auth::status` only cares
/// about presence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretBackend {
    /// Successfully wrote to the OS keyring.
    Keyring,
    /// Keyring unavailable; wrote to the SQL settings store instead.
    SettingsStoreFallback,
}

/// Wrapper around the keyring + settings store that exposes the
/// cred-management surface needed by the device-flow auth.
#[derive(Clone)]
pub struct SecretStore {
    store: Arc<Store>,
}

impl SecretStore {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }

    /// Persist a fresh auth token + (optional) device id. Tries the
    /// keyring; falls back to the settings store on error.
    ///
    /// Always cleans up the OPPOSITE backend's copy of the secret so
    /// stale credentials don't accumulate after a successful write.
    pub fn set(&self, token: &str, device_id: Option<&str>) -> Result<SecretBackend, String> {
        match try_set_keyring(token, device_id) {
            Ok(()) => {
                // Sweep settings-store leftovers from any prior fallback
                // or from pre-S1 installs.
                let _ = settings::delete(&self.store, LEGACY_TOKEN_KEY);
                let _ = settings::delete(&self.store, LEGACY_DEVICE_ID_KEY);
                Ok(SecretBackend::Keyring)
            }
            Err(e) => {
                tracing::warn!(error = %e, "keyring unavailable; falling back to SQL settings store");
                settings::set(&self.store, LEGACY_TOKEN_KEY, token)
                    .map_err(|e| format!("settings write: {}", e))?;
                if let Some(id) = device_id {
                    settings::set(&self.store, LEGACY_DEVICE_ID_KEY, id)
                        .map_err(|e| format!("settings write: {}", e))?;
                } else {
                    let _ = settings::delete(&self.store, LEGACY_DEVICE_ID_KEY);
                }
                // Make sure we didn't leave a partial keyring write
                // behind from a prior good run.
                let _ = clear_keyring();
                Ok(SecretBackend::SettingsStoreFallback)
            }
        }
    }

    /// Read the current auth token + device id. Tries keyring first,
    /// then settings-store. If we find creds ONLY in the settings
    /// store (i.e. pre-S1 or fallback install) and the keyring is now
    /// available, opportunistically migrate the secrets up so future
    /// reads are O(1).
    pub fn get(&self) -> (Option<String>, Option<String>) {
        let kr_token = read_keyring(KEY_AUTH_TOKEN);
        let kr_dev   = read_keyring(KEY_DEVICE_ID);
        if kr_token.is_some() {
            return (kr_token, kr_dev);
        }

        let st_token = settings::get(&self.store, LEGACY_TOKEN_KEY).ok().flatten();
        let st_dev   = settings::get(&self.store, LEGACY_DEVICE_ID_KEY).ok().flatten();

        // Opportunistic migration: settings has a token, keyring is
        // alive — promote it. Failure is non-fatal; the caller still
        // gets the settings-store value.
        if let Some(t) = st_token.as_deref() {
            if try_set_keyring(t, st_dev.as_deref()).is_ok() {
                let _ = settings::delete(&self.store, LEGACY_TOKEN_KEY);
                let _ = settings::delete(&self.store, LEGACY_DEVICE_ID_KEY);
                tracing::info!("migrated auth token from settings store to OS keyring");
            }
        }

        (st_token, st_dev)
    }

    /// Convenience: just the bearer.
    pub fn token(&self) -> Option<String> {
        self.get().0
    }

    /// Convenience: just the device id (None for pre-S1 installs).
    pub fn device_id(&self) -> Option<String> {
        self.get().1
    }

    /// Wipe both backends. Best-effort — errors are logged but never
    /// returned, so a logout flow still completes even if one half
    /// fails.
    pub fn clear(&self) {
        if let Err(e) = clear_keyring() {
            tracing::warn!(error = %e, "keyring clear failed");
        }
        let _ = settings::delete(&self.store, LEGACY_TOKEN_KEY);
        let _ = settings::delete(&self.store, LEGACY_DEVICE_ID_KEY);
    }
}

// ── Keyring backend (real keyring crate in non-test builds) ─────────────────

#[cfg(not(test))]
fn try_set_keyring(token: &str, device_id: Option<&str>) -> Result<(), String> {
    let token_entry = keyring::Entry::new(SERVICE, KEY_AUTH_TOKEN)
        .map_err(|e| format!("keyring init: {}", e))?;
    token_entry
        .set_password(token)
        .map_err(|e| format!("keyring write token: {}", e))?;

    if let Some(id) = device_id {
        let dev_entry = keyring::Entry::new(SERVICE, KEY_DEVICE_ID)
            .map_err(|e| format!("keyring init: {}", e))?;
        dev_entry
            .set_password(id)
            .map_err(|e| format!("keyring write device id: {}", e))?;
    } else if let Ok(dev_entry) = keyring::Entry::new(SERVICE, KEY_DEVICE_ID) {
        let _ = dev_entry.delete_credential();
    }

    Ok(())
}

#[cfg(not(test))]
fn read_keyring(user: &str) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, user).ok()?;
    match entry.get_password() {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

#[cfg(not(test))]
fn clear_keyring() -> Result<(), String> {
    for user in [KEY_AUTH_TOKEN, KEY_DEVICE_ID] {
        if let Ok(entry) = keyring::Entry::new(SERVICE, user) {
            // Ignore NoEntry / similar — already gone is fine.
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}

// ── Test backend — in-process map, no real keyring access ───────────────────
//
// Real-keyring writes from cargo tests would either prompt the macOS
// credential helper UI (slow + interactive) or pollute the host vault.
// We swap in a `Mutex<HashMap>` for `cfg(test)` builds so tests stay
// hermetic. The `pub` `__test_keyring_*` helpers below let integration
// tests (in `tests/`) seed/inspect the in-memory map.

#[cfg(test)]
mod test_backend {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::SERVICE;

    static MAP: once_cell::sync::Lazy<Mutex<HashMap<(String, String), String>>> =
        once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

    pub fn set(user: &str, value: &str) {
        MAP.lock()
            .unwrap()
            .insert((SERVICE.to_string(), user.to_string()), value.to_string());
    }

    pub fn get(user: &str) -> Option<String> {
        MAP.lock()
            .unwrap()
            .get(&(SERVICE.to_string(), user.to_string()))
            .cloned()
    }

    pub fn delete(user: &str) {
        MAP.lock()
            .unwrap()
            .remove(&(SERVICE.to_string(), user.to_string()));
    }

    pub fn clear() {
        MAP.lock().unwrap().clear();
    }
}

#[cfg(test)]
fn try_set_keyring(token: &str, device_id: Option<&str>) -> Result<(), String> {
    test_backend::set(KEY_AUTH_TOKEN, token);
    if let Some(id) = device_id {
        test_backend::set(KEY_DEVICE_ID, id);
    } else {
        test_backend::delete(KEY_DEVICE_ID);
    }
    Ok(())
}

#[cfg(test)]
fn read_keyring(user: &str) -> Option<String> {
    test_backend::get(user).filter(|v| !v.is_empty())
}

#[cfg(test)]
fn clear_keyring() -> Result<(), String> {
    test_backend::delete(KEY_AUTH_TOKEN);
    test_backend::delete(KEY_DEVICE_ID);
    Ok(())
}

#[cfg(test)]
pub mod test_helpers {
    //! Shims so unit tests in this crate can reset the in-memory
    //! keyring between tests without depending on `cfg(test)`-only
    //! helpers leaking out.
    pub fn reset() {
        super::test_backend::clear()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::sync::{Mutex, MutexGuard};

    /// Cargo runs lib tests in parallel by default. Our in-memory test
    /// keyring is a static map; tests that mutate it must serialize.
    /// Each test takes the lock at the start of `fresh_store()` and
    /// holds it for the duration via the `_guard` returned.
    static TEST_LOCK: once_cell::sync::Lazy<Mutex<()>> =
        once_cell::sync::Lazy::new(|| Mutex::new(()));

    fn fresh_store() -> (Arc<Store>, tempfile::TempDir, MutexGuard<'static, ()>) {
        let guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Reset in-memory keyring between tests so prior state doesn't bleed.
        test_helpers::reset();
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = Store::open_at(&tmp.path().join("store.db")).expect("test store");
        (Arc::new(store), tmp, guard)
    }

    #[test]
    fn set_writes_to_keyring_and_clears_settings_leftovers() {
        let (store, _tmp, _guard) = fresh_store();
        // Seed legacy settings rows to verify cleanup happens on a successful keyring write.
        settings::set(&store, LEGACY_TOKEN_KEY, "old-token").unwrap();
        settings::set(&store, LEGACY_DEVICE_ID_KEY, "old-id").unwrap();

        let secrets = SecretStore::new(store.clone());
        let backend = secrets
            .set("inari_desktop_NEW", Some("11111111-2222-3333-4444-555555555555"))
            .unwrap();

        assert_eq!(backend, SecretBackend::Keyring);
        assert_eq!(test_backend::get(KEY_AUTH_TOKEN).as_deref(), Some("inari_desktop_NEW"));
        assert_eq!(
            test_backend::get(KEY_DEVICE_ID).as_deref(),
            Some("11111111-2222-3333-4444-555555555555")
        );
        // Legacy rows must be wiped to prevent split-brain reads.
        assert_eq!(settings::get(&store, LEGACY_TOKEN_KEY).unwrap(), None);
        assert_eq!(settings::get(&store, LEGACY_DEVICE_ID_KEY).unwrap(), None);
    }

    #[test]
    fn get_falls_back_to_settings_when_keyring_empty_then_promotes() {
        let (store, _tmp, _guard) = fresh_store();
        // Only legacy settings rows exist (pre-S1 install scenario).
        settings::set(&store, LEGACY_TOKEN_KEY, "legacy-token").unwrap();
        settings::set(&store, LEGACY_DEVICE_ID_KEY, "legacy-id").unwrap();

        let secrets = SecretStore::new(store.clone());
        let (token, dev) = secrets.get();

        assert_eq!(token.as_deref(), Some("legacy-token"));
        assert_eq!(dev.as_deref(), Some("legacy-id"));
        // After the read, the migration ran — keyring should now hold them.
        assert_eq!(test_backend::get(KEY_AUTH_TOKEN).as_deref(), Some("legacy-token"));
        assert_eq!(test_backend::get(KEY_DEVICE_ID).as_deref(), Some("legacy-id"));
        // And legacy rows should be gone.
        assert_eq!(settings::get(&store, LEGACY_TOKEN_KEY).unwrap(), None);
    }

    #[test]
    fn clear_wipes_both_backends() {
        let (store, _tmp, _guard) = fresh_store();
        let secrets = SecretStore::new(store.clone());
        secrets.set("t", Some("d")).unwrap();
        // Pretend a settings-store fallback also exists.
        settings::set(&store, LEGACY_TOKEN_KEY, "stale").unwrap();

        secrets.clear();

        assert!(test_backend::get(KEY_AUTH_TOKEN).is_none());
        assert!(test_backend::get(KEY_DEVICE_ID).is_none());
        assert_eq!(settings::get(&store, LEGACY_TOKEN_KEY).unwrap(), None);
        assert_eq!(settings::get(&store, LEGACY_DEVICE_ID_KEY).unwrap(), None);
    }

    #[test]
    fn token_is_treated_as_absent_when_empty_string() {
        let (store, _tmp, _guard) = fresh_store();
        test_backend::set(KEY_AUTH_TOKEN, "");
        let secrets = SecretStore::new(store);
        assert!(secrets.token().is_none());
    }
}
