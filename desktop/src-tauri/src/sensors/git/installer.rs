//! Install / uninstall git hooks under a repo's `.git/hooks/` directory.
//!
//! Idempotent. Each install:
//!   1. Locates the repo's `.git` directory (handles bare repos and
//!      submodules where `.git` is a file pointing elsewhere).
//!   2. For each of the four hooks (pre-commit / post-commit / pre-push
//!      / post-merge) reads the bundled template, performs three
//!      placeholder substitutions, and writes it.
//!   3. If a non-Inari hook already lives at the path, it is renamed
//!      to `<hook>.inari-backup` first. A second install does not
//!      double-backup.
//!   4. On Unix, marks the hook executable (chmod 0755). On Windows,
//!      Git for Windows respects the file extension/shebang regardless.
//!
//! Uninstall removes the four scripts and, if a `.inari-backup` exists,
//! restores it. Repos with no installed hooks return `NotInstalled`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const HOOK_NAMES: [&str; 4] = ["pre-commit", "post-commit", "pre-push", "post-merge"];

const PRE_COMMIT_TEMPLATE:  &str = include_str!("../../../resources/hooks/pre-commit.sh");
const POST_COMMIT_TEMPLATE: &str = include_str!("../../../resources/hooks/post-commit.sh");
const PRE_PUSH_TEMPLATE:    &str = include_str!("../../../resources/hooks/pre-push.sh");
const POST_MERGE_TEMPLATE:  &str = include_str!("../../../resources/hooks/post-merge.sh");

/// Marker line embedded in every Inari hook so the installer can tell
/// "this file is ours" apart from "this is the user's pre-existing
/// hook" without parsing the script.
pub const INARI_MARKER: &str = "# Inari Live — ";

/// Backup suffix used when the user's pre-existing hook gets moved
/// aside. Documented so unininstall + future sessions can rely on it.
pub const BACKUP_SUFFIX: &str = "inari-backup";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct InstallOutcome {
    pub installed:    Vec<String>,
    pub backed_up:    Vec<String>,
    pub already_ours: Vec<String>,
    pub hook_dir:     String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct UninstallOutcome {
    pub removed:      Vec<String>,
    pub restored:     Vec<String>,
    pub absent:       Vec<String>,
    pub hook_dir:     String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct HookStatus {
    pub repo_id:    String,
    pub installed:  bool,
    pub hook_files: Vec<String>,
    pub hook_dir:   String,
}

/// Resolve the `.git/hooks` directory for a working tree. Handles the
/// `.git` file form (used by submodules and worktrees) by following the
/// `gitdir: <path>` redirect.
pub fn resolve_hooks_dir(repo_root: &Path) -> std::io::Result<PathBuf> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git.join("hooks"));
    }
    if dot_git.is_file() {
        let content = fs::read_to_string(&dot_git)?;
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("gitdir:") {
                let target = rest.trim();
                let absolute = if Path::new(target).is_absolute() {
                    PathBuf::from(target)
                } else {
                    repo_root.join(target)
                };
                return Ok(absolute.join("hooks"));
            }
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "`.git` file present but no `gitdir:` line",
        ));
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!(".git not found under {}", repo_root.display()),
    ))
}

fn template_for(hook_name: &str) -> &'static str {
    match hook_name {
        "pre-commit"  => PRE_COMMIT_TEMPLATE,
        "post-commit" => POST_COMMIT_TEMPLATE,
        "pre-push"    => PRE_PUSH_TEMPLATE,
        "post-merge"  => POST_MERGE_TEMPLATE,
        _             => unreachable!("HOOK_NAMES exhaustive"),
    }
}

fn render_template(template: &str, port_file: &Path, token: &str, repo_id: &str) -> String {
    template
        .replace("__INARI_PORT_FILE__", &port_file.display().to_string())
        .replace("__INARI_HOOK_TOKEN__", token)
        .replace("__INARI_REPO_ID__", repo_id)
}

/// Install all four hooks. `port_file` is the absolute path to
/// `port.txt` (the file Sesión 7 writes when it picks an MCP port);
/// `token` is the git-hook-token (NOT the MCP Bearer); `repo_id` is the
/// SQL `repos.id` for the repo so the daemon can resolve back to it
/// without re-walking on every event.
pub fn install_for(
    repo_root: &Path,
    port_file: &Path,
    token:     &str,
    repo_id:   &str,
) -> std::io::Result<InstallOutcome> {
    let hooks_dir = resolve_hooks_dir(repo_root)?;
    fs::create_dir_all(&hooks_dir)?;

    let mut installed    = Vec::with_capacity(4);
    let mut backed_up    = Vec::new();
    let mut already_ours = Vec::new();

    for name in HOOK_NAMES {
        let target = hooks_dir.join(name);
        let payload = render_template(template_for(name), port_file, token, repo_id);

        if target.exists() {
            let existing = fs::read_to_string(&target).unwrap_or_default();
            if existing.contains(INARI_MARKER) {
                // Our previous install. Overwrite without backup.
                already_ours.push(name.to_string());
            } else {
                let backup = target.with_extension(BACKUP_SUFFIX);
                if !backup.exists() {
                    fs::rename(&target, &backup)?;
                    backed_up.push(name.to_string());
                } else {
                    // A backup already exists from a prior install.
                    // Leave the existing backup alone (don't lose user
                    // history) and just overwrite the live hook.
                    let _ = fs::remove_file(&target);
                }
            }
        }

        fs::write(&target, payload)?;
        set_executable(&target)?;
        installed.push(name.to_string());
    }

    Ok(InstallOutcome {
        installed,
        backed_up,
        already_ours,
        hook_dir: hooks_dir.display().to_string(),
    })
}

pub fn uninstall_for(repo_root: &Path) -> std::io::Result<UninstallOutcome> {
    let hooks_dir = resolve_hooks_dir(repo_root)?;
    let mut removed  = Vec::new();
    let mut restored = Vec::new();
    let mut absent   = Vec::new();

    for name in HOOK_NAMES {
        let target = hooks_dir.join(name);
        if !target.exists() {
            absent.push(name.to_string());
            continue;
        }
        let existing = fs::read_to_string(&target).unwrap_or_default();
        if !existing.contains(INARI_MARKER) {
            // Not ours — leave it alone. Defensive against accidental
            // uninstall after the user replaced our hook with their own.
            absent.push(name.to_string());
            continue;
        }
        fs::remove_file(&target)?;
        removed.push(name.to_string());

        let backup = target.with_extension(BACKUP_SUFFIX);
        if backup.exists() {
            fs::rename(&backup, &target)?;
            set_executable(&target)?;
            restored.push(name.to_string());
        }
    }

    Ok(UninstallOutcome {
        removed,
        restored,
        absent,
        hook_dir: hooks_dir.display().to_string(),
    })
}

pub fn status_for(repo_id: &str, repo_root: &Path) -> std::io::Result<HookStatus> {
    let hooks_dir = resolve_hooks_dir(repo_root)?;
    let mut hook_files = Vec::new();
    let mut installed = true;
    for name in HOOK_NAMES {
        let target = hooks_dir.join(name);
        let exists = target.exists();
        let ours = exists
            && fs::read_to_string(&target)
                .map(|c| c.contains(INARI_MARKER))
                .unwrap_or(false);
        if ours {
            hook_files.push(name.to_string());
        } else {
            installed = false;
        }
    }
    Ok(HookStatus {
        repo_id:    repo_id.to_string(),
        installed,
        hook_files,
        hook_dir:   hooks_dir.display().to_string(),
    })
}

#[cfg(unix)]
fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> std::io::Result<()> {
    // Git for Windows uses the file's shebang + extension to decide
    // execution; OS-level executable bit isn't needed.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        // Minimal `.git/hooks` skeleton — no need for `git init` since
        // we only write/read files.
        std::fs::create_dir_all(dir.path().join(".git").join("hooks")).unwrap();
        dir
    }

    #[test]
    fn install_creates_four_hooks() {
        let repo = make_repo();
        let port_file = repo.path().join("port.txt");
        let outcome = install_for(repo.path(), &port_file, "gh_test", "repo-1").unwrap();
        assert_eq!(outcome.installed.len(), 4);
        for name in HOOK_NAMES {
            let p = repo.path().join(".git").join("hooks").join(name);
            assert!(p.exists(), "{name} not created");
            let body = std::fs::read_to_string(&p).unwrap();
            assert!(body.contains(INARI_MARKER), "{name} missing marker");
            assert!(body.contains("gh_test"), "{name} missing token");
            assert!(body.contains("repo-1"), "{name} missing repo id");
            assert!(body.contains("curl"), "{name} missing curl call");
        }
    }
}
