//! Six concrete `ChatTool`s that surface the host OS to the chat
//! agent. Defaults follow the v0.3 plan (§S3): reads run [`Auto`],
//! writes/launches require [`Confirm`].
//!
//! | name                      | default      | side effect                    |
//! |---------------------------|--------------|--------------------------------|
//! | `desktop.open_in_editor`  | [`Confirm`]  | open file in default app       |
//! | `desktop.open_url`        | [`Confirm`]  | open https URL in browser      |
//! | `desktop.read_clipboard`  | [`Auto`]     | read OS clipboard              |
//! | `desktop.write_clipboard` | [`Confirm`]  | write OS clipboard             |
//! | `desktop.notify`          | [`Auto`]     | OS notification toast          |
//! | `desktop.focus_window`    | [`Confirm`]  | bring an app to the foreground |
//!
//! Every tool sits behind a small backend trait so headless tests can
//! drive the pipeline without spinning up a Tauri runtime — the only
//! concrete code that touches Tauri lives in the `Tauri*Backend`
//! structs at the bottom of this file. `Mock*Backend` siblings are
//! kept `pub` (not `#[cfg(test)]`) so the integration tests in
//! `tests/agent_desktop_os_tools.rs` can build a registry harness
//! without depending on Tauri.
//!
//! Boot wire-up of the registry itself lands in S6 (chat surface).
//! S3 only ships the tool implementations + the
//! [`register_desktop_os_tools`] helper.
//!
//! [`Auto`]: super::super::PermissionLevel::Auto
//! [`Confirm`]: super::super::PermissionLevel::Confirm

use std::process::Stdio;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};

use super::super::{
    ChatTool, PermissionLevel, RegistryError, ToolError, ToolInvocation, ToolMeta, ToolOutput,
    ToolRegistry,
};

// ── Editor backend ───────────────────────────────────────────────────────────

/// Opens a path in the user's default app for that file type. Used by
/// [`OpenInEditorTool`]. The `line` hint is best-effort — the Tauri
/// production backend currently ignores it because the system "open"
/// path doesn't accept a line argument; passing it through anyway lets
/// future backends (a `code://`/`zed://` URL handler, say) honour it
/// without changing the trait.
pub trait EditorBackend: Send + Sync + 'static {
    fn open(&self, path: &str, line: Option<u32>) -> Result<(), String>;
}

/// Records every `open` call so tests can assert "the tool forwarded
/// the args correctly" without a Tauri runtime. Holds an optional
/// failure mode so the "backend error → ExecutionFailed" path is
/// covered too.
#[derive(Default)]
pub struct MockEditorBackend {
    inner: Mutex<MockEditorState>,
}

#[derive(Default)]
struct MockEditorState {
    calls: Vec<(String, Option<u32>)>,
    fail_with: Option<String>,
}

impl MockEditorBackend {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn fail_next(&self, msg: impl Into<String>) {
        self.inner.lock().unwrap().fail_with = Some(msg.into());
    }
    pub fn calls(&self) -> Vec<(String, Option<u32>)> {
        self.inner.lock().unwrap().calls.clone()
    }
}

impl EditorBackend for MockEditorBackend {
    fn open(&self, path: &str, line: Option<u32>) -> Result<(), String> {
        let mut s = self.inner.lock().unwrap();
        s.calls.push((path.to_string(), line));
        if let Some(msg) = s.fail_with.clone() {
            return Err(msg);
        }
        Ok(())
    }
}

/// Production backend — opens the path through the `tauri-plugin-opener`
/// plugin (which dispatches to the OS default-app handler).
pub struct TauriEditorBackend {
    app: tauri::AppHandle,
}

impl TauriEditorBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl EditorBackend for TauriEditorBackend {
    fn open(&self, path: &str, _line: Option<u32>) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.app
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

// ── URL opener backend ───────────────────────────────────────────────────────

/// Launches an https URL in the user's default browser.
pub trait UrlOpenerBackend: Send + Sync + 'static {
    fn open(&self, url: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct MockUrlOpenerBackend {
    inner: Mutex<MockUrlOpenerState>,
}

#[derive(Default)]
struct MockUrlOpenerState {
    calls: Vec<String>,
    fail_with: Option<String>,
}

impl MockUrlOpenerBackend {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn fail_next(&self, msg: impl Into<String>) {
        self.inner.lock().unwrap().fail_with = Some(msg.into());
    }
    pub fn calls(&self) -> Vec<String> {
        self.inner.lock().unwrap().calls.clone()
    }
}

impl UrlOpenerBackend for MockUrlOpenerBackend {
    fn open(&self, url: &str) -> Result<(), String> {
        let mut s = self.inner.lock().unwrap();
        s.calls.push(url.to_string());
        if let Some(msg) = s.fail_with.clone() {
            return Err(msg);
        }
        Ok(())
    }
}

pub struct TauriUrlOpenerBackend {
    app: tauri::AppHandle,
}

impl TauriUrlOpenerBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl UrlOpenerBackend for TauriUrlOpenerBackend {
    fn open(&self, url: &str) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

// ── Finder backend ───────────────────────────────────────────────────────────

/// Opens a directory (or file) in the OS file manager — Finder on
/// macOS, Explorer on Windows, the default file-manager on Linux.
/// Same Tauri primitive as the editor backend (`open_path`); separate
/// trait + tool because the user-facing semantics differ ("show this
/// in the OS" vs "open this in the editor") and we want distinct
/// audit-log + permission-settings entries for each.
pub trait FinderBackend: Send + Sync + 'static {
    fn open(&self, path: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct MockFinderBackend {
    inner: Mutex<MockFinderState>,
}

#[derive(Default)]
struct MockFinderState {
    calls: Vec<String>,
    fail_with: Option<String>,
}

impl MockFinderBackend {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn fail_next(&self, msg: impl Into<String>) {
        self.inner.lock().unwrap().fail_with = Some(msg.into());
    }
    pub fn calls(&self) -> Vec<String> {
        self.inner.lock().unwrap().calls.clone()
    }
}

impl FinderBackend for MockFinderBackend {
    fn open(&self, path: &str) -> Result<(), String> {
        let mut s = self.inner.lock().unwrap();
        s.calls.push(path.to_string());
        if let Some(msg) = s.fail_with.clone() {
            return Err(msg);
        }
        Ok(())
    }
}

pub struct TauriFinderBackend {
    app: tauri::AppHandle,
}

impl TauriFinderBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl FinderBackend for TauriFinderBackend {
    fn open(&self, path: &str) -> Result<(), String> {
        // Expand `~/foo` → `/Users/jesus/foo` (or Windows equivalent)
        // so users can type the natural shorthand.
        let expanded = expand_tilde(path);

        // Pre-flight existence check so we can surface a helpful
        // "not found" message with a parent-directory listing instead
        // of the generic Tauri opener error. The whole point of the
        // tool is "help me find this in the OS" — failing without
        // hints defeats the purpose.
        let p = std::path::Path::new(&expanded);
        if !p.exists() {
            return Err(not_found_with_hint(&expanded, p));
        }

        // `open_path` dispatches to the OS default — for a directory
        // that's Finder/Explorer/Files, for a file the parent folder
        // (some OSes also pre-select the file). Same primitive that
        // `TauriEditorBackend::open` uses, distinct trait so the
        // audit row + permission setting stay separate.
        use tauri_plugin_opener::OpenerExt;
        self.app
            .opener()
            .open_path(&expanded, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

/// Resolve a leading `~` to the user's home directory. Leaves any
/// other input unchanged. Public + free function so the test suite
/// can lock the expansion behavior without touching the Tauri runtime.
pub fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    } else if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Build a user-facing "path not found" message that, when possible,
/// suggests the closest matches from the parent directory ("did you
/// mean..."). Falls through to an alphabetical listing when nothing
/// fuzzy-matches the user's typed last component.
///
/// Public so a test can lock the wording (the chat surface displays
/// this string verbatim — drift is a regression).
///
/// Constraints (the user asked for "do it right because thousands of
/// files might come"):
///   - **Single-level** — only the immediate parent dir is scanned.
///     No recursion, ever. A `find` / `fd` style walk is a different
///     tool, not /finder.
///   - **Cap 5000 entries** — pathological dirs (build outputs, node_modules)
///     stop after 5k so the response stays under ~50 ms.
///   - **Top 5 suggestions** — never more, regardless of match count.
///   - **Score threshold** — only sugerir if substring / prefix match
///     OR Levenshtein distance ≤ 2. Anything weaker is noise.
///   - **Skip dotfiles** — almost never what the user means.
pub fn not_found_with_hint(displayed: &str, p: &std::path::Path) -> String {
    let parent = p.parent().filter(|pp| pp.exists());
    let query = p.file_name().and_then(|n| n.to_str());

    if let (Some(parent), Some(query)) = (parent, query) {
        // Tier 1: fuzzy "did you mean" against the parent dir.
        let suggestions = fuzzy_search_dir(parent, query, 5);
        if !suggestions.is_empty() {
            let formatted: Vec<String> = suggestions
                .iter()
                .map(|name| format!("`{}`", parent.join(name).display()))
                .collect();
            return format!(
                "Path `{displayed}` not found. Did you mean: {}?",
                formatted.join(", ")
            );
        }
        // Tier 2: alphabetical listing of the parent (fallback when no
        // fuzzy match cleared the score threshold — usually means the
        // user typed something completely unrelated).
        let entries = list_dir_top_n(parent, 6);
        if !entries.is_empty() {
            return format!(
                "Path `{displayed}` not found. Nearby in `{}`: {}.",
                parent.display(),
                entries.join(", ")
            );
        }
        return format!(
            "Path `{displayed}` not found. Parent `{}` is empty.",
            parent.display()
        );
    }

    // No parent (e.g. user typed `/` itself) — confirm the miss with no
    // listing to show.
    format!("Path `{displayed}` not found.")
}

/// Score a candidate filename against the user's typed query.
/// Returns 0 if the match is below threshold (= caller drops it).
///
/// Tiers (highest first):
///   - 100: exact prefix match (e.g. `Down` matches `Downloads`)
///   -  80: substring match (e.g. `down` matches `MyDownloads`)
///   -  60-30: Levenshtein distance ≤ 2 (typos like `Downloeds` → `Downloads`)
///   -   0: anything else
///
/// Case-insensitive throughout — file managers are case-insensitive
/// on macOS and Windows, and case-insensitive matching is the friendly
/// default on Linux too.
pub fn fuzzy_score(query: &str, candidate: &str) -> u32 {
    let q = query.to_lowercase();
    let c = candidate.to_lowercase();
    if q.is_empty() || c.is_empty() {
        return 0;
    }
    if c.starts_with(&q) {
        return 100;
    }
    if c.contains(&q) {
        return 80;
    }
    let d = levenshtein(&q, &c);
    if d == 1 {
        return 60;
    }
    if d == 2 {
        return 40;
    }
    0
}

/// Standard O(n·m) Levenshtein. Inlined (no extra dep) — file names
/// are short enough that the matrix fits in a couple of small Vecs.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr: Vec<usize> = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

/// Read up to 5000 entries from `dir`, score each against `query`, and
/// return the top `limit` by descending score (ties broken alphabetically).
/// The 5000 cap is the safety valve — pathological dirs (huge
/// `node_modules` / build outputs) stop scanning instead of building
/// a 100k-element vector.
fn fuzzy_search_dir(dir: &std::path::Path, query: &str, limit: usize) -> Vec<String> {
    const MAX_SCAN: usize = 5000;
    let mut scored: Vec<(u32, String)> = match std::fs::read_dir(dir) {
        Ok(iter) => iter
            .take(MAX_SCAN)
            .filter_map(|entry| entry.ok().and_then(|e| e.file_name().into_string().ok()))
            .filter(|name| !name.starts_with('.'))
            .filter_map(|name| {
                let s = fuzzy_score(query, &name);
                if s > 0 {
                    Some((s, name))
                } else {
                    None
                }
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    // Sort: score descending, then alphabetical for ties so the order
    // is deterministic across runs.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, n)| n).collect()
}

fn list_dir_top_n(dir: &std::path::Path, n: usize) -> Vec<String> {
    let mut entries: Vec<String> = std::fs::read_dir(dir)
        .ok()
        .map(|iter| {
            iter.take(5000) // same safety cap as fuzzy_search_dir
                .filter_map(|entry| entry.ok().and_then(|e| e.file_name().into_string().ok()))
                // Hide dotfiles — they're noise for the "did you mean"
                // hint and the user almost never wants to open one in
                // the file manager directly.
                .filter(|name| !name.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    entries.truncate(n);
    entries
}

// ── Clipboard backend ────────────────────────────────────────────────────────

/// Reads + writes the OS text clipboard. Two operations on one trait
/// so the round-trip mock holds one shared buffer.
pub trait ClipboardBackend: Send + Sync + 'static {
    fn read_text(&self) -> Result<String, String>;
    fn write_text(&self, text: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct MockClipboardBackend {
    inner: Mutex<MockClipboardState>,
}

#[derive(Default)]
struct MockClipboardState {
    contents: String,
    fail_read: Option<String>,
    fail_write: Option<String>,
    reads: usize,
    writes: usize,
}

impl MockClipboardBackend {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_initial(text: impl Into<String>) -> Self {
        let me = Self::default();
        me.inner.lock().unwrap().contents = text.into();
        me
    }
    pub fn fail_read_next(&self, msg: impl Into<String>) {
        self.inner.lock().unwrap().fail_read = Some(msg.into());
    }
    pub fn fail_write_next(&self, msg: impl Into<String>) {
        self.inner.lock().unwrap().fail_write = Some(msg.into());
    }
    pub fn snapshot(&self) -> String {
        self.inner.lock().unwrap().contents.clone()
    }
    pub fn read_count(&self) -> usize {
        self.inner.lock().unwrap().reads
    }
    pub fn write_count(&self) -> usize {
        self.inner.lock().unwrap().writes
    }
}

impl ClipboardBackend for MockClipboardBackend {
    fn read_text(&self) -> Result<String, String> {
        let mut s = self.inner.lock().unwrap();
        s.reads += 1;
        if let Some(msg) = s.fail_read.clone() {
            return Err(msg);
        }
        Ok(s.contents.clone())
    }
    fn write_text(&self, text: &str) -> Result<(), String> {
        let mut s = self.inner.lock().unwrap();
        s.writes += 1;
        if let Some(msg) = s.fail_write.clone() {
            return Err(msg);
        }
        s.contents = text.to_string();
        Ok(())
    }
}

pub struct TauriClipboardBackend {
    app: tauri::AppHandle,
}

impl TauriClipboardBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ClipboardBackend for TauriClipboardBackend {
    fn read_text(&self) -> Result<String, String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app.clipboard().read_text().map_err(|e| e.to_string())
    }
    fn write_text(&self, text: &str) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app
            .clipboard()
            .write_text(text.to_string())
            .map_err(|e| e.to_string())
    }
}

// ── Notify backend ───────────────────────────────────────────────────────────

/// Shows an OS notification toast.
pub trait NotifyBackend: Send + Sync + 'static {
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct MockNotifyBackend {
    inner: Mutex<MockNotifyState>,
}

#[derive(Default)]
struct MockNotifyState {
    calls: Vec<(String, String)>,
    fail_with: Option<String>,
}

impl MockNotifyBackend {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn fail_next(&self, msg: impl Into<String>) {
        self.inner.lock().unwrap().fail_with = Some(msg.into());
    }
    pub fn calls(&self) -> Vec<(String, String)> {
        self.inner.lock().unwrap().calls.clone()
    }
}

impl NotifyBackend for MockNotifyBackend {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        let mut s = self.inner.lock().unwrap();
        s.calls.push((title.to_string(), body.to_string()));
        if let Some(msg) = s.fail_with.clone() {
            return Err(msg);
        }
        Ok(())
    }
}

pub struct TauriNotifyBackend {
    app: tauri::AppHandle,
}

impl TauriNotifyBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl NotifyBackend for TauriNotifyBackend {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

// ── Window focus backend ─────────────────────────────────────────────────────

/// Brings a running app to the foreground. There is no Tauri plugin
/// covering this cross-platform — see [`TauriWindowFocusBackend`] for
/// the per-OS shell-out we use.
pub trait WindowFocusBackend: Send + Sync + 'static {
    fn focus(&self, name: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct MockWindowFocusBackend {
    inner: Mutex<MockWindowFocusState>,
}

#[derive(Default)]
struct MockWindowFocusState {
    calls: Vec<String>,
    fail_with: Option<String>,
}

impl MockWindowFocusBackend {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn fail_next(&self, msg: impl Into<String>) {
        self.inner.lock().unwrap().fail_with = Some(msg.into());
    }
    pub fn calls(&self) -> Vec<String> {
        self.inner.lock().unwrap().calls.clone()
    }
}

impl WindowFocusBackend for MockWindowFocusBackend {
    fn focus(&self, name: &str) -> Result<(), String> {
        let mut s = self.inner.lock().unwrap();
        s.calls.push(name.to_string());
        if let Some(msg) = s.fail_with.clone() {
            return Err(msg);
        }
        Ok(())
    }
}

/// Best-effort cross-platform window focus. Matching is by executable
/// /bundle name, not window title — `name` is interpreted by the
/// platform shell command:
///
/// - **macOS:** `open -a <name>` (NSWorkspace; matches by bundle id or
///   app name).
/// - **Windows:** `cmd /C start "" <name>` (the Start Menu resolver
///   used by `Win+R`; matches by exe basename in PATH or by registered
///   App Path).
/// - **Linux:** `wmctrl -a <name>`. Returns `ExecutionFailed` if
///   `wmctrl` is not installed — there is no kernel-level "raise this
///   window" primitive on X11 / Wayland we can rely on.
///
/// Spawning is fire-and-forget: we only wait for the process to be
/// successfully launched (status code 0). A non-zero exit becomes an
/// `ExecutionFailed`.
pub struct TauriWindowFocusBackend;

impl WindowFocusBackend for TauriWindowFocusBackend {
    fn focus(&self, name: &str) -> Result<(), String> {
        focus_window_platform(name)
    }
}

#[cfg(target_os = "macos")]
fn focus_window_platform(name: &str) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(["-a", name])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("open -a failed to launch: {e}"))?;
    if !status.success() {
        return Err(format!("open -a {name} exited with {status}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn focus_window_platform(name: &str) -> Result<(), String> {
    // `cmd /C start "" <name>` mirrors what the Start Menu / `Win+R`
    // dialog resolves: PATH lookup → App Paths registry. The empty
    // string between `start` and the target is the (optional) window
    // title placeholder — without it `start` would interpret a quoted
    // first arg as the title and silently swallow the real target.
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", name])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("cmd /C start failed to launch: {e}"))?;
    if !status.success() {
        return Err(format!("cmd /C start \"\" {name} exited with {status}"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn focus_window_platform(name: &str) -> Result<(), String> {
    let status = std::process::Command::new("wmctrl")
        .args(["-a", name])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|_| {
            "focus_window unsupported on this Linux desktop: install wmctrl (apt install wmctrl)"
                .to_string()
        })?;
    if !status.success() {
        return Err(format!("wmctrl -a {name} exited with {status}"));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn focus_window_platform(_name: &str) -> Result<(), String> {
    Err("focus_window unsupported on this platform".to_string())
}

// ── Tool metadata ────────────────────────────────────────────────────────────
//
// One `*_meta()` helper per tool keeps the metadata exactly once: the
// concrete `Tool::new()` constructors clone it for the registry, and
// the [`catalog`] aggregator returns it without instantiating any
// backend. S11's permission-settings UI reads through `catalog()`, so
// the metadata source-of-truth must be reachable without a Tauri
// runtime / mock backends.

fn open_in_editor_meta() -> ToolMeta {
    ToolMeta {
        name: "desktop.open_in_editor".into(),
        description:
            "Open a file in the user's default editor. Set `line` to jump to a specific 1-based line number when supported."
                .into(),
        params_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "line": { "type": "integer", "minimum": 1 }
            }
        }),
        default_permission: PermissionLevel::Confirm,
    }
}

fn open_url_meta() -> ToolMeta {
    ToolMeta {
        name: "desktop.open_url".into(),
        description: "Open an https URL in the user's default browser.".into(),
        params_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["url"],
            "properties": {
                "url": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^https?://"
                }
            }
        }),
        default_permission: PermissionLevel::Confirm,
    }
}

fn open_finder_meta() -> ToolMeta {
    ToolMeta {
        name: "desktop.open_finder".into(),
        description: "Open a directory (or file) in the OS file manager — Finder, Explorer, or Files. Use to surface generated artifacts (logs, exports, screenshots) in the OS without opening a terminal.".into(),
        params_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "minLength": 1 }
            }
        }),
        default_permission: PermissionLevel::Confirm,
    }
}

fn read_clipboard_meta() -> ToolMeta {
    ToolMeta {
        name: "desktop.read_clipboard".into(),
        description: "Read the current text contents of the OS clipboard.".into(),
        params_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        }),
        default_permission: PermissionLevel::Auto,
    }
}

fn write_clipboard_meta() -> ToolMeta {
    ToolMeta {
        name: "desktop.write_clipboard".into(),
        description: "Replace the OS clipboard with `text`.".into(),
        params_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["text"],
            "properties": {
                "text": { "type": "string" }
            }
        }),
        default_permission: PermissionLevel::Confirm,
    }
}

fn notify_meta() -> ToolMeta {
    ToolMeta {
        name: "desktop.notify".into(),
        description: "Show an OS notification with `title` and `body`.".into(),
        params_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title", "body"],
            "properties": {
                "title": { "type": "string", "minLength": 1 },
                "body": { "type": "string" }
            }
        }),
        default_permission: PermissionLevel::Auto,
    }
}

fn focus_window_meta() -> ToolMeta {
    ToolMeta {
        name: "desktop.focus_window".into(),
        description:
            "Bring an application to the foreground. Matches by executable / bundle name (not window title)."
                .into(),
        params_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["name"],
            "properties": {
                "name": { "type": "string", "minLength": 1 }
            }
        }),
        default_permission: PermissionLevel::Confirm,
    }
}

/// Metadata for every tool in this cluster. Returned in the same order
/// [`register_desktop_os_tools`] inserts them so a settings UI built on
/// top of the catalog mirrors the registry's layout 1:1. Pure data —
/// callers never need to construct backends or a Tauri runtime.
pub fn catalog() -> Vec<ToolMeta> {
    vec![
        open_in_editor_meta(),
        open_url_meta(),
        open_finder_meta(),
        read_clipboard_meta(),
        write_clipboard_meta(),
        notify_meta(),
        focus_window_meta(),
    ]
}

// ── Tools ────────────────────────────────────────────────────────────────────

/// `desktop.open_in_editor` — open a file path in the user's default
/// app. Optional `line` hint is forwarded to the backend (currently
/// best-effort; see [`EditorBackend`]).
pub struct OpenInEditorTool {
    meta: ToolMeta,
    backend: Arc<dyn EditorBackend>,
}

impl OpenInEditorTool {
    pub fn new(backend: Arc<dyn EditorBackend>) -> Self {
        Self {
            meta: open_in_editor_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for OpenInEditorTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let path = invocation
            .args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing path".into()))?
            .to_string();
        let line = invocation.args.get("line").and_then(Value::as_u64).map(|n| n as u32);
        self.backend
            .open(&path, line)
            .map_err(ToolError::ExecutionFailed)?;
        let summary = match line {
            Some(n) => format!("Opened {path} at line {n}"),
            None => format!("Opened {path}"),
        };
        Ok(ToolOutput {
            value: json!({ "ok": true, "path": path, "line": line }),
            summary: Some(summary),
        })
    }
}

/// `desktop.open_url` — open an https URL in the default browser. The
/// schema's `pattern` blocks `file:`/`javascript:`/`data:` etc. at the
/// registry level, so this tool never sees a non-http payload.
pub struct OpenUrlTool {
    meta: ToolMeta,
    backend: Arc<dyn UrlOpenerBackend>,
}

impl OpenUrlTool {
    pub fn new(backend: Arc<dyn UrlOpenerBackend>) -> Self {
        Self {
            meta: open_url_meta(),
            backend,
        }
    }
}

/// `desktop.open_finder` — open a path in the OS file manager.
/// Distinct from `open_in_editor` (which opens a file in its default
/// editor) and `open_url` (which opens a URL in the browser); same
/// `Confirm` default because all three launch a window the user
/// didn't explicitly click for.
pub struct OpenFinderTool {
    meta: ToolMeta,
    backend: Arc<dyn FinderBackend>,
}

impl OpenFinderTool {
    pub fn new(backend: Arc<dyn FinderBackend>) -> Self {
        Self {
            meta: open_finder_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for OpenFinderTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let path = invocation
            .args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing path".into()))?
            .to_string();
        self.backend
            .open(&path)
            .map_err(ToolError::ExecutionFailed)?;
        Ok(ToolOutput {
            value: json!({ "ok": true, "path": path }),
            summary: Some(format!("Opened {path} in the OS file manager")),
        })
    }
}

#[async_trait]
impl ChatTool for OpenUrlTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let url = invocation
            .args
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing url".into()))?
            .to_string();
        self.backend.open(&url).map_err(ToolError::ExecutionFailed)?;
        Ok(ToolOutput {
            value: json!({ "ok": true, "url": url }),
            summary: Some(format!("Opened {url}")),
        })
    }
}

/// `desktop.read_clipboard` — read the OS text clipboard.
pub struct ReadClipboardTool {
    meta: ToolMeta,
    backend: Arc<dyn ClipboardBackend>,
}

impl ReadClipboardTool {
    pub fn new(backend: Arc<dyn ClipboardBackend>) -> Self {
        Self {
            meta: read_clipboard_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for ReadClipboardTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, _invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let text = self.backend.read_text().map_err(ToolError::ExecutionFailed)?;
        let summary = if text.is_empty() {
            "Clipboard is empty".to_string()
        } else {
            format!("Read {} chars from clipboard", text.chars().count())
        };
        Ok(ToolOutput {
            value: json!({ "ok": true, "text": text }),
            summary: Some(summary),
        })
    }
}

/// `desktop.write_clipboard` — replace the OS text clipboard.
pub struct WriteClipboardTool {
    meta: ToolMeta,
    backend: Arc<dyn ClipboardBackend>,
}

impl WriteClipboardTool {
    pub fn new(backend: Arc<dyn ClipboardBackend>) -> Self {
        Self {
            meta: write_clipboard_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for WriteClipboardTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let text = invocation
            .args
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing text".into()))?
            .to_string();
        self.backend
            .write_text(&text)
            .map_err(ToolError::ExecutionFailed)?;
        Ok(ToolOutput {
            value: json!({ "ok": true, "bytes": text.len() }),
            summary: Some(format!("Wrote {} chars to clipboard", text.chars().count())),
        })
    }
}

/// `desktop.notify` — show an OS notification toast.
pub struct NotifyTool {
    meta: ToolMeta,
    backend: Arc<dyn NotifyBackend>,
}

impl NotifyTool {
    pub fn new(backend: Arc<dyn NotifyBackend>) -> Self {
        Self {
            meta: notify_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for NotifyTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let title = invocation
            .args
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing title".into()))?
            .to_string();
        let body = invocation
            .args
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.backend
            .notify(&title, &body)
            .map_err(ToolError::ExecutionFailed)?;
        Ok(ToolOutput {
            value: json!({ "ok": true }),
            summary: Some(format!("Notified: {title}")),
        })
    }
}

/// `desktop.focus_window` — bring an app to the foreground. Matching
/// is by executable / bundle name, not window title (see
/// [`TauriWindowFocusBackend`]).
pub struct FocusWindowTool {
    meta: ToolMeta,
    backend: Arc<dyn WindowFocusBackend>,
}

impl FocusWindowTool {
    pub fn new(backend: Arc<dyn WindowFocusBackend>) -> Self {
        Self {
            meta: focus_window_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for FocusWindowTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let name = invocation
            .args
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing name".into()))?
            .to_string();
        self.backend
            .focus(&name)
            .map_err(ToolError::ExecutionFailed)?;
        Ok(ToolOutput {
            value: json!({ "ok": true, "name": name }),
            summary: Some(format!("Focused {name}")),
        })
    }
}

// ── Bundle + register helper ─────────────────────────────────────────────────

/// All five backends the desktop-OS cluster needs. Tests construct
/// this with `Mock*` impls; production wires it via [`Self::from_app`]
/// which builds the `Tauri*` impls from a Tauri [`AppHandle`].
pub struct DesktopOsBackends {
    pub editor: Arc<dyn EditorBackend>,
    pub url_opener: Arc<dyn UrlOpenerBackend>,
    pub finder: Arc<dyn FinderBackend>,
    pub clipboard: Arc<dyn ClipboardBackend>,
    pub notify: Arc<dyn NotifyBackend>,
    pub window_focus: Arc<dyn WindowFocusBackend>,
}

impl DesktopOsBackends {
    /// Production constructor — uses the Tauri plugin layer for every
    /// effect except `focus_window`, which shells out per-platform.
    pub fn from_app(app: tauri::AppHandle) -> Self {
        Self {
            editor: Arc::new(TauriEditorBackend::new(app.clone())),
            url_opener: Arc::new(TauriUrlOpenerBackend::new(app.clone())),
            finder: Arc::new(TauriFinderBackend::new(app.clone())),
            clipboard: Arc::new(TauriClipboardBackend::new(app.clone())),
            notify: Arc::new(TauriNotifyBackend::new(app)),
            window_focus: Arc::new(TauriWindowFocusBackend),
        }
    }
}

/// Register the six desktop-OS tools on `reg`. Errors propagate the
/// first [`RegistryError::DuplicateTool`] — there is no partial-rollback
/// path (the registry is process-local; on a duplicate the boot
/// sequence aborts and the user sees the error).
pub fn register_desktop_os_tools(
    reg: &ToolRegistry,
    backends: DesktopOsBackends,
) -> Result<(), RegistryError> {
    reg.register(Arc::new(OpenInEditorTool::new(backends.editor)))?;
    reg.register(Arc::new(OpenUrlTool::new(backends.url_opener)))?;
    reg.register(Arc::new(OpenFinderTool::new(backends.finder)))?;
    let clip = backends.clipboard;
    reg.register(Arc::new(ReadClipboardTool::new(clip.clone())))?;
    reg.register(Arc::new(WriteClipboardTool::new(clip)))?;
    reg.register(Arc::new(NotifyTool::new(backends.notify)))?;
    reg.register(Arc::new(FocusWindowTool::new(backends.window_focus)))?;
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation(name: &str, args: Value) -> ToolInvocation {
        ToolInvocation {
            id: "test-id".into(),
            tool_name: name.into(),
            args,
            session_id: None,
        }
    }

    // ── open_in_editor ──────────────────────────────────────────────────────

    #[test]
    fn open_in_editor_meta_advertises_confirm_default() {
        let tool = OpenInEditorTool::new(Arc::new(MockEditorBackend::new()));
        assert_eq!(tool.meta().name, "desktop.open_in_editor");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
    }

    #[tokio::test]
    async fn open_in_editor_forwards_path_and_line_to_backend() {
        let backend = Arc::new(MockEditorBackend::new());
        let tool = OpenInEditorTool::new(backend.clone());
        let inv = invocation(
            "desktop.open_in_editor",
            json!({ "path": "/tmp/x.rs", "line": 42 }),
        );
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["ok"], json!(true));
        assert_eq!(out.value["path"], json!("/tmp/x.rs"));
        assert_eq!(out.value["line"], json!(42));
        assert_eq!(backend.calls(), vec![("/tmp/x.rs".into(), Some(42))]);
    }

    #[tokio::test]
    async fn open_in_editor_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockEditorBackend::new());
        backend.fail_next("editor not found");
        let tool = OpenInEditorTool::new(backend);
        let inv = invocation("desktop.open_in_editor", json!({ "path": "/tmp/x.rs" }));
        let err = tool.execute(&inv).await.expect_err("must fail");
        match err {
            ToolError::ExecutionFailed(m) => assert_eq!(m, "editor not found"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    // ── open_url ────────────────────────────────────────────────────────────

    #[test]
    fn open_url_meta_advertises_confirm_default_and_https_pattern() {
        let tool = OpenUrlTool::new(Arc::new(MockUrlOpenerBackend::new()));
        assert_eq!(tool.meta().name, "desktop.open_url");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
        let pattern = tool.meta().params_schema["properties"]["url"]["pattern"]
            .as_str()
            .expect("schema must constrain url with a regex");
        assert_eq!(pattern, "^https?://");
    }

    #[tokio::test]
    async fn open_url_forwards_url_to_backend() {
        let backend = Arc::new(MockUrlOpenerBackend::new());
        let tool = OpenUrlTool::new(backend.clone());
        let inv = invocation(
            "desktop.open_url",
            json!({ "url": "https://app.inariwatch.com" }),
        );
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["ok"], json!(true));
        assert_eq!(backend.calls(), vec!["https://app.inariwatch.com".to_string()]);
    }

    #[tokio::test]
    async fn open_url_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockUrlOpenerBackend::new());
        backend.fail_next("no browser");
        let tool = OpenUrlTool::new(backend);
        let inv = invocation("desktop.open_url", json!({ "url": "https://x" }));
        let err = tool.execute(&inv).await.expect_err("must fail");
        assert!(matches!(err, ToolError::ExecutionFailed(m) if m == "no browser"));
    }

    // ── read_clipboard ──────────────────────────────────────────────────────

    #[test]
    fn read_clipboard_meta_advertises_auto_default() {
        let tool = ReadClipboardTool::new(Arc::new(MockClipboardBackend::new()));
        assert_eq!(tool.meta().name, "desktop.read_clipboard");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Auto);
    }

    #[tokio::test]
    async fn read_clipboard_returns_backend_text() {
        let backend = Arc::new(MockClipboardBackend::with_initial("hello"));
        let tool = ReadClipboardTool::new(backend.clone());
        let inv = invocation("desktop.read_clipboard", json!({}));
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["text"], json!("hello"));
        assert_eq!(backend.read_count(), 1);
    }

    #[tokio::test]
    async fn read_clipboard_propagates_backend_error() {
        let backend = Arc::new(MockClipboardBackend::new());
        backend.fail_read_next("clipboard locked");
        let tool = ReadClipboardTool::new(backend);
        let err = tool
            .execute(&invocation("desktop.read_clipboard", json!({})))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::ExecutionFailed(m) if m == "clipboard locked"));
    }

    // ── write_clipboard ─────────────────────────────────────────────────────

    #[test]
    fn write_clipboard_meta_advertises_confirm_default() {
        let tool = WriteClipboardTool::new(Arc::new(MockClipboardBackend::new()));
        assert_eq!(tool.meta().name, "desktop.write_clipboard");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
    }

    #[tokio::test]
    async fn write_clipboard_replaces_backend_buffer() {
        let backend = Arc::new(MockClipboardBackend::with_initial("old"));
        let tool = WriteClipboardTool::new(backend.clone());
        let out = tool
            .execute(&invocation(
                "desktop.write_clipboard",
                json!({ "text": "new" }),
            ))
            .await
            .expect("ok");
        assert_eq!(out.value["ok"], json!(true));
        assert_eq!(backend.snapshot(), "new");
        assert_eq!(backend.write_count(), 1);
    }

    #[tokio::test]
    async fn read_then_write_then_read_round_trip_through_one_backend() {
        let backend: Arc<dyn ClipboardBackend> = Arc::new(MockClipboardBackend::new());
        let reader = ReadClipboardTool::new(backend.clone());
        let writer = WriteClipboardTool::new(backend.clone());

        let pre = reader
            .execute(&invocation("desktop.read_clipboard", json!({})))
            .await
            .expect("read pre");
        assert_eq!(pre.value["text"], json!(""));

        writer
            .execute(&invocation(
                "desktop.write_clipboard",
                json!({ "text": "hello" }),
            ))
            .await
            .expect("write");

        let post = reader
            .execute(&invocation("desktop.read_clipboard", json!({})))
            .await
            .expect("read post");
        assert_eq!(post.value["text"], json!("hello"));
    }

    // ── notify ──────────────────────────────────────────────────────────────

    #[test]
    fn notify_meta_advertises_auto_default() {
        let tool = NotifyTool::new(Arc::new(MockNotifyBackend::new()));
        assert_eq!(tool.meta().name, "desktop.notify");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Auto);
    }

    #[tokio::test]
    async fn notify_forwards_title_and_body_to_backend() {
        let backend = Arc::new(MockNotifyBackend::new());
        let tool = NotifyTool::new(backend.clone());
        tool.execute(&invocation(
            "desktop.notify",
            json!({ "title": "Build", "body": "green" }),
        ))
        .await
        .expect("ok");
        assert_eq!(
            backend.calls(),
            vec![("Build".to_string(), "green".to_string())]
        );
    }

    #[tokio::test]
    async fn notify_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockNotifyBackend::new());
        backend.fail_next("permission denied");
        let tool = NotifyTool::new(backend);
        let err = tool
            .execute(&invocation(
                "desktop.notify",
                json!({ "title": "x", "body": "" }),
            ))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::ExecutionFailed(m) if m == "permission denied"));
    }

    // ── focus_window ────────────────────────────────────────────────────────

    #[test]
    fn focus_window_meta_advertises_confirm_default() {
        let tool = FocusWindowTool::new(Arc::new(MockWindowFocusBackend::new()));
        assert_eq!(tool.meta().name, "desktop.focus_window");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
    }

    #[tokio::test]
    async fn focus_window_forwards_name_to_backend() {
        let backend = Arc::new(MockWindowFocusBackend::new());
        let tool = FocusWindowTool::new(backend.clone());
        tool.execute(&invocation(
            "desktop.focus_window",
            json!({ "name": "Code" }),
        ))
        .await
        .expect("ok");
        assert_eq!(backend.calls(), vec!["Code".to_string()]);
    }

    #[tokio::test]
    async fn focus_window_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockWindowFocusBackend::new());
        backend.fail_next("wmctrl not installed");
        let tool = FocusWindowTool::new(backend);
        let err = tool
            .execute(&invocation(
                "desktop.focus_window",
                json!({ "name": "Code" }),
            ))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::ExecutionFailed(m) if m == "wmctrl not installed"));
    }

    // ── catalog ─────────────────────────────────────────────────────────────

    #[test]
    fn catalog_lists_all_seven_tools_in_register_order() {
        let cat = catalog();
        let names: Vec<&str> = cat.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "desktop.open_in_editor",
                "desktop.open_url",
                "desktop.open_finder",
                "desktop.read_clipboard",
                "desktop.write_clipboard",
                "desktop.notify",
                "desktop.focus_window",
            ],
        );
    }

    #[test]
    fn catalog_meta_matches_what_tools_advertise() {
        // Whitelist: each catalog entry must equal the meta the concrete
        // `Tool::new(mock)` constructs. Locks the "metadata is in one
        // place" invariant — if a future edit drifts catalog from
        // tool-side, this fails before the registry boots.
        let cat = catalog();
        assert_eq!(
            cat[0].default_permission,
            OpenInEditorTool::new(Arc::new(MockEditorBackend::new()))
                .meta()
                .default_permission
        );
        assert_eq!(
            cat[1].default_permission,
            OpenUrlTool::new(Arc::new(MockUrlOpenerBackend::new()))
                .meta()
                .default_permission
        );
        assert_eq!(
            cat[2].default_permission,
            OpenFinderTool::new(Arc::new(MockFinderBackend::new()))
                .meta()
                .default_permission
        );
        assert_eq!(
            cat[3].default_permission,
            ReadClipboardTool::new(Arc::new(MockClipboardBackend::new()))
                .meta()
                .default_permission
        );
        assert_eq!(
            cat[4].default_permission,
            WriteClipboardTool::new(Arc::new(MockClipboardBackend::new()))
                .meta()
                .default_permission
        );
        assert_eq!(
            cat[5].default_permission,
            NotifyTool::new(Arc::new(MockNotifyBackend::new()))
                .meta()
                .default_permission
        );
        assert_eq!(
            cat[6].default_permission,
            FocusWindowTool::new(Arc::new(MockWindowFocusBackend::new()))
                .meta()
                .default_permission
        );
    }

    // ── open_finder helpers (expand_tilde + not_found_with_hint) ────────────

    #[test]
    fn expand_tilde_replaces_leading_tilde_slash_with_home() {
        // We can't assume what `dirs::home_dir()` returns on the test
        // host, but we CAN assume the result no longer starts with `~/`
        // when home is resolvable, and falls through unchanged when it
        // is not. The conditional here keeps the test hermetic.
        let out = expand_tilde("~/exports");
        if let Some(home) = dirs::home_dir() {
            let want = home.join("exports").to_string_lossy().into_owned();
            assert_eq!(out, want);
        } else {
            assert_eq!(out, "~/exports");
        }
    }

    #[test]
    fn expand_tilde_replaces_lone_tilde_with_home() {
        let out = expand_tilde("~");
        if let Some(home) = dirs::home_dir() {
            assert_eq!(out, home.to_string_lossy());
        } else {
            assert_eq!(out, "~");
        }
    }

    #[test]
    fn expand_tilde_passes_through_non_tilde_paths() {
        assert_eq!(expand_tilde("/abs/path"), "/abs/path");
        assert_eq!(expand_tilde("./relative"), "./relative");
        assert_eq!(expand_tilde("plain"), "plain");
        // `~user` is NOT expanded — std `dirs` doesn't support it.
        assert_eq!(expand_tilde("~jesus/x"), "~jesus/x");
    }

    #[test]
    fn not_found_with_hint_falls_back_to_listing_when_no_fuzzy_match() {
        // Use the OS temp dir as a guaranteed-existing parent. Drop a
        // few sentinel children so the hint has something to list.
        // Query "does-not-exist" doesn't fuzzy-match alpha/beta/gamma
        // → fallback to alphabetical listing.
        let parent = std::env::temp_dir().join("inari_finder_listing_test");
        let _ = std::fs::create_dir_all(&parent);
        for name in ["alpha.txt", "beta", "gamma.log"] {
            let _ = std::fs::write(parent.join(name), b"");
        }
        let missing = parent.join("does-not-exist");
        let msg = not_found_with_hint(missing.to_string_lossy().as_ref(), &missing);
        assert!(msg.contains("not found"), "got: {msg}");
        assert!(msg.contains("Nearby"), "got: {msg}");
        assert!(msg.contains("alpha.txt"), "got: {msg}");

        // Cleanup — not strictly required (tmpdir is self-cleaning) but
        // keeps repeat runs from leaving sentinel files lying around.
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn not_found_with_hint_suggests_via_fuzzy_match_on_typo() {
        let parent = std::env::temp_dir().join("inari_finder_fuzzy_test");
        let _ = std::fs::create_dir_all(&parent);
        for name in ["Downloads", "Documents", "Desktop"] {
            let _ = std::fs::create_dir_all(parent.join(name));
        }
        // "Downloeds" is Levenshtein-distance-2 from "Downloads"
        // (delete 'a', insert 'e' — actually that's 2 substitutions
        // either way, the standard impl returns 2).
        let missing = parent.join("Downloeds");
        let msg = not_found_with_hint(missing.to_string_lossy().as_ref(), &missing);
        assert!(msg.contains("Did you mean"), "got: {msg}");
        assert!(msg.contains("Downloads"), "got: {msg}");
        // The other entries (Documents, Desktop) don't share a prefix
        // and have higher edit distance — they should NOT lead the
        // suggestion list. Acceptable that they appear (Documents
        // shares "Do") but Downloads should be the highest-ranked.
        let downloads_idx = msg.find("Downloads").unwrap();
        if let Some(other_idx) = msg.find("Documents") {
            assert!(
                downloads_idx < other_idx,
                "Downloads should outrank Documents — got: {msg}"
            );
        }

        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn not_found_with_hint_suggests_via_prefix_match() {
        let parent = std::env::temp_dir().join("inari_finder_prefix_test");
        let _ = std::fs::create_dir_all(&parent);
        for name in ["src", "scripts", "static"] {
            let _ = std::fs::create_dir_all(parent.join(name));
        }
        let missing = parent.join("sc"); // prefix of "scripts"
        let msg = not_found_with_hint(missing.to_string_lossy().as_ref(), &missing);
        assert!(msg.contains("Did you mean"), "got: {msg}");
        assert!(msg.contains("scripts"), "got: {msg}");

        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn fuzzy_score_prefix_beats_substring_beats_levenshtein() {
        // Hierarchy from the doc-comment of `fuzzy_score`. Locking
        // these makes sure a future tweak to the scoring constants
        // doesn't accidentally invert the ranking.
        assert_eq!(fuzzy_score("Down", "Downloads"), 100); // prefix
        assert_eq!(fuzzy_score("loads", "Downloads"), 80); // substring
        assert_eq!(fuzzy_score("Downloeds", "Downloads"), 40); // edit distance 2
        assert_eq!(fuzzy_score("xyzqp", "Downloads"), 0); // unrelated
    }

    #[test]
    fn fuzzy_score_is_case_insensitive() {
        assert_eq!(fuzzy_score("DOWN", "downloads"), 100);
        assert_eq!(fuzzy_score("loaDS", "Downloads"), 80);
    }

    #[test]
    fn fuzzy_score_handles_empty_inputs() {
        assert_eq!(fuzzy_score("", "Downloads"), 0);
        assert_eq!(fuzzy_score("Down", ""), 0);
    }

    #[test]
    fn open_finder_meta_advertises_confirm_default() {
        let tool = OpenFinderTool::new(Arc::new(MockFinderBackend::new()));
        assert_eq!(tool.meta().name, "desktop.open_finder");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
    }

    #[tokio::test]
    async fn open_finder_forwards_path_to_backend() {
        let backend = Arc::new(MockFinderBackend::new());
        let tool = OpenFinderTool::new(backend.clone());
        let inv = invocation("desktop.open_finder", json!({ "path": "/tmp/hello" }));
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["ok"], json!(true));
        assert_eq!(backend.calls(), vec!["/tmp/hello".to_string()]);
    }

    #[tokio::test]
    async fn open_finder_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockFinderBackend::new());
        backend.fail_next("disk error");
        let tool = OpenFinderTool::new(backend);
        let inv = invocation("desktop.open_finder", json!({ "path": "/tmp/x" }));
        let err = tool.execute(&inv).await.expect_err("must fail");
        match err {
            ToolError::ExecutionFailed(msg) => assert!(msg.contains("disk error")),
            other => panic!("expected ExecutionFailed, got {other:?}"),
        }
    }
}
