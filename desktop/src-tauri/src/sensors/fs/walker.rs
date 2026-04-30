//! Initial repo walk.
//!
//! `ignore::WalkBuilder` honours `.gitignore`, `.git/info/exclude`, and
//! the global git-ignore file. The walk runs synchronously inside a
//! `rayon` worker so the daemon reactor never blocks on it.
//!
//! Why a hard cap at [`MAX_FILES_HARD_CAP`]: the indexer (Session 6)
//! holds an embedding for every file, and we want the perf budget
//! (<120MB RAM idle) to survive a misconfigured walk that recurses
//! into someone's `~/`. 50_000 files is generous for any realistic
//! repository — anything bigger almost certainly indicates a missing
//! `.gitignore` rule and we'd rather warn than OOM.

use std::path::Path;
use std::time::Instant;

use ignore::WalkBuilder;

/// Above this count we stop counting and emit a warning. Walks that
/// hit the cap still complete (the user sees `RepoIndexed` with
/// `file_count == MAX_FILES_HARD_CAP`) so the dock can render
/// progress instead of hanging.
pub const MAX_FILES_HARD_CAP: u64 = 50_000;

/// Result of an initial walk. Surfaced as a `DaemonEvent::RepoIndexed`
/// to the bus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkResult {
    pub file_count:    u64,
    pub duration_ms:   u64,
    /// True iff the walk hit [`MAX_FILES_HARD_CAP`] and stopped early.
    pub truncated:     bool,
}

/// Walk `path` and count regular files the gitignore stack didn't
/// filter. Symlinks are not followed (matches ripgrep / Zed default).
/// Returns even on partial errors — `ignore::WalkBuilder` surfaces them
/// as `Err(_)` entries that we silently skip rather than aborting.
pub fn walk_repo(path: &Path) -> WalkResult {
    let started = Instant::now();
    let walker = WalkBuilder::new(path)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .hidden(false) // we still see dotfiles outside .git
        .follow_links(false)
        .build();

    let mut count: u64 = 0;
    let mut truncated = false;

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            // Permission denied / vanished entries / loop detection —
            // log at debug, keep walking. The user sees the partial
            // count on the bus.
            Err(err) => {
                tracing::debug!(error = %err, "walker entry error (continuing)");
                continue;
            }
        };

        // Skip the repo root + directories so the count reflects
        // *files* the indexer would actually embed.
        let is_file = entry
            .file_type()
            .map(|t| t.is_file())
            .unwrap_or(false);
        if !is_file {
            continue;
        }

        count += 1;
        if count >= MAX_FILES_HARD_CAP {
            tracing::warn!(
                path  = %path.display(),
                limit = MAX_FILES_HARD_CAP,
                "walker hit hard cap — stopping early"
            );
            truncated = true;
            break;
        }
    }

    WalkResult {
        file_count:  count,
        duration_ms: started.elapsed().as_millis() as u64,
        truncated,
    }
}
