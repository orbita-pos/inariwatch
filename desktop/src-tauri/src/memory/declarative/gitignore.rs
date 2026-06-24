//! `.gitignore` augmentation — ensures Inari Live's per-repo files are
//! ignored by default. Idempotent on re-run via marker bracket.

use std::fs;
use std::io::Write;
use std::path::Path;

use super::super::error::Result;

pub const BEGIN_MARKER: &str = "# === Inari Live (auto-managed) ===";
pub const END_MARKER:   &str = "# === /Inari Live ===";

const INARI_PATHS: &[&str] = &[
    ".inari/index.db",
    ".inari/index.db-journal",
    ".inari/index.db-wal",
    ".inari/index.db-shm",
    ".inari/recordings/",
    ".inari/replays/",
    ".inari/memory.local.md",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitignoreOutcome {
    Created,
    Appended,
    AlreadyPresent,
}

pub fn augment_gitignore(repo_path: &Path) -> Result<GitignoreOutcome> {
    let gitignore_path = repo_path.join(".gitignore");

    if !gitignore_path.exists() {
        let content = render_block_as_full_file();
        fs::write(&gitignore_path, content)?;
        return Ok(GitignoreOutcome::Created);
    }

    let existing = fs::read_to_string(&gitignore_path)?;
    if existing.contains(BEGIN_MARKER) {
        return Ok(GitignoreOutcome::AlreadyPresent);
    }

    let mut file = fs::OpenOptions::new().append(true).open(&gitignore_path)?;
    let needs_leading_newline = !existing.ends_with('\n');
    let needs_blank_line      = !existing.ends_with("\n\n");
    if needs_leading_newline {
        file.write_all(b"\n")?;
    }
    if needs_blank_line {
        file.write_all(b"\n")?;
    }
    file.write_all(render_block().as_bytes())?;
    Ok(GitignoreOutcome::Appended)
}

fn render_block() -> String {
    let mut s = String::with_capacity(256);
    s.push_str(BEGIN_MARKER);
    s.push('\n');
    for line in INARI_PATHS {
        s.push_str(line);
        s.push('\n');
    }
    s.push_str(END_MARKER);
    s.push('\n');
    s
}

fn render_block_as_full_file() -> String {
    let mut s = String::new();
    s.push_str("# .gitignore — created by Inari Live\n");
    s.push('\n');
    s.push_str(&render_block());
    s
}
