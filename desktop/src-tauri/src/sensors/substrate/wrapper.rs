//! Idempotent `package.json` wrap / unwrap for opt-in
//! "Replay-as-you-code" repos (Sesión 10).
//!
//! Two flows the dock surfaces (Sesión 17 wires the UI; this module is
//! the pure-Rust core):
//!
//! 1. **Wrap permanently** — rewrite `scripts.dev` so the user's
//!    existing `npm run dev` automatically loads the substrate agent
//!    + capture preloads. We back the original up to
//!    `package.json.inari.bak` so unwrapping is byte-identical.
//! 2. **Use [`crate::cli::run`] ad-hoc** — leave `package.json`
//!    untouched; the user runs `inari run dev` (or whatever script)
//!    instead, which spawns `npm` with the same env injection.
//!
//! ## Why `NODE_OPTIONS=`, not `node --import …`
//!
//! The Sesión-10 spec literally says
//! `node --import @inariwatch/capture/auto --import @inariwatch/substrate-agent <original>`.
//! That works **only** if `<original>` is itself `node X` — for the
//! common case of `next dev` / `tsx server.ts` / `vite` it would tell
//! Node to run the file `next` as a script with `dev` as argv, which
//! breaks. Substituting `NODE_OPTIONS='--import …'` instead has the
//! same observable effect (every Node subprocess loads the imports),
//! works for non-`node`-prefixed scripts, and survives `npm run`'s
//! own arg passing. Decision logged in `INARI_LIVE_DECISIONS.md`
//! 2026-05-01 §"Sesión 10 — wrap shape".
//!
//! ## Idempotency contract
//!
//! - First call: writes `package.json.inari.bak` (the unmodified
//!   original) and rewrites `scripts.dev`.
//! - Second + later calls: detects the marker (NODE_OPTIONS prefix)
//!   already present in `scripts.dev`, leaves the file untouched,
//!   does NOT overwrite the existing backup. This matters because a
//!   second wrap-after-edit would otherwise persist the user's local
//!   tweaks into the backup, defeating unwrap.
//! - Unwrap: copies the backup back, removes `.inari.bak`. Idempotent
//!   too — calling unwrap twice returns `Unchanged` the second time.
//!
//! The marker is intentionally the same `INARI_NODE_OPTIONS_MARKER`
//! prefix string the runtime CLI sets, so callers from either side
//! see one consistent shape.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// Filename suffix the wrapper appends to the backup. Must match the
/// hard-coded string the dock surfaces in the "Restore package.json"
/// affordance copy (Sesión 17).
pub const BACKUP_SUFFIX: &str = ".inari.bak";

/// Marker substring the wrapper writes into `scripts.dev`. Used both
/// to detect "already wrapped" (idempotency) and to power
/// [`is_wrapped`] for the dock toggle. Stable across versions.
pub const INARI_NODE_OPTIONS_MARKER: &str =
    "NODE_OPTIONS=\"--import @inariwatch/capture/auto --import @inariwatch/substrate-agent\"";

/// Outcome of an [`offer_wrap_or_cli`] inspection. The dock uses this
/// to render the right pair of buttons; the CLI uses it to skip
/// "wrap" when there's no `dev` script to wrap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WrapOption {
    /// `package.json` exists with a `scripts.dev`. Both flows are
    /// available — the user picks wrap or CLI.
    HasDevScript { original_dev: String, already_wrapped: bool },
    /// `package.json` exists but has no `scripts.dev`. Only the CLI
    /// flow makes sense (`inari run start` or `inari run <other>`).
    NoDevScript,
    /// No `package.json` at all. Sensor stays inert for this repo.
    NoPackageJson,
}

/// Outcome reported by [`wrap_dev_script`]. `Unchanged` means the
/// caller should NOT show a "wrapped" toast — the wrap was already in
/// place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WrapOutcome {
    Wrapped,
    Unchanged,
}

/// Outcome reported by [`unwrap_dev_script`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnwrapOutcome {
    Unwrapped,
    Unchanged,
    /// The file is currently wrapped but the backup is missing — the
    /// caller can't restore safely. Only fires if a user manually
    /// deleted `package.json.inari.bak`.
    BackupMissing,
}

/// Inspect a repo and decide which flows to offer.
pub fn offer_wrap_or_cli(repo: &Path) -> WrapOption {
    let pkg_path = repo.join("package.json");
    if !pkg_path.exists() {
        return WrapOption::NoPackageJson;
    }
    let pkg = match read_package_json(&pkg_path) {
        Ok(v) => v,
        Err(_) => return WrapOption::NoPackageJson,
    };

    match pkg.get("scripts").and_then(|s| s.get("dev")).and_then(|v| v.as_str()) {
        Some(original) => {
            let already_wrapped = original.contains(INARI_NODE_OPTIONS_MARKER);
            WrapOption::HasDevScript {
                original_dev:    original.to_string(),
                already_wrapped,
            }
        }
        None => WrapOption::NoDevScript,
    }
}

/// Idempotently wrap `scripts.dev`. Backs the original `package.json`
/// up to `package.json.inari.bak` on the first call only — subsequent
/// calls leave both the backup and the wrapped file alone.
pub fn wrap_dev_script(repo: &Path) -> std::io::Result<WrapOutcome> {
    let pkg_path = repo.join("package.json");
    let backup_path = backup_path(&pkg_path);

    let pkg_text = fs::read_to_string(&pkg_path)?;
    let mut pkg: Value = serde_json::from_str(&pkg_text)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Inspect the current dev script. Bail with a typed error rather
    // than silently rewriting if there's nothing to wrap.
    let current_dev = pkg
        .get("scripts")
        .and_then(|s| s.get("dev"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "package.json has no scripts.dev to wrap",
        ))?
        .to_string();

    if current_dev.contains(INARI_NODE_OPTIONS_MARKER) {
        // Already wrapped. Do NOT overwrite the backup — the user may
        // have edited the wrapped script (added flags, env vars), and
        // re-baselining would lose their edits.
        return Ok(WrapOutcome::Unchanged);
    }

    // First wrap. Write the backup BEFORE rewriting so a crash mid-write
    // leaves at least one good copy on disk.
    if !backup_path.exists() {
        fs::write(&backup_path, &pkg_text)?;
    }

    let wrapped = compose_wrapped_dev(&current_dev);
    apply_dev_script(&mut pkg, &wrapped)?;

    let serialized = serde_json::to_string_pretty(&pkg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Trailing newline matches what most editors save — tools that
    // diff `package.json` (like git) report a clean rewrite.
    fs::write(&pkg_path, format!("{serialized}\n"))?;
    Ok(WrapOutcome::Wrapped)
}

/// Idempotently unwrap. Restores the file from `package.json.inari.bak`,
/// then removes the backup. Returns [`UnwrapOutcome::BackupMissing`] if
/// the user already deleted the backup (no safe restore path).
pub fn unwrap_dev_script(repo: &Path) -> std::io::Result<UnwrapOutcome> {
    let pkg_path = repo.join("package.json");
    let backup_path = backup_path(&pkg_path);

    let pkg_text = fs::read_to_string(&pkg_path)?;
    let pkg: Value = serde_json::from_str(&pkg_text)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let current_dev = pkg
        .get("scripts")
        .and_then(|s| s.get("dev"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if !current_dev.contains(INARI_NODE_OPTIONS_MARKER) && !backup_path.exists() {
        return Ok(UnwrapOutcome::Unchanged);
    }

    if !backup_path.exists() {
        return Ok(UnwrapOutcome::BackupMissing);
    }

    fs::copy(&backup_path, &pkg_path)?;
    let _ = fs::remove_file(&backup_path);
    Ok(UnwrapOutcome::Unwrapped)
}

/// Cheap inspector returning whether `scripts.dev` is currently
/// wrapped. Used by the dock toggle (Sesión 17) to render checked /
/// unchecked state without re-parsing the whole file.
pub fn is_wrapped(repo: &Path) -> bool {
    let pkg_path = repo.join("package.json");
    let Ok(text) = fs::read_to_string(&pkg_path) else { return false };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return false };
    value
        .get("scripts")
        .and_then(|s| s.get("dev"))
        .and_then(|v| v.as_str())
        .map(|s| s.contains(INARI_NODE_OPTIONS_MARKER))
        .unwrap_or(false)
}

// ── helpers ──────────────────────────────────────────────────────────

fn backup_path(pkg_path: &Path) -> PathBuf {
    let mut s = pkg_path.as_os_str().to_owned();
    s.push(BACKUP_SUFFIX);
    PathBuf::from(s)
}

fn read_package_json(pkg_path: &Path) -> std::io::Result<Value> {
    let text = fs::read_to_string(pkg_path)?;
    serde_json::from_str(&text)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Compose the wrapped `scripts.dev` value. Public for the integration
/// tests to assert the exact string shape.
pub fn compose_wrapped_dev(original: &str) -> String {
    // Wrap order matters: env-var prefix first, then the unchanged
    // user command. Quoting strategy: double quotes around the whole
    // NODE_OPTIONS value so it survives shells that re-tokenize.
    format!("{INARI_NODE_OPTIONS_MARKER} {}", original.trim())
}

/// Mutate `pkg` so `scripts.dev = new_dev`. Creates the `scripts`
/// object if absent so a hand-edited `package.json` without a
/// `scripts` key still wraps cleanly.
fn apply_dev_script(pkg: &mut Value, new_dev: &str) -> std::io::Result<()> {
    let obj = pkg.as_object_mut().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "package.json root is not an object",
    ))?;
    let scripts = obj
        .entry("scripts")
        .or_insert_with(|| Value::Object(Map::new()));
    let scripts_obj = scripts.as_object_mut().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "package.json scripts is not an object",
    ))?;
    scripts_obj.insert("dev".into(), json!(new_dev));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_pkg(dir: &TempDir, body: &str) {
        std::fs::write(dir.path().join("package.json"), body).unwrap();
    }

    #[test]
    fn offer_no_package_json() {
        let dir = TempDir::new().unwrap();
        assert_eq!(offer_wrap_or_cli(dir.path()), WrapOption::NoPackageJson);
    }

    #[test]
    fn offer_no_dev_script() {
        let dir = TempDir::new().unwrap();
        write_pkg(&dir, r#"{"name":"x","scripts":{"start":"node ."}}"#);
        assert_eq!(offer_wrap_or_cli(dir.path()), WrapOption::NoDevScript);
    }

    #[test]
    fn offer_has_dev_script_pristine() {
        let dir = TempDir::new().unwrap();
        write_pkg(&dir, r#"{"name":"x","scripts":{"dev":"next dev"}}"#);
        match offer_wrap_or_cli(dir.path()) {
            WrapOption::HasDevScript { original_dev, already_wrapped } => {
                assert_eq!(original_dev, "next dev");
                assert!(!already_wrapped);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn wrap_then_unwrap_roundtrip_is_byte_identical() {
        let dir = TempDir::new().unwrap();
        let original = "{\n  \"name\": \"x\",\n  \"scripts\": {\n    \"dev\": \"next dev\"\n  }\n}\n";
        write_pkg(&dir, original);

        assert_eq!(wrap_dev_script(dir.path()).unwrap(), WrapOutcome::Wrapped);
        assert!(is_wrapped(dir.path()));
        // Backup carries the unmodified original.
        let backup = std::fs::read_to_string(
            dir.path().join("package.json.inari.bak"),
        ).unwrap();
        assert_eq!(backup, original);

        // Wrapped file's dev script (parsed from JSON, since serde
        // escapes inner double quotes) contains the marker. Reading
        // the raw bytes won't match — the marker has unescaped `"`
        // while the on-disk JSON serializes them as `\"`.
        let wrapped_text = std::fs::read_to_string(dir.path().join("package.json")).unwrap();
        let pkg: Value = serde_json::from_str(&wrapped_text).unwrap();
        let dev = pkg.get("scripts").and_then(|s| s.get("dev"))
            .and_then(|v| v.as_str()).unwrap();
        assert!(
            dev.contains(INARI_NODE_OPTIONS_MARKER),
            "parsed dev script missing marker: {dev}",
        );

        // Unwrap restores byte-for-byte — the path the user took into
        // wrap is the same path back.
        assert_eq!(unwrap_dev_script(dir.path()).unwrap(), UnwrapOutcome::Unwrapped);
        let restored = std::fs::read_to_string(dir.path().join("package.json")).unwrap();
        assert_eq!(restored, original);
        assert!(!dir.path().join("package.json.inari.bak").exists());
    }

    #[test]
    fn wrap_is_idempotent_does_not_corrupt_backup() {
        let dir = TempDir::new().unwrap();
        write_pkg(&dir, r#"{"name":"x","scripts":{"dev":"next dev"}}"#);

        wrap_dev_script(dir.path()).unwrap();
        // User adds a flag manually to the wrapped script.
        let wrapped_text = std::fs::read_to_string(dir.path().join("package.json")).unwrap();
        let edited = wrapped_text.replace("next dev", "next dev --turbo");
        std::fs::write(dir.path().join("package.json"), &edited).unwrap();

        // Second wrap MUST be a no-op — and MUST NOT overwrite the
        // backup with the user-edited file.
        assert_eq!(wrap_dev_script(dir.path()).unwrap(), WrapOutcome::Unchanged);
        let backup = std::fs::read_to_string(
            dir.path().join("package.json.inari.bak"),
        ).unwrap();
        assert!(backup.contains("\"next dev\""));
        assert!(!backup.contains("--turbo"));
    }

    #[test]
    fn unwrap_with_no_backup_reports_state() {
        let dir = TempDir::new().unwrap();
        let original = r#"{"name":"x","scripts":{"dev":"next dev"}}"#;
        write_pkg(&dir, original);

        // Pristine repo — nothing wrapped, nothing to unwrap.
        assert_eq!(unwrap_dev_script(dir.path()).unwrap(), UnwrapOutcome::Unchanged);

        wrap_dev_script(dir.path()).unwrap();
        // User deletes the backup manually.
        std::fs::remove_file(dir.path().join("package.json.inari.bak")).unwrap();
        assert_eq!(unwrap_dev_script(dir.path()).unwrap(), UnwrapOutcome::BackupMissing);
    }

    #[test]
    fn compose_wrapped_dev_shape_matches_marker() {
        let out = compose_wrapped_dev("next dev");
        assert!(out.starts_with(INARI_NODE_OPTIONS_MARKER));
        assert!(out.ends_with("next dev"));
    }
}
