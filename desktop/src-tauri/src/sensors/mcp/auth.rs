//! Bearer token storage for the local MCP HTTP transport.
//!
//! - File: `<app_local_data_dir>/inari-live/auth.json`.
//! - Token shape: `ilive_<uuid v4 without hyphens>` (40 chars). Long
//!   enough that brute-force is hopeless even on localhost; short
//!   enough to paste once into an editor MCP config.
//! - First launch generates + persists; subsequent launches read.
//! - `regenerate` overwrites unconditionally — used by the Settings UI
//!   when the user wants to revoke a leaked token.
//! - The file lives outside the SQLite store deliberately: editors
//!   read it directly via `install_mcp_for(...)`-written snippets, so
//!   it must be a small standalone artifact.
//!
//! stdio transport does NOT consult this — process trust applies there.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpAuth {
    pub token:      String,
    pub created_at: i64,
    /// `null` for now — token never expires by default. Reserved so the
    /// Settings UI can later emit time-limited tokens.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

impl McpAuth {
    pub fn fresh() -> Self {
        Self {
            token:      generate_token(),
            created_at: now_ms(),
            expires_at: None,
        }
    }
}

fn generate_token() -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    format!("ilive_{raw}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve `<dir>/auth.json` from a given parent dir. The parent is
/// always `<app_local_data_dir>/inari-live` in production; tests pass
/// a tempdir.
pub fn resolve_path(parent_dir: &Path) -> PathBuf {
    parent_dir.join("auth.json")
}

/// Load an existing auth file, or generate + persist a fresh one if
/// absent. Errors only on filesystem failures — a malformed file is
/// treated as "regenerate" (we never panic on bad JSON because the
/// user could have hand-edited it).
pub fn load_or_create(parent_dir: &Path) -> std::io::Result<McpAuth> {
    fs::create_dir_all(parent_dir)?;
    let path = resolve_path(parent_dir);
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(auth) = serde_json::from_str::<McpAuth>(&raw) {
            return Ok(auth);
        }
        tracing::warn!(
            path = %path.display(),
            "mcp auth file unparseable — regenerating"
        );
    }
    let fresh = McpAuth::fresh();
    write_atomic(&path, &fresh)?;
    Ok(fresh)
}

/// Force-regenerate. Returns the new token; persists to disk.
pub fn regenerate(parent_dir: &Path) -> std::io::Result<McpAuth> {
    fs::create_dir_all(parent_dir)?;
    let path  = resolve_path(parent_dir);
    let fresh = McpAuth::fresh();
    write_atomic(&path, &fresh)?;
    Ok(fresh)
}

fn write_atomic(path: &Path, auth: &McpAuth) -> std::io::Result<()> {
    let raw = serde_json::to_string_pretty(auth)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Cloneable in-memory handle. Holds the latest token; regenerate flips
/// the inner value AND rewrites the file. The HTTP transport reads the
/// current token on every request so revocation takes effect
/// immediately.
#[derive(Clone)]
pub struct AuthState {
    inner:      Arc<Mutex<McpAuth>>,
    parent_dir: Arc<PathBuf>,
}

impl AuthState {
    pub fn from_dir(parent_dir: PathBuf) -> std::io::Result<Self> {
        let auth = load_or_create(&parent_dir)?;
        Ok(Self {
            inner:      Arc::new(Mutex::new(auth)),
            parent_dir: Arc::new(parent_dir),
        })
    }

    pub fn token(&self) -> String {
        self.inner.lock().expect("auth mutex poisoned").token.clone()
    }

    pub fn snapshot(&self) -> McpAuth {
        self.inner.lock().expect("auth mutex poisoned").clone()
    }

    pub fn regenerate(&self) -> std::io::Result<McpAuth> {
        let fresh = regenerate(&self.parent_dir)?;
        *self.inner.lock().expect("auth mutex poisoned") = fresh.clone();
        Ok(fresh)
    }

    /// Return true iff `presented` matches the current token in O(n).
    /// Constant-time comparison is overkill on a localhost listener but
    /// it costs us nothing.
    pub fn validate(&self, presented: &str) -> bool {
        let current = self.token();
        if current.len() != presented.len() {
            return false;
        }
        let a = current.as_bytes();
        let b = presented.as_bytes();
        let mut diff: u8 = 0;
        for i in 0..a.len() {
            diff |= a[i] ^ b[i];
        }
        diff == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_has_expected_shape() {
        let t = generate_token();
        assert!(t.starts_with("ilive_"));
        // `ilive_` (6) + 32 hex chars = 38
        assert_eq!(t.len(), 38);
    }

    #[test]
    fn load_or_create_persists() {
        let dir = tempfile::tempdir().unwrap();
        let a   = load_or_create(dir.path()).unwrap();
        let b   = load_or_create(dir.path()).unwrap();
        assert_eq!(a.token, b.token);
    }

    #[test]
    fn regenerate_changes_token() {
        let dir = tempfile::tempdir().unwrap();
        let a   = load_or_create(dir.path()).unwrap();
        let b   = regenerate(dir.path()).unwrap();
        assert_ne!(a.token, b.token);
    }

    #[test]
    fn malformed_file_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("auth.json"), "{not json").unwrap();
        let a = load_or_create(dir.path()).unwrap();
        assert!(a.token.starts_with("ilive_"));
    }

    #[test]
    fn validate_accepts_current_rejects_other() {
        let dir   = tempfile::tempdir().unwrap();
        let state = AuthState::from_dir(dir.path().to_path_buf()).unwrap();
        let token = state.token();
        assert!(state.validate(&token));
        assert!(!state.validate("ilive_wrong"));
        assert!(!state.validate(""));
    }
}
