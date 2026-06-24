//! Rust-side stacktrace location extractor.
//!
//! Mirror of the TS parser at `desktop/src/lib/stacktrace.ts`, kept
//! intentionally minimal: ambient surfaces only need the FIRST
//! `file:line[:col]` location to dispatch `desktop.open_in_editor`.
//! The richer parser (full `StacktraceLocation[]` array used by the
//! tooltip + context menu) lives on the frontend so the chat surface
//! can render a context-menu wrapper around each match without
//! crossing the IPC boundary on every render.
//!
//! Patterns recognised (first match wins):
//!
//! 1. Node V8 — `at <fn> (<path>:<line>:<col>)`
//! 2. Linter / rustc / tsc — `<path>:<line>:<col>` or `<path>:<line>`
//! 3. Python — `File "<path>", line <line>`

use once_cell::sync::Lazy;
use regex::Regex;

/// Best-effort first match. Returns `None` when the text contains no
/// recognisable location.
pub fn first_location(text: &str) -> Option<Location> {
    if let Some(caps) = NODE_V8.captures(text) {
        let path = caps.get(2)?.as_str().to_string();
        let line = caps.get(3)?.as_str().parse().ok()?;
        return Some(Location { path, line });
    }
    if let Some(caps) = PYTHON.captures(text) {
        let path = caps.get(1)?.as_str().to_string();
        let line = caps.get(2)?.as_str().parse().ok()?;
        return Some(Location { path, line });
    }
    if let Some(caps) = GENERIC.captures(text) {
        let path = caps.get(1)?.as_str().to_string();
        let line = caps.get(2)?.as_str().parse().ok()?;
        return Some(Location { path, line });
    }
    None
}

/// Minimal location pair. We don't surface column on the Rust side —
/// `desktop.open_in_editor` ignores `col` today (the system "open"
/// path doesn't accept one), so leaving it on the TS side keeps the
/// wire shape lean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub path: String,
    pub line: u32,
}

/// `at <fn> (<path>:<line>:<col>)` — V8 / Node style. The function
/// name is captured but ignored by callers; we keep it in the pattern
/// so the path capture isn't accidentally a partial match on text
/// that doesn't start with `at`.
static NODE_V8: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"at\s+([^\s(]+)\s+\(([^:()]+):(\d+):(\d+)\)").unwrap()
});

/// `File "<path>", line <line>` — Python traceback.
static PYTHON: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"File\s+"([^"]+)",\s+line\s+(\d+)"#).unwrap());

/// `<path>:<line>[:<col>]` — linter / rustc / tsc / generic.
///
/// Path constraints (avoid false positives like `1.0:0`):
///
/// - Must contain at least one `/` or `\` between the leading
///   identifier and the file name (`src/main.rs`, `./foo/bar.ts`).
/// - Must end in a known source-file extension.
/// - Windows drive paths are matched via the dedicated alternative
///   so `C:\Users\jesus\foo.rs` keeps the colon-after-drive intact.
///
/// First capture = path, second = line.
static GENERIC: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"([A-Za-z]:[\\/][^\s:()]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sql|md|json|yml|yaml|toml)|[\w\-./\\]+[\\/][\w\-.]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sql|md|json|yml|yaml|toml)):(\d+)",
    )
    .unwrap()
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_node_v8_frame() {
        let text = "at handler (/srv/app/server.js:42:13)";
        let loc = first_location(text).expect("match");
        assert_eq!(loc.path, "/srv/app/server.js");
        assert_eq!(loc.line, 42);
    }

    #[test]
    fn parses_python_frame() {
        let text = "  File \"/srv/app/main.py\", line 88, in <module>";
        let loc = first_location(text).expect("match");
        assert_eq!(loc.path, "/srv/app/main.py");
        assert_eq!(loc.line, 88);
    }

    #[test]
    fn parses_linter_style() {
        let text = "src/lib/foo.ts:17:5: error TS2304: Cannot find name 'x'.";
        let loc = first_location(text).expect("match");
        assert_eq!(loc.path, "src/lib/foo.ts");
        assert_eq!(loc.line, 17);
    }

    #[test]
    fn parses_rustc_style() {
        let text = "error: bad in src/main.rs:9:1";
        let loc = first_location(text).expect("match");
        assert_eq!(loc.path, "src/main.rs");
        assert_eq!(loc.line, 9);
    }

    #[test]
    fn parses_windows_path() {
        let text = "C:\\Users\\jesus\\src\\foo.rs:42:8";
        let loc = first_location(text).expect("match");
        assert_eq!(loc.path, "C:\\Users\\jesus\\src\\foo.rs");
        assert_eq!(loc.line, 42);
    }

    #[test]
    fn returns_none_on_prose_without_location() {
        assert!(first_location("the alert says version 1.0:0 broke").is_none());
        assert!(first_location("").is_none());
    }

    #[test]
    fn picks_first_match_when_multiple_present() {
        let text =
            "at outer (/srv/a.js:10:1)\nat inner (/srv/b.js:20:1)\nFile \"/srv/c.py\", line 30";
        let loc = first_location(text).expect("match");
        assert_eq!(loc.path, "/srv/a.js");
        assert_eq!(loc.line, 10);
    }
}
