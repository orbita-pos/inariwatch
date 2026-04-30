//! Bearer token for the git-hook callback channel.
//!
//! Stored at `<state_dir>/git_hook_token` (single-line text file). The
//! token is INTENTIONALLY distinct from the MCP Bearer:
//!
//! * MCP Bearer authorizes editor agents (Claude Code / Codex / Cursor /
//!   Zed) and grants read+write access to 26 tools. It is the keys to
//!   the kingdom.
//! * `git_hook_token` only authorizes the four .git/hooks/* shell
//!   scripts to POST `/sensors/git/event` to the daemon. A leak via
//!   `git checkout` of a colleague's branch should NOT also leak MCP
//!   access. Two separate tokens, two separate blast radii.
//!
//! Format: `gh_<uuid v4 hex>` — 36 chars total. Long enough to be
//! unguessable on localhost, short enough to embed once in each
//! generated `.sh` script at install time.
//!
//! On Unix the file is created with mode 0600 (owner-only read+write).
//! On Windows the equivalent ACL tightening is left to OS defaults
//! since user-profile dirs are already per-user.

use std::fs;
use std::path::{Path, PathBuf};

pub const TOKEN_FILENAME: &str = "git_hook_token";

/// Resolve `<parent>/git_hook_token`.
pub fn resolve_path(parent_dir: &Path) -> PathBuf {
    parent_dir.join(TOKEN_FILENAME)
}

fn generate_token() -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    format!("gh_{raw}")
}

/// Read the token from `<parent>/git_hook_token`, creating it if absent.
/// Idempotent — a second call returns the same value (token rotation is
/// an explicit user action via the Settings UI).
pub fn ensure_token(parent_dir: &Path) -> std::io::Result<String> {
    fs::create_dir_all(parent_dir)?;
    let path = resolve_path(parent_dir);
    if let Ok(raw) = fs::read_to_string(&path) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
        // empty / whitespace-only file → regenerate.
    }
    let fresh = generate_token();
    write_atomic(&path, &fresh)?;
    Ok(fresh)
}

/// Force-rotate. Returns the new value; persists to disk.
pub fn regenerate(parent_dir: &Path) -> std::io::Result<String> {
    fs::create_dir_all(parent_dir)?;
    let path  = resolve_path(parent_dir);
    let fresh = generate_token();
    write_atomic(&path, &fresh)?;
    Ok(fresh)
}

fn write_atomic(path: &Path, value: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, value)?;
    fs::rename(&tmp, path)?;
    set_secure_perms(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_secure_perms(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_secure_perms(_path: &Path) -> std::io::Result<()> {
    // Windows: the user-profile directory is already per-user; the
    // file inherits the parent ACL. Leaving OS defaults in place.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_has_expected_shape() {
        let t = generate_token();
        assert!(t.starts_with("gh_"));
        // gh_ (3) + 32 hex chars = 35
        assert_eq!(t.len(), 35);
    }

    #[test]
    fn ensure_token_persists() {
        let dir = tempfile::tempdir().unwrap();
        let a = ensure_token(dir.path()).unwrap();
        let b = ensure_token(dir.path()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn regenerate_changes_value() {
        let dir = tempfile::tempdir().unwrap();
        let a = ensure_token(dir.path()).unwrap();
        let b = regenerate(dir.path()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn empty_file_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(resolve_path(dir.path()), "   \n").unwrap();
        let t = ensure_token(dir.path()).unwrap();
        assert!(t.starts_with("gh_"));
        assert_eq!(t.len(), 35);
    }
}
