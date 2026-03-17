use anyhow::{Context, Result};
use chrono::{DateTime, Utc};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub last_commit: DateTime<Utc>,
    /// Commits ahead of the remote tracking branch (0 = fully pushed or no upstream)
    pub ahead: u32,
    pub has_upstream: bool,
    pub is_current: bool,
}

// ── Git runner ────────────────────────────────────────────────────────────────

fn git(args: &[&str], repo_path: &str) -> Result<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .with_context(|| format!("Failed to run: git {}", args.join(" ")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("git {}: {}", args.join(" "), stderr.trim());
    }

    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Confirm `path` is a git repo and return its root. Returns an error otherwise.
pub fn verify_repo(path: &str) -> Result<String> {
    let root = git(&["rev-parse", "--show-toplevel"], path)?;
    Ok(root)
}

/// All local branches with last-commit date, ahead count, and upstream info.
///
/// Uses `git for-each-ref` with tab-separated format so we can parse reliably.
pub fn list_branches(repo_path: &str) -> Result<Vec<BranchInfo>> {
    let raw = git(
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(committerdate:iso)\t%(upstream:track)\t%(HEAD)",
            "refs/heads/",
        ],
        repo_path,
    )?;

    let branches = raw
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\t').collect();
            if parts.len() < 4 {
                return None;
            }

            let name = parts[0].trim().to_string();
            let date_str = parts[1].trim();
            let track = parts[2].trim(); // e.g. "[ahead 3]", "[behind 1]", "[gone]", ""
            let is_current = parts[3].trim() == "*";

            // git outputs dates like "2024-01-15 10:30:00 +0000"
            let last_commit =
                DateTime::parse_from_str(date_str, "%Y-%m-%d %H:%M:%S %z")
                    .ok()
                    .map(|d| d.with_timezone(&Utc))?;

            let has_upstream = !track.is_empty() && track != "[gone]";
            let ahead = parse_ahead(track);

            Some(BranchInfo {
                name,
                last_commit,
                ahead,
                has_upstream,
                is_current,
            })
        })
        .collect();

    Ok(branches)
}

/// `%(upstream:track)` examples:
///   "[ahead 3]"          → 3
///   "[ahead 1, behind 2]"→ 1
///   "[behind 2]"         → 0
///   "[gone]" / ""        → 0
fn parse_ahead(track: &str) -> u32 {
    track
        .split("ahead ")
        .nth(1)
        .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
}

/// Number of local branches in the repo.
pub fn branch_count(repo_path: &str) -> Result<usize> {
    Ok(list_branches(repo_path)?.len())
}

/// Current branch name.
pub fn current_branch(repo_path: &str) -> Result<String> {
    git(&["branch", "--show-current"], repo_path)
}
