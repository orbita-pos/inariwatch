use std::path::Path;
use anyhow::Result;

/// Directories to skip when walking the project tree.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next",
    "__pycache__", ".venv", "venv", ".tox", "vendor",
    ".idea", ".vscode", ".cache", "coverage",
];

/// Extensions to skip (binary/large files).
const SKIP_EXTENSIONS: &[&str] = &[
    "lock", "lockb", "png", "jpg", "jpeg", "gif", "svg", "ico",
    "woff", "woff2", "ttf", "eot", "mp4", "mp3", "zip", "tar",
    "gz", "wasm", "pyc", "class", "o", "so", "dll", "exe",
];

/// Walk the project directory and return relative file paths.
/// Mirrors what GitHub's get_repo_tree returns but from local disk.
/// Caps at 500 files to match the existing diagnose prompt limit.
pub fn walk_project_files(root: &str) -> Result<Vec<String>> {
    let root_path = Path::new(root).canonicalize()?;
    let mut files = Vec::new();
    walk_recursive(&root_path, &root_path, &mut files);
    files.sort();
    files.truncate(500);
    Ok(files)
}

fn walk_recursive(root: &Path, dir: &Path, files: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // permission denied, etc.
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            if files.len() >= 500 {
                return;
            }
            walk_recursive(root, &path, files);
        } else {
            if files.len() >= 500 {
                return;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            if SKIP_EXTENSIONS.contains(&ext) {
                continue;
            }

            if let Ok(rel) = path.strip_prefix(root) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                files.push(rel_str);
            }
        }
    }
}

/// Read a file relative to project root. Returns None if not found or too large (>500KB).
pub fn read_project_file(root: &str, relative_path: &str) -> Option<String> {
    let full = Path::new(root).join(relative_path);
    if !full.exists() {
        return None;
    }
    let meta = std::fs::metadata(&full).ok()?;
    if meta.len() > 500_000 {
        return None;
    }
    std::fs::read_to_string(&full).ok()
}
