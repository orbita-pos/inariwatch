//! Local-execution tool cluster (S4) — six concrete `ChatTool`s that
//! let the agent shell out, read/write files, run the test suite, and
//! peek at git status/diff. **Highest-risk cluster in the v0.3 plan**:
//! a tool call here can read `~/.aws/credentials` or fan out to
//! `rm -rf` if the sandbox is wrong. The whole module is wired around
//! defence-in-depth — every single guarantee below is enforced in two
//! places (schema + backend) so a bug in one layer doesn't unsandbox
//! the agent on its own.
//!
//! | name                | default      | guards                                                |
//! |---------------------|--------------|-------------------------------------------------------|
//! | `local.run_shell`   | [`Confirm`]  | whitelist enum + argv-only + metacharacter regex      |
//! |                     |              |   + path-separator reject + env scrub + cwd-in-WS     |
//! |                     |              |   + 30s timeout + 1 MB stdout/stderr cap              |
//! | `local.read_file`   | [`Auto`]     | path canonical + WS-bounded + 10 MB cap (no truncate) |
//! | `local.write_file`  | [`Confirm`]  | parent canonical + WS-bounded + atomic rename + 10 MB |
//! |                     |              |   cap + symlink-overwrite reject + parent must exist  |
//! | `local.run_test`    | [`Confirm`]  | wraps `cargo test <pattern>`; pattern rejects `--`;   |
//! |                     |              |   cwd forced to workspace root; 5 min timeout         |
//! | `local.git_status`  | [`Auto`]     | `git status --porcelain`; cwd forced; 10 s timeout    |
//! | `local.git_diff`    | [`Auto`]     | `git diff [--staged] [-- path]`; cwd forced; 10 s     |
//!
//! ## Backend pattern (vs S3)
//!
//! Same `XBackend` seam as `desktop_os` BUT mocks are feature-gated
//! behind [`mocks`] (only compiled with `cfg(test)` or
//! `agent-test-utils`). Reason: a `MockShellBackend` that ignores
//! commands looks innocuous, but anything that can be imported from
//! production code might end up wrapping a real shell call in a test
//! harness someone forgot to scrub before merge. Keeping mocks out of
//! `pub` for default builds prevents that footgun.
//!
//! [`Auto`]: super::super::PermissionLevel::Auto
//! [`Confirm`]: super::super::PermissionLevel::Confirm

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::super::{
    ChatTool, PermissionLevel, RegistryError, ToolError, ToolInvocation, ToolMeta, ToolOutput,
    ToolRegistry,
};

// ── Shared output type ──────────────────────────────────────────────────────

/// Result of a single subprocess. Bytes-counted before truncation so
/// the audit row can carry "we saw X bytes total, kept the first Y" —
/// the field shape is the same whether the call came back from
/// [`TauriShellBackend`] or from a mock.
#[derive(Debug, Clone, Default)]
pub struct ShellOutput {
    /// Raw stdout, already capped to [`sandbox::OUTPUT_CAP`] bytes by
    /// the producer. UTF-8 lossy decode of the underlying bytes.
    pub stdout: String,
    /// Raw stderr, already capped. UTF-8 lossy decode.
    pub stderr: String,
    /// Exit code. `None` when the process was killed (timeout) before
    /// it could exit on its own.
    pub exit_code: Option<i32>,
    /// True when the wait timed out and we killed the child.
    pub timed_out: bool,
    /// Total stdout bytes seen on the wire (pre-cap). Lets the
    /// truncation marker in the JSON output report "we saw 4 MB but
    /// kept 1 MB" so downstream tools/users aren't surprised.
    pub stdout_total_bytes: usize,
    /// Same as `stdout_total_bytes`, for stderr.
    pub stderr_total_bytes: usize,
}

// ── Shell backend ───────────────────────────────────────────────────────────

/// Spawns a subprocess and waits for it. Implementations are
/// responsible for `kill_on_drop` + timeout-driven cleanup; the tool
/// layer above does NOT enforce a wall clock, only a per-call cap.
#[async_trait]
pub trait ShellBackend: Send + Sync + 'static {
    async fn run(
        &self,
        cmd: &str,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ShellOutput, String>;
}

/// Production shell backend — `tokio::process::Command` with
/// `kill_on_drop(true)`, env scrubbed via [`sandbox::env_allowlist`],
/// stdout/stderr piped and capped at [`sandbox::OUTPUT_CAP`].
pub struct TauriShellBackend;

impl Default for TauriShellBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl TauriShellBackend {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ShellBackend for TauriShellBackend {
    async fn run(
        &self,
        cmd: &str,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ShellOutput, String> {
        run_subprocess(cmd, args, cwd, timeout).await
    }
}

// ── Fs backend ──────────────────────────────────────────────────────────────

/// Result of a "what kind of FS entry is this" probe. We collapse the
/// `std::fs::FileType` flavours to the three we care about — a
/// directory, a regular file, or a symlink. NotFound returns `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// File-system seam. The tool layer never touches `std::fs` directly;
/// the trait keeps mocks honest and isolates the production calls in
/// one place ([`TauriFsBackend`]).
pub trait FsBackend: Send + Sync + 'static {
    /// Read a file. Bytes-only on purpose — the read-file tool decides
    /// whether the body is UTF-8.
    fn read(&self, path: &Path) -> Result<Vec<u8>, String>;

    /// Atomically write `content` to `path`. Implementations MUST write
    /// to a sibling tempfile + rename; partial writes leave the
    /// destination unchanged.
    fn write_atomic(&self, path: &Path, content: &[u8]) -> Result<(), String>;

    /// Resolve a path against its filesystem links. Behaves like
    /// `std::fs::canonicalize` — the path must exist; symlinks are
    /// followed.
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, String>;

    /// What is at `path`, *without* following symlinks. Returns `None`
    /// when the entry doesn't exist.
    fn symlink_kind(&self, path: &Path) -> Result<Option<FsKind>, String>;
}

/// Production [`FsBackend`] — pure `std::fs`. Atomic writes use a
/// `<dest>.inari-tmp-<uuid>` sibling + `rename`.
#[derive(Default)]
pub struct TauriFsBackend;

impl TauriFsBackend {
    pub fn new() -> Self {
        Self
    }
}

impl FsBackend for TauriFsBackend {
    fn read(&self, path: &Path) -> Result<Vec<u8>, String> {
        std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))
    }

    fn write_atomic(&self, path: &Path, content: &[u8]) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("no parent dir for {}", path.display()))?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut tmp_name = path
            .file_name()
            .map(|s| s.to_os_string())
            .unwrap_or_default();
        tmp_name.push(format!(".inari-tmp-{token}"));
        let tmp_path = parent.join(tmp_name);

        if let Err(e) = std::fs::write(&tmp_path, content) {
            // Best-effort cleanup; if the write itself failed there's
            // nothing to remove, but keep the cleanup in case a partial
            // file was created.
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("write tempfile {}: {e}", tmp_path.display()));
        }
        if let Err(e) = std::fs::rename(&tmp_path, path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!(
                "rename {} -> {}: {e}",
                tmp_path.display(),
                path.display()
            ));
        }
        Ok(())
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, String> {
        std::fs::canonicalize(path).map_err(|e| format!("canonicalize {}: {e}", path.display()))
    }

    fn symlink_kind(&self, path: &Path) -> Result<Option<FsKind>, String> {
        match std::fs::symlink_metadata(path) {
            Ok(md) => {
                let ft = md.file_type();
                let kind = if ft.is_symlink() {
                    FsKind::Symlink
                } else if ft.is_dir() {
                    FsKind::Dir
                } else if ft.is_file() {
                    FsKind::File
                } else {
                    FsKind::Other
                };
                Ok(Some(kind))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("symlink_metadata {}: {e}", path.display())),
        }
    }
}

// ── Git backend ─────────────────────────────────────────────────────────────

/// Operations needed by `local.git_status` and `local.git_diff`. Kept
/// distinct from [`ShellBackend`] so the tool layer can't smuggle
/// arbitrary args through — both methods take a *typed* set of options
/// and the backend is responsible for shelling `git` out itself.
#[async_trait]
pub trait GitBackend: Send + Sync + 'static {
    async fn status_porcelain(
        &self,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ShellOutput, String>;

    async fn diff(
        &self,
        cwd: &Path,
        staged: bool,
        path: Option<&Path>,
        timeout: Duration,
    ) -> Result<ShellOutput, String>;
}

/// Production git backend — invokes the real `git` binary on the
/// user's PATH. We do NOT bundle git; if the user's box has no `git`
/// the calls fail with `ExecutionFailed("spawn git: …")`, which is
/// the right behaviour (false positive on git_status is far better
/// than a silent fall-through).
#[derive(Default)]
pub struct TauriGitBackend;

impl TauriGitBackend {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl GitBackend for TauriGitBackend {
    async fn status_porcelain(
        &self,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ShellOutput, String> {
        let args = vec!["status".to_string(), "--porcelain=v1".to_string()];
        run_subprocess("git", &args, cwd, timeout).await
    }

    async fn diff(
        &self,
        cwd: &Path,
        staged: bool,
        path: Option<&Path>,
        timeout: Duration,
    ) -> Result<ShellOutput, String> {
        let mut args: Vec<String> = vec!["diff".into(), "--no-color".into()];
        if staged {
            args.push("--staged".into());
        }
        if let Some(p) = path {
            args.push("--".into());
            args.push(p.to_string_lossy().into_owned());
        }
        run_subprocess("git", &args, cwd, timeout).await
    }
}

// ── Subprocess plumbing (shared by Shell + Git Tauri backends) ──────────────

async fn run_subprocess(
    cmd: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<ShellOutput, String> {
    let env = sandbox::env_allowlist();
    let mut command = tokio::process::Command::new(cmd);
    command
        .args(args.iter().map(|s| s.as_str()))
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("spawn {cmd}: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe missing".to_string())?;

    let stdout_task = tokio::spawn(read_to_cap(stdout, sandbox::OUTPUT_CAP));
    let stderr_task = tokio::spawn(read_to_cap(stderr, sandbox::OUTPUT_CAP));

    let timed_out;
    let exit_code;
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => {
            timed_out = false;
            exit_code = status.code();
        }
        Ok(Err(e)) => return Err(format!("wait: {e}")),
        Err(_) => {
            timed_out = true;
            let _ = child.start_kill();
            let _ = child.wait().await;
            exit_code = None;
        }
    }

    let (stdout_buf, stdout_total) = stdout_task
        .await
        .map_err(|e| format!("stdout task: {e}"))?;
    let (stderr_buf, stderr_total) = stderr_task
        .await
        .map_err(|e| format!("stderr task: {e}"))?;

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&stdout_buf).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_buf).into_owned(),
        exit_code,
        timed_out,
        stdout_total_bytes: stdout_total,
        stderr_total_bytes: stderr_total,
    })
}

/// Read up to `cap` bytes from `pipe` into a buffer; keep draining the
/// pipe past `cap` (so the child doesn't block on a full pipe) but
/// only count the total. Returns `(captured, total_seen)`.
async fn read_to_cap<R: AsyncReadExt + Unpin>(mut pipe: R, cap: usize) -> (Vec<u8>, usize) {
    let mut captured: Vec<u8> = Vec::with_capacity(cap.min(8192));
    let mut total: usize = 0;
    let mut tmp = [0u8; 4096];
    loop {
        match pipe.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => {
                total = total.saturating_add(n);
                if captured.len() < cap {
                    let want = cap - captured.len();
                    let take = n.min(want);
                    captured.extend_from_slice(&tmp[..take]);
                }
            }
            Err(_) => break,
        }
    }
    (captured, total)
}

// ── Sandbox helpers (pure, easily testable) ─────────────────────────────────

pub mod sandbox {
    //! Pure sandbox helpers used by the tool layer. The constants and
    //! free functions in this module are the seat of the "what counts
    //! as safe" policy — every guard the tools enforce lives here so a
    //! security audit only has to read one file.

    use super::*;
    use once_cell::sync::Lazy;
    use regex::Regex;

    /// Programs the registry is willing to spawn. **Hard-coded on
    /// purpose** — the schema enum mirrors this list, and the backend
    /// re-checks it as defence-in-depth. Adding to this list is a
    /// security review; no setting / env var will let the user expand
    /// it at runtime in S4.
    ///
    /// Excluded by design (and reported back to the user verbatim):
    /// - any shell interpreter (`bash`, `sh`, `zsh`, `dash`, `fish`,
    ///   `cmd`, `cmd.exe`, `powershell`, `pwsh`) — they reintroduce
    ///   shell parsing, which the argv-only contract is here to
    ///   prevent.
    /// - free-form utilities (`ls`, `cat`, `echo`, `pwd`, `which`) —
    ///   we have dedicated tools for the legitimate use cases
    ///   (`local.read_file`, `local.git_status`); leaving them out
    ///   shrinks the attack surface.
    pub const SHELL_WHITELIST: &[&str] = &[
        "cargo", "npm", "npx", "pnpm", "yarn", "node", "bun", "git", "python", "pip", "rustc",
        "tsc",
    ];

    /// Environment variables passed through to the spawned subprocess.
    /// Everything else (every secret-shaped var the user has — AWS,
    /// GCP, Stripe, anything in `*_TOKEN`, …) is scrubbed. The list
    /// has to be wide enough that compilers and tooling still find
    /// their config: paths, locale, temp dirs, Windows shell roots.
    pub const ENV_ALLOWLIST: &[&str] = &[
        "PATH",
        "USER",
        "USERNAME",
        "HOME",
        "TZ",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "SystemRoot",
        "WINDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "USERPROFILE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "SystemDrive",
        "ComSpec",
        "PATHEXT",
    ];

    /// 1 MB cap on captured stdout/stderr per subprocess.
    pub const OUTPUT_CAP: usize = 1 << 20;
    /// 10 MB cap on `read_file` payloads. Read fails with
    /// `ExecutionFailed` past this; we do not truncate reads because a
    /// truncated file body lies about its content.
    pub const READ_FILE_MAX: usize = 10 << 20;
    /// 10 MB cap on `write_file` payloads.
    pub const WRITE_FILE_MAX: usize = 10 << 20;

    pub const RUN_SHELL_DEFAULT_TIMEOUT_MS: u64 = 30_000;
    pub const RUN_SHELL_MAX_TIMEOUT_MS: u64 = 300_000;
    pub const RUN_TEST_TIMEOUT_MS: u64 = 5 * 60 * 1_000;
    pub const GIT_TIMEOUT_MS: u64 = 10_000;

    /// Forbidden bytes in `args[]` strings: shell metacharacters that
    /// would re-introduce parsing if the spawned program ever piped
    /// args through `system()` (or, less hypothetically, if a future
    /// patch swapped `Command::new` for a shell invocation).
    static ARGV_FORBIDDEN: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"[;|&`<>\n\r]|\$\(").expect("argv forbidden regex compiles"));

    /// Reject programs that contain a path separator. Schema enum
    /// already rejects them at `validate_schema` time, but this is
    /// defence-in-depth in case a future patch loosens the schema or
    /// adds an entry to `SHELL_WHITELIST` that ships a slash by
    /// mistake.
    pub fn validate_program(prog: &str) -> Result<(), String> {
        if prog.is_empty() {
            return Err("program is empty".into());
        }
        if prog.contains('/') || prog.contains('\\') {
            return Err(format!(
                "program must be a bare name, not a path: {prog}"
            ));
        }
        if !SHELL_WHITELIST.contains(&prog) {
            return Err(format!("program {prog} is not on the shell whitelist"));
        }
        Ok(())
    }

    /// Reject argv entries that contain shell metacharacters.
    pub fn validate_argv(args: &[String]) -> Result<(), String> {
        for (i, a) in args.iter().enumerate() {
            if ARGV_FORBIDDEN.is_match(a) {
                return Err(format!(
                    "args[{i}] contains a forbidden metacharacter: {a:?}"
                ));
            }
        }
        Ok(())
    }

    /// Resolve `cwd` (caller-supplied, optional) against
    /// `workspace_root`, then canonicalize and verify the result lives
    /// *inside* the workspace. Returns the canonicalized absolute path
    /// the subprocess should use.
    ///
    /// `workspace_root` is expected to already be canonicalized — the
    /// bundle constructor does that once at boot.
    pub fn resolve_cwd(
        cwd: Option<&str>,
        workspace_root: &Path,
        fs: &dyn FsBackend,
    ) -> Result<PathBuf, String> {
        let raw = match cwd {
            None | Some("") => return Ok(workspace_root.to_path_buf()),
            Some(s) => s,
        };
        let candidate = if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            workspace_root.join(raw)
        };
        let canonical = fs.canonicalize(&candidate)?;
        if !path_is_within(&canonical, workspace_root) {
            return Err(format!(
                "cwd {} escapes workspace root {}",
                canonical.display(),
                workspace_root.display()
            ));
        }
        Ok(canonical)
    }

    /// For `read_file`: resolve the (relative or absolute) path, then
    /// canonicalize (which transparently follows symlinks) and verify
    /// the resolved target is inside the workspace.
    pub fn resolve_read_path(
        path: &str,
        workspace_root: &Path,
        fs: &dyn FsBackend,
    ) -> Result<PathBuf, String> {
        if path.is_empty() {
            return Err("path is empty".into());
        }
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            workspace_root.join(path)
        };
        let canonical = fs.canonicalize(&candidate)?;
        if !path_is_within(&canonical, workspace_root) {
            return Err(format!(
                "path {} escapes workspace root {}",
                canonical.display(),
                workspace_root.display()
            ));
        }
        Ok(canonical)
    }

    /// For `write_file`: canonicalize the *parent* (it must exist —
    /// we do NOT auto-create directories), confirm the parent is
    /// inside the workspace, and assemble `parent_canonical /
    /// filename`. If the destination already exists and is a symlink,
    /// reject — we refuse to silently overwrite a link to somewhere
    /// outside the workspace, even if the link target itself
    /// canonicalizes back inside.
    pub fn resolve_write_path(
        path: &str,
        workspace_root: &Path,
        fs: &dyn FsBackend,
    ) -> Result<PathBuf, String> {
        if path.is_empty() {
            return Err("path is empty".into());
        }
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            workspace_root.join(path)
        };
        let parent = candidate
            .parent()
            .ok_or_else(|| format!("no parent dir for {}", candidate.display()))?;
        let canonical_parent = fs.canonicalize(parent)?;
        if !path_is_within(&canonical_parent, workspace_root) {
            return Err(format!(
                "write target {} escapes workspace root {}",
                canonical_parent.display(),
                workspace_root.display()
            ));
        }
        let filename = candidate.file_name().ok_or_else(|| {
            format!(
                "write target {} has no filename component",
                candidate.display()
            )
        })?;
        let dest = canonical_parent.join(filename);
        match fs.symlink_kind(&dest)? {
            Some(FsKind::Symlink) => Err(format!(
                "refusing to overwrite symlink at {}",
                dest.display()
            )),
            _ => Ok(dest),
        }
    }

    /// Append the canonical truncation marker if the source string
    /// was capped. `kept` is the number of bytes the producer actually
    /// retained; `total` is the original byte count.
    pub fn truncate_with_marker(s: String, total: usize) -> String {
        if total <= s.len() {
            s
        } else {
            format!(
                "{s}\n... [output truncated, {kept} bytes shown of {total}] ...\n",
                kept = s.len()
            )
        }
    }

    /// Schema-friendly form of the whitelist (a JSON array of
    /// strings). Used by the `local.run_shell` schema's `cmd.enum`.
    pub fn cmd_enum_value() -> Value {
        Value::Array(
            SHELL_WHITELIST
                .iter()
                .map(|s| Value::String((*s).to_string()))
                .collect(),
        )
    }

    /// Build the scrubbed env handed to subprocesses. Only the
    /// `ENV_ALLOWLIST` keys present in the parent environment make it
    /// through; everything else (secrets) is dropped.
    pub fn env_allowlist() -> HashMap<String, String> {
        let mut out = HashMap::new();
        for &key in ENV_ALLOWLIST {
            if let Ok(val) = std::env::var(key) {
                out.insert(key.to_string(), val);
            }
        }
        out
    }

    /// Component-wise `starts_with` so we don't accept the well-known
    /// "/foo/bar123" beats "/foo/bar" string-prefix gotcha.
    pub fn path_is_within(child: &Path, parent: &Path) -> bool {
        let mut child_iter = child.components();
        let mut parent_iter = parent.components();
        loop {
            match (parent_iter.next(), child_iter.next()) {
                (None, _) => return true,
                (Some(_), None) => return false,
                (Some(p), Some(c)) => {
                    if p != c {
                        return false;
                    }
                }
            }
        }
    }
}

// ── Bundle + workspace-root resolution ──────────────────────────────────────

/// All four pieces the local-exec cluster needs at boot. Tests build
/// this with [`Self::with_mocks`]; production goes through
/// [`Self::from_app`] which reads the `watch_dir` setting and falls
/// back to a `git rev-parse --show-toplevel` of the app's CWD.
pub struct LocalExecBackends {
    pub workspace_root: PathBuf,
    pub shell: Arc<dyn ShellBackend>,
    pub fs: Arc<dyn FsBackend>,
    pub git: Arc<dyn GitBackend>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConstructError {
    #[error("no watch_dir setting and git fallback failed: {0}")]
    NoWorkspaceRoot(String),
    #[error("workspace root does not canonicalize: {0}")]
    Canonicalize(String),
}

impl LocalExecBackends {
    /// Production constructor. Resolution order for `workspace_root`:
    /// 1. Persisted `watch_dir` setting (set by the onboarding
    ///    `desktop_save_watch_dir` IPC command).
    /// 2. `git -C <process-cwd> rev-parse --show-toplevel`.
    /// 3. Fail with [`ConstructError::NoWorkspaceRoot`].
    ///
    /// Always canonicalizes the result so every later sandbox check
    /// can compare against a stable, fully-resolved path.
    pub fn from_app(app: tauri::AppHandle) -> Result<Self, ConstructError> {
        use tauri::Manager;
        let store = app.state::<Arc<crate::store::Store>>();
        let watch_dir = crate::store::settings::get(&store, "watch_dir")
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty());

        let raw_root = match watch_dir {
            Some(dir) => PathBuf::from(dir),
            None => git_toplevel_fallback()?,
        };
        let workspace_root = std::fs::canonicalize(&raw_root).map_err(|e| {
            ConstructError::Canonicalize(format!("{}: {e}", raw_root.display()))
        })?;

        Ok(Self {
            workspace_root,
            shell: Arc::new(TauriShellBackend::new()),
            fs: Arc::new(TauriFsBackend::new()),
            git: Arc::new(TauriGitBackend::new()),
        })
    }
}

fn git_toplevel_fallback() -> Result<PathBuf, ConstructError> {
    let cwd = std::env::current_dir()
        .map_err(|e| ConstructError::NoWorkspaceRoot(format!("current_dir: {e}")))?;
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| ConstructError::NoWorkspaceRoot(format!("spawn git: {e}")))?;
    if !output.status.success() {
        return Err(ConstructError::NoWorkspaceRoot(format!(
            "git rev-parse exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        return Err(ConstructError::NoWorkspaceRoot(
            "git rev-parse returned empty path".into(),
        ));
    }
    Ok(PathBuf::from(s))
}

// ── Tools ───────────────────────────────────────────────────────────────────

/// `local.run_shell` — spawn a whitelisted program with argv-only,
/// metacharacter-rejecting args, env scrubbed, cwd locked inside the
/// workspace, output capped, and a hard 30 s default timeout.
pub struct RunShellTool {
    meta: ToolMeta,
    workspace_root: PathBuf,
    shell: Arc<dyn ShellBackend>,
    fs: Arc<dyn FsBackend>,
}

impl RunShellTool {
    pub fn new(
        workspace_root: PathBuf,
        shell: Arc<dyn ShellBackend>,
        fs: Arc<dyn FsBackend>,
    ) -> Self {
        let schema = json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["cmd"],
            "properties": {
                "cmd": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Program to run. Must be on the hard-coded shell whitelist.",
                    "enum": sandbox::cmd_enum_value()
                },
                "args": {
                    "type": "array",
                    "default": [],
                    "items": { "type": "string" }
                },
                "cwd": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Working directory; must canonicalize to a descendant of the workspace root."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": sandbox::RUN_SHELL_MAX_TIMEOUT_MS as i64,
                    "description": "Subprocess timeout in milliseconds. Defaults to 30 seconds."
                }
            }
        });
        Self {
            meta: ToolMeta {
                name: "local.run_shell".into(),
                description: "Run a whitelisted dev tool (cargo, npm, git, …) with argv-only args inside the workspace. \
                              Metacharacters in args, paths in cmd, and cwds outside the workspace are rejected. \
                              stdout/stderr are capped at 1 MB; default timeout 30 s, max 5 min."
                    .into(),
                params_schema: schema,
                default_permission: PermissionLevel::Confirm,
            },
            workspace_root,
            shell,
            fs,
        }
    }
}

#[async_trait]
impl ChatTool for RunShellTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let cmd = invocation
            .args
            .get("cmd")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing cmd".into()))?
            .to_string();
        let args: Vec<String> = invocation
            .args
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|v| v.as_str().map(str::to_string))
                    .collect::<Option<Vec<_>>>()
            })
            .unwrap_or(Some(Vec::new()))
            .ok_or_else(|| ToolError::InvalidArgs("args must be an array of strings".into()))?;
        let cwd = invocation.args.get("cwd").and_then(Value::as_str);
        let timeout_ms = invocation
            .args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(sandbox::RUN_SHELL_DEFAULT_TIMEOUT_MS);

        sandbox::validate_program(&cmd).map_err(ToolError::ExecutionFailed)?;
        sandbox::validate_argv(&args).map_err(ToolError::ExecutionFailed)?;
        let resolved_cwd =
            sandbox::resolve_cwd(cwd, &self.workspace_root, &*self.fs)
                .map_err(ToolError::ExecutionFailed)?;

        let output = self
            .shell
            .run(&cmd, &args, &resolved_cwd, Duration::from_millis(timeout_ms))
            .await
            .map_err(ToolError::ExecutionFailed)?;

        Ok(shell_output_to_tool_output(
            output,
            format!(
                "{cmd}{}",
                if args.is_empty() {
                    String::new()
                } else {
                    format!(" {}", args.join(" "))
                }
            ),
        ))
    }
}

fn shell_output_to_tool_output(output: ShellOutput, label: String) -> ToolOutput {
    let stdout =
        sandbox::truncate_with_marker(output.stdout, output.stdout_total_bytes);
    let stderr =
        sandbox::truncate_with_marker(output.stderr, output.stderr_total_bytes);
    let exit_code = output.exit_code;
    let timed_out = output.timed_out;
    let summary = match exit_code {
        Some(0) => format!("{label}: ok"),
        Some(n) => format!("{label}: exit {n}"),
        None if timed_out => format!("{label}: timed out"),
        None => format!("{label}: killed"),
    };
    ToolOutput {
        value: json!({
            "ok": exit_code == Some(0),
            "exit_code": exit_code,
            "timed_out": timed_out,
            "stdout": stdout,
            "stderr": stderr,
            "stdout_total_bytes": output.stdout_total_bytes,
            "stderr_total_bytes": output.stderr_total_bytes,
        }),
        summary: Some(summary),
    }
}

/// `local.read_file` — read the bytes of a file inside the workspace.
/// 10 MB hard cap; symlink-followed-out-of-workspace fails because the
/// canonicalize step already resolves the target before we check
/// containment.
pub struct ReadFileTool {
    meta: ToolMeta,
    workspace_root: PathBuf,
    fs: Arc<dyn FsBackend>,
}

impl ReadFileTool {
    pub fn new(workspace_root: PathBuf, fs: Arc<dyn FsBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "local.read_file".into(),
                description: "Read a file inside the workspace. Returns UTF-8 text (lossy). \
                              Path is canonicalized; symlinks following outside the workspace are rejected."
                    .into(),
                params_schema: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["path"],
                    "properties": {
                        "path": { "type": "string", "minLength": 1 }
                    }
                }),
                default_permission: PermissionLevel::Auto,
            },
            workspace_root,
            fs,
        }
    }
}

#[async_trait]
impl ChatTool for ReadFileTool {
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

        let resolved =
            sandbox::resolve_read_path(&path, &self.workspace_root, &*self.fs)
                .map_err(ToolError::ExecutionFailed)?;
        let bytes = self
            .fs
            .read(&resolved)
            .map_err(ToolError::ExecutionFailed)?;
        if bytes.len() > sandbox::READ_FILE_MAX {
            return Err(ToolError::ExecutionFailed(format!(
                "file is {} bytes; refusing to read more than {} bytes",
                bytes.len(),
                sandbox::READ_FILE_MAX
            )));
        }
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let bytes_len = bytes.len();
        Ok(ToolOutput {
            value: json!({
                "ok": true,
                "path": resolved.to_string_lossy(),
                "bytes": bytes_len,
                "content": content,
            }),
            summary: Some(format!(
                "Read {} bytes from {}",
                bytes_len,
                resolved.display()
            )),
        })
    }
}

/// `local.write_file` — atomically replace a file inside the
/// workspace. Writes to a sibling tempfile + rename so a partial write
/// can never leave a corrupted destination on disk. Refuses to
/// overwrite a symlink and refuses to create missing parent
/// directories.
pub struct WriteFileTool {
    meta: ToolMeta,
    workspace_root: PathBuf,
    fs: Arc<dyn FsBackend>,
}

impl WriteFileTool {
    pub fn new(workspace_root: PathBuf, fs: Arc<dyn FsBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "local.write_file".into(),
                description: "Atomically write `content` to a file inside the workspace. \
                              Refuses to create parent directories and refuses to overwrite a symlink."
                    .into(),
                params_schema: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["path", "content"],
                    "properties": {
                        "path":    { "type": "string", "minLength": 1 },
                        "content": { "type": "string" }
                    }
                }),
                default_permission: PermissionLevel::Confirm,
            },
            workspace_root,
            fs,
        }
    }
}

#[async_trait]
impl ChatTool for WriteFileTool {
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
        let content = invocation
            .args
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing content".into()))?
            .to_string();

        let bytes = content.into_bytes();
        if bytes.len() > sandbox::WRITE_FILE_MAX {
            return Err(ToolError::ExecutionFailed(format!(
                "content is {} bytes; refusing to write more than {} bytes",
                bytes.len(),
                sandbox::WRITE_FILE_MAX
            )));
        }
        let resolved =
            sandbox::resolve_write_path(&path, &self.workspace_root, &*self.fs)
                .map_err(ToolError::ExecutionFailed)?;
        self.fs
            .write_atomic(&resolved, &bytes)
            .map_err(ToolError::ExecutionFailed)?;
        let bytes_len = bytes.len();
        Ok(ToolOutput {
            value: json!({
                "ok": true,
                "path": resolved.to_string_lossy(),
                "bytes": bytes_len,
            }),
            summary: Some(format!(
                "Wrote {} bytes to {}",
                bytes_len,
                resolved.display()
            )),
        })
    }
}

/// `local.run_test` — wrap `cargo test [<pattern>]` with cwd locked to
/// the workspace root and a 5-minute timeout. The optional positional
/// pattern is forbidden from containing `--` so the LLM can't smuggle
/// `cargo test -- --include-ignored` style escape vectors.
pub struct RunTestTool {
    meta: ToolMeta,
    workspace_root: PathBuf,
    shell: Arc<dyn ShellBackend>,
}

impl RunTestTool {
    pub fn new(workspace_root: PathBuf, shell: Arc<dyn ShellBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "local.run_test".into(),
                description: "Run `cargo test` at the workspace root, optionally filtered by a positional pattern."
                    .into(),
                params_schema: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Cargo test name filter, passed positionally to `cargo test`. May not contain `--`.",
                            "not": { "pattern": "--" }
                        }
                    }
                }),
                default_permission: PermissionLevel::Confirm,
            },
            workspace_root,
            shell,
        }
    }
}

#[async_trait]
impl ChatTool for RunTestTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let pattern = invocation
            .args
            .get("pattern")
            .and_then(Value::as_str)
            .map(str::to_string);

        let mut argv = vec!["test".to_string()];
        if let Some(ref p) = pattern {
            // Defence in depth — schema's `not.pattern` already
            // matches `--` anywhere in the string.
            if p.contains("--") {
                return Err(ToolError::ExecutionFailed(format!(
                    "pattern {p:?} contains forbidden `--`"
                )));
            }
            sandbox::validate_argv(std::slice::from_ref(p)).map_err(ToolError::ExecutionFailed)?;
            argv.push(p.clone());
        }

        let output = self
            .shell
            .run(
                "cargo",
                &argv,
                &self.workspace_root,
                Duration::from_millis(sandbox::RUN_TEST_TIMEOUT_MS),
            )
            .await
            .map_err(ToolError::ExecutionFailed)?;

        let label = match pattern {
            Some(p) => format!("cargo test {p}"),
            None => "cargo test".to_string(),
        };
        Ok(shell_output_to_tool_output(output, label))
    }
}

/// `local.git_status` — `git status --porcelain=v1`, cwd forced to the
/// workspace root. No caller-supplied args.
pub struct GitStatusTool {
    meta: ToolMeta,
    workspace_root: PathBuf,
    git: Arc<dyn GitBackend>,
}

impl GitStatusTool {
    pub fn new(workspace_root: PathBuf, git: Arc<dyn GitBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "local.git_status".into(),
                description: "Run `git status --porcelain=v1` at the workspace root.".into(),
                params_schema: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {}
                }),
                default_permission: PermissionLevel::Auto,
            },
            workspace_root,
            git,
        }
    }
}

#[async_trait]
impl ChatTool for GitStatusTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, _invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let output = self
            .git
            .status_porcelain(
                &self.workspace_root,
                Duration::from_millis(sandbox::GIT_TIMEOUT_MS),
            )
            .await
            .map_err(ToolError::ExecutionFailed)?;
        Ok(shell_output_to_tool_output(output, "git status".into()))
    }
}

/// `local.git_diff` — `git diff [--staged] [-- <path>]` at the
/// workspace root. The optional path filter is canonicalized and
/// verified inside the workspace before it ever touches `git`.
pub struct GitDiffTool {
    meta: ToolMeta,
    workspace_root: PathBuf,
    git: Arc<dyn GitBackend>,
    fs: Arc<dyn FsBackend>,
}

impl GitDiffTool {
    pub fn new(
        workspace_root: PathBuf,
        git: Arc<dyn GitBackend>,
        fs: Arc<dyn FsBackend>,
    ) -> Self {
        Self {
            meta: ToolMeta {
                name: "local.git_diff".into(),
                description: "Run `git diff` at the workspace root. Set `staged: true` for the index diff; \
                              optional `path` narrows the diff to a single workspace-relative path."
                    .into(),
                params_schema: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "staged": { "type": "boolean", "default": false },
                        "path":   { "type": "string", "minLength": 1 }
                    }
                }),
                default_permission: PermissionLevel::Auto,
            },
            workspace_root,
            git,
            fs,
        }
    }
}

#[async_trait]
impl ChatTool for GitDiffTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let staged = invocation
            .args
            .get("staged")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let path_arg = invocation.args.get("path").and_then(Value::as_str);

        let path_opt = match path_arg {
            None | Some("") => None,
            Some(p) => {
                let resolved =
                    sandbox::resolve_read_path(p, &self.workspace_root, &*self.fs)
                        .map_err(ToolError::ExecutionFailed)?;
                Some(resolved)
            }
        };

        let output = self
            .git
            .diff(
                &self.workspace_root,
                staged,
                path_opt.as_deref(),
                Duration::from_millis(sandbox::GIT_TIMEOUT_MS),
            )
            .await
            .map_err(ToolError::ExecutionFailed)?;

        let label = match (staged, &path_opt) {
            (true, Some(p)) => format!("git diff --staged -- {}", p.display()),
            (true, None) => "git diff --staged".to_string(),
            (false, Some(p)) => format!("git diff -- {}", p.display()),
            (false, None) => "git diff".to_string(),
        };
        Ok(shell_output_to_tool_output(output, label))
    }
}

// ── Register helper ─────────────────────────────────────────────────────────

/// Register the six `local.*` tools on `reg`. Errors propagate the
/// first [`RegistryError::DuplicateTool`] — by-design abort, matches
/// `register_desktop_os_tools`'s contract.
pub fn register_local_exec_tools(
    reg: &ToolRegistry,
    backends: LocalExecBackends,
) -> Result<(), RegistryError> {
    let LocalExecBackends {
        workspace_root,
        shell,
        fs,
        git,
    } = backends;

    reg.register(Arc::new(RunShellTool::new(
        workspace_root.clone(),
        shell.clone(),
        fs.clone(),
    )))?;
    reg.register(Arc::new(ReadFileTool::new(
        workspace_root.clone(),
        fs.clone(),
    )))?;
    reg.register(Arc::new(WriteFileTool::new(
        workspace_root.clone(),
        fs.clone(),
    )))?;
    reg.register(Arc::new(RunTestTool::new(
        workspace_root.clone(),
        shell,
    )))?;
    reg.register(Arc::new(GitStatusTool::new(
        workspace_root.clone(),
        git.clone(),
    )))?;
    reg.register(Arc::new(GitDiffTool::new(workspace_root, git, fs)))?;
    Ok(())
}

/// Pure-data catalog of every tool the cluster registers. Mirrors the
/// `ToolMeta` blocks in each `<Tool>::new()` so S11's settings UI +
/// audit log can enumerate metadata without instantiating the Tauri
/// backends. The
/// `catalog_local_exec_metas_match_registered_tools` integration test
/// (in `tests/agent_local_exec_tools.rs`) locks the invariant.
pub fn catalog() -> Vec<ToolMeta> {
    vec![
        ToolMeta {
            name: "local.run_shell".into(),
            description: "Run a whitelisted dev tool (cargo, npm, git, …) with argv-only args inside the workspace. \
                          Metacharacters in args, paths in cmd, and cwds outside the workspace are rejected. \
                          stdout/stderr are capped at 1 MB; default timeout 30 s, max 5 min."
                .into(),
            params_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["cmd"],
                "properties": {
                    "cmd": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Program to run. Must be on the hard-coded shell whitelist.",
                        "enum": sandbox::cmd_enum_value()
                    },
                    "args": {
                        "type": "array",
                        "default": [],
                        "items": { "type": "string" }
                    },
                    "cwd": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Working directory; must canonicalize to a descendant of the workspace root."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": sandbox::RUN_SHELL_MAX_TIMEOUT_MS as i64,
                        "description": "Subprocess timeout in milliseconds. Defaults to 30 seconds."
                    }
                }
            }),
            default_permission: PermissionLevel::Confirm,
        },
        ToolMeta {
            name: "local.read_file".into(),
            description: "Read a file inside the workspace. Returns UTF-8 text (lossy). \
                          Path is canonicalized; symlinks following outside the workspace are rejected."
                .into(),
            params_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path"],
                "properties": {
                    "path": { "type": "string", "minLength": 1 }
                }
            }),
            default_permission: PermissionLevel::Auto,
        },
        ToolMeta {
            name: "local.write_file".into(),
            description: "Atomically write `content` to a file inside the workspace. \
                          Refuses to create parent directories and refuses to overwrite a symlink."
                .into(),
            params_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "content"],
                "properties": {
                    "path":    { "type": "string", "minLength": 1 },
                    "content": { "type": "string" }
                }
            }),
            default_permission: PermissionLevel::Confirm,
        },
        ToolMeta {
            name: "local.run_test".into(),
            description: "Run `cargo test` at the workspace root, optionally filtered by a positional pattern."
                .into(),
            params_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "pattern": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Cargo test name filter, passed positionally to `cargo test`. May not contain `--`.",
                        "not": { "pattern": "--" }
                    }
                }
            }),
            default_permission: PermissionLevel::Confirm,
        },
        ToolMeta {
            name: "local.git_status".into(),
            description: "Run `git status --porcelain=v1` at the workspace root.".into(),
            params_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {}
            }),
            default_permission: PermissionLevel::Auto,
        },
        ToolMeta {
            name: "local.git_diff".into(),
            description: "Run `git diff` at the workspace root. Set `staged: true` for the index diff; \
                          optional `path` narrows the diff to a single workspace-relative path."
                .into(),
            params_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "staged": { "type": "boolean", "default": false },
                    "path":   { "type": "string", "minLength": 1 }
                }
            }),
            default_permission: PermissionLevel::Auto,
        },
    ]
}

// ── Mocks (gated) ───────────────────────────────────────────────────────────

#[cfg(any(test, feature = "agent-test-utils"))]
pub mod mocks {
    //! Test-only backend impls. **Not** compiled by `cargo build` of
    //! the bin / cdylib — gated on `cfg(test)` for unit tests and on
    //! the `agent-test-utils` Cargo feature for integration tests.
    //!
    //! These mocks deliberately ignore most of the sandbox guards
    //! (env scrub, real subprocesses, real filesystem). They exist to
    //! exercise the *tool layer*'s validation logic — anything the
    //! tool checks before calling a backend is what these tests
    //! defend.

    use super::*;
    use std::sync::Mutex;

    // ── MockShellBackend ────────────────────────────────────────────────────

    #[derive(Debug, Clone)]
    pub struct ShellCall {
        pub cmd: String,
        pub args: Vec<String>,
        pub cwd: PathBuf,
        pub timeout: Duration,
    }

    /// Configurable `ShellBackend`. `set_response()` queues the next
    /// reply; `fail_next()` queues a hard error.
    #[derive(Default)]
    pub struct MockShellBackend {
        inner: Mutex<MockShellState>,
    }

    #[derive(Default)]
    struct MockShellState {
        calls: Vec<ShellCall>,
        next_response: Option<ShellOutput>,
        next_error: Option<String>,
    }

    impl MockShellBackend {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn set_response(&self, output: ShellOutput) {
            self.inner.lock().unwrap().next_response = Some(output);
        }

        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }

        pub fn calls(&self) -> Vec<ShellCall> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl ShellBackend for MockShellBackend {
        async fn run(
            &self,
            cmd: &str,
            args: &[String],
            cwd: &Path,
            timeout: Duration,
        ) -> Result<ShellOutput, String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(ShellCall {
                cmd: cmd.to_string(),
                args: args.to_vec(),
                cwd: cwd.to_path_buf(),
                timeout,
            });
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            Ok(s.next_response.take().unwrap_or_default())
        }
    }

    // ── MockFsBackend ───────────────────────────────────────────────────────

    /// In-memory `FsBackend`. Tracks files (with bytes), dirs, and
    /// symlinks (with a target path) under explicit, caller-set paths.
    /// Canonicalize follows symlinks recursively (max 16 hops).
    #[derive(Default)]
    pub struct MockFsBackend {
        inner: Mutex<MockFsState>,
    }

    #[derive(Debug, Default)]
    struct MockFsState {
        entries: HashMap<PathBuf, MockFsEntry>,
        writes: Vec<(PathBuf, Vec<u8>)>,
    }

    #[derive(Debug, Clone)]
    enum MockFsEntry {
        File(Vec<u8>),
        Dir,
        Symlink(PathBuf),
    }

    impl MockFsBackend {
        pub fn new() -> Self {
            Self::default()
        }

        /// Mark `path` as a directory. Idempotent.
        pub fn add_dir(&self, path: impl Into<PathBuf>) {
            self.inner
                .lock()
                .unwrap()
                .entries
                .insert(path.into(), MockFsEntry::Dir);
        }

        /// Mark `path` as a regular file with given bytes.
        pub fn add_file(&self, path: impl Into<PathBuf>, content: impl Into<Vec<u8>>) {
            self.inner
                .lock()
                .unwrap()
                .entries
                .insert(path.into(), MockFsEntry::File(content.into()));
        }

        /// Mark `path` as a symlink whose target is `target`. The
        /// canonicalize routine will follow this when resolving
        /// `path`.
        pub fn add_symlink(&self, path: impl Into<PathBuf>, target: impl Into<PathBuf>) {
            self.inner
                .lock()
                .unwrap()
                .entries
                .insert(path.into(), MockFsEntry::Symlink(target.into()));
        }

        /// Snapshot of every `write_atomic` that landed.
        pub fn writes(&self) -> Vec<(PathBuf, Vec<u8>)> {
            self.inner.lock().unwrap().writes.clone()
        }
    }

    impl FsBackend for MockFsBackend {
        fn read(&self, path: &Path) -> Result<Vec<u8>, String> {
            let resolved = self.canonicalize(path)?;
            let s = self.inner.lock().unwrap();
            match s.entries.get(&resolved) {
                Some(MockFsEntry::File(b)) => Ok(b.clone()),
                Some(MockFsEntry::Dir) => Err(format!("is a directory: {}", resolved.display())),
                Some(MockFsEntry::Symlink(_)) => {
                    Err(format!("symlink loop: {}", resolved.display()))
                }
                None => Err(format!("not found: {}", resolved.display())),
            }
        }

        fn write_atomic(&self, path: &Path, content: &[u8]) -> Result<(), String> {
            let mut s = self.inner.lock().unwrap();
            s.writes.push((path.to_path_buf(), content.to_vec()));
            s.entries
                .insert(path.to_path_buf(), MockFsEntry::File(content.to_vec()));
            Ok(())
        }

        fn canonicalize(&self, path: &Path) -> Result<PathBuf, String> {
            let s = self.inner.lock().unwrap();
            let mut current = normalize_path(path);
            for _ in 0..16 {
                match s.entries.get(&current) {
                    Some(MockFsEntry::Symlink(target)) => {
                        current = if target.is_absolute() {
                            normalize_path(target)
                        } else {
                            let parent = current.parent().unwrap_or(Path::new(""));
                            normalize_path(&parent.join(target))
                        };
                    }
                    Some(_) => return Ok(current),
                    None => return Err(format!("not found: {}", current.display())),
                }
            }
            Err(format!("symlink loop at {}", current.display()))
        }

        fn symlink_kind(&self, path: &Path) -> Result<Option<FsKind>, String> {
            let normalized = normalize_path(path);
            let s = self.inner.lock().unwrap();
            Ok(s.entries.get(&normalized).map(|e| match e {
                MockFsEntry::File(_) => FsKind::File,
                MockFsEntry::Dir => FsKind::Dir,
                MockFsEntry::Symlink(_) => FsKind::Symlink,
            }))
        }
    }

    /// Lexical normalization for the mock — collapses `..` / `.`
    /// without touching disk. NOT a security primitive; production
    /// goes through `std::fs::canonicalize`.
    ///
    /// Rules:
    /// - `.` is dropped.
    /// - `..` after a normal segment pops it (`a/b/..` → `a`).
    /// - `..` after the root or a Windows drive prefix is a no-op
    ///   (`/..` stays at `/`, matching real filesystem behaviour).
    /// - `..` at the start of a relative path is preserved (we have
    ///   nothing to pop yet).
    fn normalize_path(p: &Path) -> PathBuf {
        use std::path::Component;
        let mut out: Vec<Component> = Vec::new();
        for comp in p.components() {
            match comp {
                Component::CurDir => {}
                Component::ParentDir => match out.last() {
                    Some(Component::Normal(_)) => {
                        out.pop();
                    }
                    Some(Component::RootDir) | Some(Component::Prefix(_)) => {
                        // `/..` collapses to `/`; matches the kernel.
                    }
                    Some(Component::ParentDir) | None => {
                        out.push(comp);
                    }
                    Some(Component::CurDir) => unreachable!("CurDir is dropped above"),
                },
                _ => out.push(comp),
            }
        }
        out.iter().collect()
    }

    // ── MockGitBackend ──────────────────────────────────────────────────────

    #[derive(Debug, Clone)]
    pub enum GitCall {
        Status {
            cwd: PathBuf,
            timeout: Duration,
        },
        Diff {
            cwd: PathBuf,
            staged: bool,
            path: Option<PathBuf>,
            timeout: Duration,
        },
    }

    #[derive(Default)]
    pub struct MockGitBackend {
        inner: Mutex<MockGitState>,
    }

    #[derive(Default)]
    struct MockGitState {
        calls: Vec<GitCall>,
        next_response: Option<ShellOutput>,
        next_error: Option<String>,
    }

    impl MockGitBackend {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn set_response(&self, output: ShellOutput) {
            self.inner.lock().unwrap().next_response = Some(output);
        }

        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }

        pub fn calls(&self) -> Vec<GitCall> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl GitBackend for MockGitBackend {
        async fn status_porcelain(
            &self,
            cwd: &Path,
            timeout: Duration,
        ) -> Result<ShellOutput, String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(GitCall::Status {
                cwd: cwd.to_path_buf(),
                timeout,
            });
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            Ok(s.next_response.take().unwrap_or_default())
        }

        async fn diff(
            &self,
            cwd: &Path,
            staged: bool,
            path: Option<&Path>,
            timeout: Duration,
        ) -> Result<ShellOutput, String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(GitCall::Diff {
                cwd: cwd.to_path_buf(),
                staged,
                path: path.map(Path::to_path_buf),
                timeout,
            });
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            Ok(s.next_response.take().unwrap_or_default())
        }
    }

    /// Convenience wrapper to build a `LocalExecBackends` from default
    /// mocks at `workspace_root`. The mock fs has `workspace_root`
    /// pre-registered as a directory so canonicalize succeeds on it.
    pub fn mock_backends(workspace_root: PathBuf) -> (
        LocalExecBackends,
        Arc<MockShellBackend>,
        Arc<MockFsBackend>,
        Arc<MockGitBackend>,
    ) {
        let shell = Arc::new(MockShellBackend::new());
        let fs = Arc::new(MockFsBackend::new());
        fs.add_dir(workspace_root.clone());
        let git = Arc::new(MockGitBackend::new());

        let bundle = LocalExecBackends {
            workspace_root,
            shell: shell.clone(),
            fs: fs.clone(),
            git: git.clone(),
        };
        (bundle, shell, fs, git)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::mocks::*;
    use super::*;

    fn invocation(name: &str, args: Value) -> ToolInvocation {
        ToolInvocation {
            id: "test-id".into(),
            tool_name: name.into(),
            args,
            session_id: None,
        }
    }

    fn ws_root() -> PathBuf {
        // Use a path-only workspace root; mock fs registers it as a
        // dir, no real filesystem needed.
        PathBuf::from("/ws/repo")
    }

    // ── sandbox helpers ─────────────────────────────────────────────────────

    #[test]
    fn validate_program_accepts_whitelisted_bare_name() {
        for prog in sandbox::SHELL_WHITELIST {
            assert!(sandbox::validate_program(prog).is_ok(), "rejected {prog}");
        }
    }

    #[test]
    fn validate_program_rejects_unknown_bare_name() {
        assert!(sandbox::validate_program("bash").is_err());
        assert!(sandbox::validate_program("sh").is_err());
        assert!(sandbox::validate_program("powershell").is_err());
    }

    #[test]
    fn validate_program_rejects_path_separator() {
        assert!(sandbox::validate_program("/bin/cargo").is_err());
        assert!(sandbox::validate_program("C:\\evil\\cargo.exe").is_err());
        assert!(sandbox::validate_program("..\\cargo").is_err());
    }

    #[test]
    fn validate_argv_rejects_metacharacters() {
        for bad in [
            ";", "|", "&", "`", ">", "<", "\n", "\r", "$(whoami)", "x$(y)",
        ] {
            let out = sandbox::validate_argv(&[bad.to_string()]);
            assert!(out.is_err(), "metacharacter {bad:?} should be rejected");
        }
    }

    #[test]
    fn validate_argv_passes_clean_args() {
        let args = vec![
            "test".into(),
            "--release".into(),
            "agent::tools::local_exec".into(),
        ];
        sandbox::validate_argv(&args).expect("clean argv should pass");
    }

    #[test]
    fn truncate_with_marker_appends_only_when_capped() {
        let s = "abc".to_string();
        assert_eq!(sandbox::truncate_with_marker(s.clone(), 3), "abc");
        let capped = sandbox::truncate_with_marker(s, 5);
        assert!(capped.contains("output truncated"));
        assert!(capped.contains("3 bytes shown of 5"));
    }

    #[test]
    fn path_is_within_uses_components_not_string_prefix() {
        assert!(sandbox::path_is_within(
            Path::new("/ws/repo/src/main.rs"),
            Path::new("/ws/repo")
        ));
        // The classic prefix gotcha: /ws/repo123 starts_with /ws/repo as a string
        // but is NOT inside it as a component-walk.
        assert!(!sandbox::path_is_within(
            Path::new("/ws/repo123/main.rs"),
            Path::new("/ws/repo")
        ));
        assert!(!sandbox::path_is_within(
            Path::new("/etc/passwd"),
            Path::new("/ws/repo")
        ));
    }

    // ── RunShellTool ────────────────────────────────────────────────────────

    #[test]
    fn run_shell_meta_is_confirm_with_whitelist_enum() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let tool = RunShellTool::new(bundle.workspace_root.clone(), bundle.shell, bundle.fs);
        assert_eq!(tool.meta().name, "local.run_shell");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
        let cmd_enum = &tool.meta().params_schema["properties"]["cmd"]["enum"];
        let arr = cmd_enum.as_array().expect("enum array");
        assert!(arr.iter().any(|v| v == "cargo"));
        assert!(arr.iter().any(|v| v == "git"));
        assert!(!arr.iter().any(|v| v == "bash"));
        assert!(!arr.iter().any(|v| v == "sh"));
    }

    #[tokio::test]
    async fn run_shell_forwards_to_backend_with_workspace_cwd() {
        let (bundle, shell, _fs, _git) = mock_backends(ws_root());
        shell.set_response(ShellOutput {
            stdout: "hello".into(),
            stderr: String::new(),
            exit_code: Some(0),
            timed_out: false,
            stdout_total_bytes: 5,
            stderr_total_bytes: 0,
        });
        let tool = RunShellTool::new(
            bundle.workspace_root.clone(),
            bundle.shell.clone(),
            bundle.fs,
        );
        let inv = invocation(
            "local.run_shell",
            json!({ "cmd": "cargo", "args": ["--version"] }),
        );
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["ok"], json!(true));
        assert_eq!(out.value["stdout"], json!("hello"));
        let calls = shell.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].cmd, "cargo");
        assert_eq!(calls[0].args, vec!["--version".to_string()]);
        assert_eq!(calls[0].cwd, ws_root());
    }

    #[tokio::test]
    async fn run_shell_rejects_metacharacter_argv() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let tool = RunShellTool::new(bundle.workspace_root.clone(), bundle.shell, bundle.fs);
        let inv = invocation(
            "local.run_shell",
            json!({ "cmd": "cargo", "args": ["test", ";"] }),
        );
        let err = tool.execute(&inv).await.expect_err("must reject");
        assert!(matches!(err, ToolError::ExecutionFailed(m) if m.contains("metacharacter")));
    }

    // ── ReadFileTool ────────────────────────────────────────────────────────

    #[test]
    fn read_file_meta_is_auto_default() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let tool = ReadFileTool::new(bundle.workspace_root, bundle.fs);
        assert_eq!(tool.meta().name, "local.read_file");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Auto);
    }

    #[tokio::test]
    async fn read_file_returns_bytes_for_workspace_path() {
        let (bundle, _shell, fs, _git) = mock_backends(ws_root());
        fs.add_file(ws_root().join("hello.txt"), b"hi".to_vec());
        let tool = ReadFileTool::new(bundle.workspace_root, bundle.fs);
        let inv = invocation("local.read_file", json!({ "path": "hello.txt" }));
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["content"], json!("hi"));
        assert_eq!(out.value["bytes"], json!(2));
    }

    #[tokio::test]
    async fn read_file_rejects_absolute_path_outside_workspace() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let tool = ReadFileTool::new(bundle.workspace_root, bundle.fs);
        let inv = invocation("local.read_file", json!({ "path": "/etc/passwd" }));
        let err = tool.execute(&inv).await.expect_err("must reject");
        assert!(matches!(err, ToolError::ExecutionFailed(_)));
    }

    // ── WriteFileTool ───────────────────────────────────────────────────────

    #[test]
    fn write_file_meta_is_confirm_default() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let tool = WriteFileTool::new(bundle.workspace_root, bundle.fs);
        assert_eq!(tool.meta().name, "local.write_file");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
    }

    #[tokio::test]
    async fn write_file_writes_bytes_into_workspace() {
        let (bundle, _shell, fs, _git) = mock_backends(ws_root());
        // The parent must exist for resolve_write_path to succeed —
        // workspace_root is added as a dir by mock_backends.
        let tool = WriteFileTool::new(bundle.workspace_root.clone(), bundle.fs);
        let inv = invocation(
            "local.write_file",
            json!({ "path": "hello.txt", "content": "hi" }),
        );
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["bytes"], json!(2));
        let writes = fs.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, ws_root().join("hello.txt"));
        assert_eq!(writes[0].1, b"hi");
    }

    // ── RunTestTool ─────────────────────────────────────────────────────────

    #[test]
    fn run_test_meta_is_confirm_default() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let tool = RunTestTool::new(bundle.workspace_root, bundle.shell);
        assert_eq!(tool.meta().name, "local.run_test");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
    }

    #[tokio::test]
    async fn run_test_passes_pattern_positionally() {
        let (bundle, shell, _fs, _git) = mock_backends(ws_root());
        shell.set_response(ShellOutput {
            stdout: "test result: ok".into(),
            stderr: String::new(),
            exit_code: Some(0),
            timed_out: false,
            stdout_total_bytes: 15,
            stderr_total_bytes: 0,
        });
        let tool = RunTestTool::new(bundle.workspace_root, bundle.shell.clone());
        let inv = invocation(
            "local.run_test",
            json!({ "pattern": "agent::tools::local_exec" }),
        );
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["ok"], json!(true));
        let calls = shell.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].cmd, "cargo");
        assert_eq!(
            calls[0].args,
            vec!["test".to_string(), "agent::tools::local_exec".to_string()]
        );
    }

    #[tokio::test]
    async fn run_test_rejects_double_dash_in_pattern() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let tool = RunTestTool::new(bundle.workspace_root, bundle.shell);
        let inv = invocation(
            "local.run_test",
            json!({ "pattern": "x -- --include-ignored" }),
        );
        let err = tool.execute(&inv).await.expect_err("must reject");
        assert!(matches!(err, ToolError::ExecutionFailed(m) if m.contains("--")));
    }

    // ── GitStatusTool / GitDiffTool ─────────────────────────────────────────

    #[test]
    fn git_status_and_diff_meta_are_auto() {
        let (bundle, _shell, _fs, _git) = mock_backends(ws_root());
        let status =
            GitStatusTool::new(bundle.workspace_root.clone(), bundle.git.clone());
        assert_eq!(status.meta().name, "local.git_status");
        assert_eq!(status.meta().default_permission, PermissionLevel::Auto);
        let diff = GitDiffTool::new(bundle.workspace_root, bundle.git, bundle.fs);
        assert_eq!(diff.meta().name, "local.git_diff");
        assert_eq!(diff.meta().default_permission, PermissionLevel::Auto);
    }

    #[tokio::test]
    async fn git_status_forces_workspace_cwd_and_returns_porcelain() {
        let (bundle, _shell, _fs, git) = mock_backends(ws_root());
        git.set_response(ShellOutput {
            stdout: " M README.md\n".into(),
            stderr: String::new(),
            exit_code: Some(0),
            timed_out: false,
            stdout_total_bytes: 13,
            stderr_total_bytes: 0,
        });
        let tool = GitStatusTool::new(bundle.workspace_root, bundle.git);
        let inv = invocation("local.git_status", json!({}));
        let out = tool.execute(&inv).await.expect("ok");
        assert_eq!(out.value["stdout"], json!(" M README.md\n"));
        match git.calls().first().expect("one call") {
            GitCall::Status { cwd, .. } => assert_eq!(cwd, &ws_root()),
            other => panic!("unexpected call: {other:?}"),
        }
    }

    #[tokio::test]
    async fn git_diff_forwards_staged_flag_and_path() {
        let (bundle, _shell, fs, git) = mock_backends(ws_root());
        fs.add_file(ws_root().join("src/main.rs"), b"// hi".to_vec());
        git.set_response(ShellOutput {
            stdout: "diff --git a b".into(),
            stderr: String::new(),
            exit_code: Some(0),
            timed_out: false,
            stdout_total_bytes: 14,
            stderr_total_bytes: 0,
        });
        let tool = GitDiffTool::new(bundle.workspace_root, bundle.git, bundle.fs);
        let inv = invocation(
            "local.git_diff",
            json!({ "staged": true, "path": "src/main.rs" }),
        );
        tool.execute(&inv).await.expect("ok");
        match git.calls().first().expect("one call") {
            GitCall::Diff {
                cwd,
                staged,
                path,
                ..
            } => {
                assert_eq!(cwd, &ws_root());
                assert!(*staged);
                assert_eq!(path, &Some(ws_root().join("src/main.rs")));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    // ── register_local_exec_tools ───────────────────────────────────────────

    #[test]
    fn register_local_exec_tools_inserts_six_distinct_names() {
        use crate::agent::{
            AuditLog, InMemoryReceiptSink, PermissionResolver, ToolRegistry, WitnessEmitter,
        };
        use r2d2_sqlite::SqliteConnectionManager;

        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .expect("pool");
        let audit = Arc::new(AuditLog::new(pool));
        audit.ensure_schema().expect("schema");
        let sink = Arc::new(InMemoryReceiptSink::new(8));
        let witness = Arc::new(WitnessEmitter::new(sink));
        let resolver = Arc::new(PermissionResolver::new());
        let reg = ToolRegistry::new(resolver, witness, audit);

        let (bundle, _s, _f, _g) = mock_backends(ws_root());
        register_local_exec_tools(&reg, bundle).expect("register");
        let metas = reg.list();
        assert_eq!(metas.len(), 6);
        let names: std::collections::HashSet<_> =
            metas.iter().map(|m| m.name.as_str()).collect();
        for expected in [
            "local.run_shell",
            "local.read_file",
            "local.write_file",
            "local.run_test",
            "local.git_status",
            "local.git_diff",
        ] {
            assert!(names.contains(expected), "missing tool {expected}");
        }
    }
}
