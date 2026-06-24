//! Install / uninstall the per-shell hook templates under
//! `~/.inari/shell/inari.<shell>` and add a single `source` line to the
//! shell's rc file.
//!
//! Idempotent on both sides:
//!   * `install` run twice leaves exactly one `source` line (recognised
//!     by the [`INARI_MARKER`] suffix on the line), and overwrites the
//!     hook payload from the bundled template.
//!   * `uninstall` run with no installation (or partial state) returns
//!     a populated [`UninstallOutcome`] with `absent` / `removed`
//!     tracked separately — never errors on missing files.
//!
//! Path resolution:
//!   * Templates are bundled via `include_str!` at compile time (same
//!     precedent as Sesión 8's git hooks).
//!   * The user's home directory comes from `$HOME` on Unix and
//!     `%USERPROFILE%` on Windows. We deliberately do NOT pull `dirs`
//!     in (the crate was removed in Sesión 5 — see
//!     `INARI_LIVE_HANDOFF.md` Session 5 outputs).
//!
//! Privacy:
//!   * [`scrub_secrets`] is the canonical Rust port of the regex the
//!     shell scripts implement. Tests assert behaviour on this
//!     function; the shipped scripts each translate the same regex
//!     into their host language (sed for zsh/bash, `string match -r`
//!     for fish). README documents both for audit.

use std::fs;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Marker on the `source` line so `uninstall` can locate it without
/// parsing user-edited rc files. Anything ending with this suffix is
/// considered ours.
pub const INARI_MARKER: &str = "# inari-live shell hook (Sensor 2)";

/// Subdirectory under `~/.inari/` where the per-shell hook scripts
/// land. Re-exported so installer + tests agree.
pub const SHELL_HOOKS_DIR: &str = "shell";

const ZSH_TEMPLATE:  &str = include_str!("../../../resources/shell/inari.zsh");
const BASH_TEMPLATE: &str = include_str!("../../../resources/shell/inari.bash");
const FISH_TEMPLATE: &str = include_str!("../../../resources/shell/inari.fish");

/// Which interactive shell to install for. Each variant has a
/// well-known rc-file location relative to `$HOME`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    Zsh,
    Bash,
    Fish,
}

impl ShellKind {
    fn template(self) -> &'static str {
        match self {
            ShellKind::Zsh  => ZSH_TEMPLATE,
            ShellKind::Bash => BASH_TEMPLATE,
            ShellKind::Fish => FISH_TEMPLATE,
        }
    }

    fn template_filename(self) -> &'static str {
        match self {
            ShellKind::Zsh  => "inari.zsh",
            ShellKind::Bash => "inari.bash",
            ShellKind::Fish => "inari.fish",
        }
    }

    /// Path of the shell's rc file relative to `$HOME`. fish keeps its
    /// config under `~/.config/fish/config.fish`; zsh + bash use the
    /// classic dotfile in the home dir.
    fn rc_relpath(self) -> &'static str {
        match self {
            ShellKind::Zsh  => ".zshrc",
            ShellKind::Bash => ".bashrc",
            ShellKind::Fish => ".config/fish/config.fish",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct InstallOutcome {
    pub shell:        ShellKind,
    pub rc_path:      String,
    pub hook_path:    String,
    pub source_line:  String,
    pub already_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct UninstallOutcome {
    pub shell:        ShellKind,
    pub rc_path:      String,
    pub hook_path:    String,
    pub line_removed: bool,
    pub hook_removed: bool,
}

/// Resolve the user's home directory cross-platform without depending
/// on the `dirs` crate. Returns the path or an `io::Error` describing
/// the missing env var.
pub fn resolve_home() -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "$HOME not set",
            ))
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .ok_or_else(|| std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "%USERPROFILE% not set",
            ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unsupported platform",
        ))
    }
}

/// Build the literal `source ~/.inari/shell/inari.<shell>` line for a
/// given home directory. Kept pure so install + uninstall agree on the
/// exact substring to write/find.
fn source_line_for(shell: ShellKind, home: &Path) -> String {
    let hook_path = hook_path_for(shell, home);
    match shell {
        ShellKind::Fish => {
            format!("source {} {}", display_unix(&hook_path), INARI_MARKER)
        }
        // zsh + bash share the same `source <path>` form.
        _ => format!("source {} {}", display_unix(&hook_path), INARI_MARKER),
    }
}

fn hook_path_for(shell: ShellKind, home: &Path) -> PathBuf {
    home.join(".inari").join(SHELL_HOOKS_DIR).join(shell.template_filename())
}

fn rc_path_for(shell: ShellKind, home: &Path) -> PathBuf {
    home.join(shell.rc_relpath())
}

/// Forward-slash form of a path. Both bash and zsh accept it on Windows
/// (git-bash) and Unix; fish parses it the same way. Avoids backslash
/// escaping inside the rc file.
fn display_unix(p: &Path) -> String {
    p.display().to_string().replace('\\', "/")
}

/// Install hooks for `shell` under `home`. Idempotent — if the source
/// line is already present (recognised by [`INARI_MARKER`]) it is left
/// alone but the hook payload is refreshed from the bundled template.
pub fn install(shell: ShellKind, home: &Path) -> std::io::Result<InstallOutcome> {
    let hook_path = hook_path_for(shell, home);
    if let Some(parent) = hook_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&hook_path, shell.template())?;
    set_executable(&hook_path)?;

    let rc_path     = rc_path_for(shell, home);
    let source_line = source_line_for(shell, home);

    if let Some(parent) = rc_path.parent() {
        // fish lives under `~/.config/fish/`; create the dir on first
        // install. zsh/bash parents always exist (`$HOME`).
        fs::create_dir_all(parent)?;
    }

    let existing = if rc_path.exists() {
        fs::read_to_string(&rc_path)?
    } else {
        String::new()
    };

    let already_present = rc_contains_marker(&existing);

    if !already_present {
        // Append the line. Preserve trailing-newline semantics so we
        // don't glue our line to a previous unterminated line.
        let mut out = existing.clone();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&source_line);
        out.push('\n');
        fs::write(&rc_path, out)?;
    }

    Ok(InstallOutcome {
        shell,
        rc_path:         display_unix(&rc_path),
        hook_path:       display_unix(&hook_path),
        source_line,
        already_present,
    })
}

/// Uninstall hooks for `shell` under `home`. Idempotent — missing rc
/// file or missing line is reported in the outcome rather than as an
/// error. Removes `~/.inari/shell/inari.<shell>` if present.
pub fn uninstall(shell: ShellKind, home: &Path) -> std::io::Result<UninstallOutcome> {
    let rc_path   = rc_path_for(shell, home);
    let hook_path = hook_path_for(shell, home);

    let mut line_removed = false;
    if rc_path.exists() {
        let existing = fs::read_to_string(&rc_path)?;
        let filtered: String = existing
            .lines()
            .filter(|l| {
                if line_is_ours(l) {
                    line_removed = true;
                    false
                } else {
                    true
                }
            })
            .collect::<Vec<&str>>()
            .join("\n");
        if line_removed {
            // Preserve the original trailing-newline status when we
            // drop our line.
            let mut out = filtered;
            if existing.ends_with('\n') && !out.ends_with('\n') {
                out.push('\n');
            }
            fs::write(&rc_path, out)?;
        }
    }

    let mut hook_removed = false;
    if hook_path.exists() {
        fs::remove_file(&hook_path)?;
        hook_removed = true;
    }

    Ok(UninstallOutcome {
        shell,
        rc_path:      display_unix(&rc_path),
        hook_path:    display_unix(&hook_path),
        line_removed,
        hook_removed,
    })
}

fn rc_contains_marker(content: &str) -> bool {
    content.lines().any(line_is_ours)
}

fn line_is_ours(line: &str) -> bool {
    line.contains(INARI_MARKER) && line.trim_start().starts_with("source ")
}

#[cfg(unix)]
fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o644);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

// ─── Privacy: secret-shaped env-var scrubbing ─────────────────────────────────
//
// The scrubber redacts the VALUE of any `IDENT=value` pair where the
// identifier contains one of the well-known secret tokens
// (KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD) as an uppercase substring.
//
// Examples (input → output):
//   `OPENAI_API_KEY=sk-abc123 some-cmd`     → `OPENAI_API_KEY=*** some-cmd`
//   `GITHUB_TOKEN=ghp_xx`                   → `GITHUB_TOKEN=***`
//   `npm install`                           → `npm install` (unchanged)
//   `ls -la`                                → `ls -la`     (unchanged)
//
// Limitations (documented in resources/shell/README.md):
//   * Lower-case substrings (`my_token=...`) are NOT scrubbed. Convention
//     is upper-case env var names; lower-case slips through. v0.1 acceptable.
//   * Quoted multi-word values stop at the first whitespace. A pathological
//     `KEY="my secret"` becomes `KEY=*** secret"` — the trailing token
//     reaches the daemon. Document; revisit if it bites.

static SECRET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*)=\S+")
        .expect("static secret regex compiles")
});

/// Scrub env-var-shaped secrets in a shell command. See module-level
/// privacy notes for the regex semantics + known limitations.
pub fn scrub_secrets(cmd: &str) -> String {
    SECRET_RE.replace_all(cmd, "$1=***").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn install_zsh_writes_one_source_line_idempotently() {
        let home = make_home();

        let first = install(ShellKind::Zsh, home.path()).unwrap();
        assert!(!first.already_present);

        let second = install(ShellKind::Zsh, home.path()).unwrap();
        assert!(second.already_present);

        let zshrc = std::fs::read_to_string(home.path().join(".zshrc")).unwrap();
        let count = zshrc.lines().filter(|l| line_is_ours(l)).count();
        assert_eq!(count, 1, ".zshrc had {count} matching lines, expected 1");

        let hook = home.path().join(".inari/shell/inari.zsh");
        assert!(hook.exists(), "hook payload not written");
    }

    #[test]
    fn uninstall_removes_only_our_line() {
        let home = make_home();
        std::fs::write(home.path().join(".zshrc"), "alias gs='git status'\n").unwrap();
        install(ShellKind::Zsh, home.path()).unwrap();

        let outcome = uninstall(ShellKind::Zsh, home.path()).unwrap();
        assert!(outcome.line_removed);
        assert!(outcome.hook_removed);

        let zshrc = std::fs::read_to_string(home.path().join(".zshrc")).unwrap();
        assert!(zshrc.contains("alias gs="));
        assert!(!zshrc.lines().any(line_is_ours));

        // Idempotent: second uninstall reports nothing to do.
        let again = uninstall(ShellKind::Zsh, home.path()).unwrap();
        assert!(!again.line_removed);
        assert!(!again.hook_removed);
    }

    #[test]
    fn scrub_redacts_known_secret_shapes() {
        assert_eq!(
            scrub_secrets("OPENAI_API_KEY=sk-abc123 some-cmd"),
            "OPENAI_API_KEY=*** some-cmd",
        );
        assert_eq!(scrub_secrets("GITHUB_TOKEN=ghp_xx"), "GITHUB_TOKEN=***");
        assert_eq!(scrub_secrets("AWS_SECRET_ACCESS_KEY=zzz"), "AWS_SECRET_ACCESS_KEY=***");
        assert_eq!(scrub_secrets("KEY=raw"), "KEY=***");
        assert_eq!(scrub_secrets("ls -la"), "ls -la");
        assert_eq!(scrub_secrets("npm install"), "npm install");
    }

}
