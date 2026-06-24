// Spawn the user's `npm run <script>` with bundled `@inariwatch/capture`
// preloaded via `--import` (Node ≥20.6) or `--require` (older Node).
//
// EXTRACTED from `src/connect.rs` (pre-Session-2 scaffold). The Tauri
// command shells live in [`crate::ipc::connect`]; this module is the
// impl. Session 10's substrate sensor extends [`spawn_with_imports`] by
// adding `--import @inariwatch/substrate-agent/auto`. Session A wraps
// the same primitive in a standalone binary.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const INGEST_DSN: &str = "http://127.0.0.1:9111/ingest";

#[derive(Default)]
pub struct ConnectState {
    /// At most one spawned dev server. A second connect kills the prior.
    child: Mutex<Option<Child>>,
    /// PID of the live child for the dock to display. 0 = nothing running.
    pid:   AtomicU32,
}

impl ConnectState {
    pub fn pid(&self) -> u32 {
        self.pid.load(Ordering::Acquire)
    }
}

#[derive(Deserialize)]
pub struct ConnectArgs {
    pub folder_path: String,
    /// Optional override of the script to run, e.g. "dev" or "start". When
    /// absent we auto-pick from package.json (`dev` → `start` → `serve`).
    #[serde(default)]
    pub script:      Option<String>,
}

#[derive(Serialize)]
pub struct ConnectResult {
    pub ok:        bool,
    pub framework: String,
    pub script:    String,
    pub pid:       u32,
    pub message:   String,
}

/// Spawn the user's dev server with `@inariwatch/capture` preloaded.
/// Returns metadata the IPC caller forwards to the webview.
pub async fn connect_project(
    app:   &AppHandle,
    state: &Arc<ConnectState>,
    args:  ConnectArgs,
) -> Result<ConnectResult, String> {
    let folder = PathBuf::from(args.folder_path.trim());
    if !folder.is_dir() {
        return Err(format!("not a directory: {}", folder.display()));
    }
    let pkg_path = folder.join("package.json");
    if !pkg_path.exists() {
        return Err("no package.json — point at the root of a Node project".to_string());
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir lookup failed: {e}"))?;
    let capture_dir = resource_dir.join("sdk-bundle").join("capture");
    let capture_auto_esm = capture_dir.join("auto.js");
    let capture_auto_cjs = capture_dir.join("auto.cjs");
    if !capture_auto_esm.exists() {
        return Err(format!(
            "bundled capture missing — expected at {}. Run `npm run bundle-sdk` and rebuild.",
            capture_auto_esm.display()
        ));
    }

    let use_import = node_supports_import().await.unwrap_or(true);
    let capture_auto = if use_import { &capture_auto_esm } else { &capture_auto_cjs };

    let pkg_text = std::fs::read_to_string(&pkg_path)
        .map_err(|e| format!("read package.json: {e}"))?;
    let pkg: Value = serde_json::from_str(&pkg_text)
        .map_err(|e| format!("parse package.json: {e}"))?;
    let framework = detect_framework(&pkg);
    let script = args
        .script
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| pick_dev_script(&pkg));

    {
        let mut lock = state.child.lock().await;
        if let Some(mut prior) = lock.take() {
            let _ = prior.start_kill();
        }
    }

    let auto_url = path_to_file_url(capture_auto);
    let node_opts = if use_import {
        format!("--import {auto_url}")
    } else {
        format!("--require {}", capture_auto.display())
    };

    let mut cmd = make_npm_command(&script);
    cmd.current_dir(&folder)
        .env("NODE_OPTIONS",     &node_opts)
        .env("INARIWATCH_DSN",   INGEST_DSN)
        .env("INARIWATCH_DEBUG", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn `{script}`: {e} (is npm on PATH?)"))?;
    let pid = child.id().unwrap_or(0);
    state.pid.store(pid, Ordering::Release);

    pump_stream(child.stdout.take(), app.clone(), "stdout");
    pump_stream(child.stderr.take(), app.clone(), "stderr");

    {
        let mut lock = state.child.lock().await;
        *lock = Some(child);
    }

    let _ = app.emit(
        "inari:connect-status",
        serde_json::json!({
            "connected": true,
            "framework": framework,
            "script":    script,
            "folder":    folder.display().to_string(),
            "pid":       pid,
        }),
    );

    Ok(ConnectResult {
        ok:        true,
        framework: framework.to_string(),
        script:    script.clone(),
        pid,
        message:   format!("running `npm run {script}` in {} with capture injected", folder.display()),
    })
}

pub async fn disconnect_project(
    app:   &AppHandle,
    state: &Arc<ConnectState>,
) -> Result<(), String> {
    let mut lock = state.child.lock().await;
    if let Some(mut prior) = lock.take() {
        let _ = prior.start_kill();
    }
    state.pid.store(0, Ordering::Release);
    let _ = app.emit(
        "inari:connect-status",
        serde_json::json!({ "connected": false }),
    );
    Ok(())
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn pump_stream<R>(stream: Option<R>, app: AppHandle, label: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let Some(stream) = stream else { return };
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit(
                "inari:live-log",
                serde_json::json!({ "stream": label, "line": line }),
            );
        }
    });
}

fn detect_framework(pkg: &Value) -> &'static str {
    let has = |k: &str| -> bool {
        let in_deps = pkg
            .get("dependencies")
            .and_then(|d| d.get(k))
            .is_some();
        let in_dev = pkg
            .get("devDependencies")
            .and_then(|d| d.get(k))
            .is_some();
        in_deps || in_dev
    };
    if has("next")              { return "next"; }
    if has("nuxt")              { return "nuxt"; }
    if has("@remix-run/dev")    { return "remix"; }
    if has("@sveltejs/kit")     { return "sveltekit"; }
    if has("astro")             { return "astro"; }
    if has("vite")              { return "vite"; }
    if has("@nestjs/core")      { return "nestjs"; }
    if has("express")           { return "express"; }
    if has("fastify")           { return "fastify"; }
    if has("koa")               { return "koa"; }
    if has("hono")              { return "hono"; }
    "node"
}

fn pick_dev_script(pkg: &Value) -> String {
    let scripts = pkg.get("scripts").and_then(|s| s.as_object());
    let has = |k: &str| scripts.map(|s| s.contains_key(k)).unwrap_or(false);
    if      has("dev")    { "dev".into() }
    else if has("start")  { "start".into() }
    else if has("serve")  { "serve".into() }
    else                  { "start".into() }
}

fn make_npm_command(script: &str) -> Command {
    if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "npm", "run", script]);
        c
    } else {
        let mut c = Command::new("npm");
        c.args(["run", script]);
        c
    }
}

fn path_to_file_url(p: &Path) -> String {
    let normalized = p.to_string_lossy().replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

async fn node_supports_import() -> Option<bool> {
    let out = Command::new(if cfg!(windows) { "node.exe" } else { "node" })
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !out.status.success() { return None; }
    let raw = String::from_utf8(out.stdout).ok()?;
    let raw = raw.trim().trim_start_matches('v');
    let mut parts = raw.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(major > 20 || (major == 20 && minor >= 6))
}

// ── Sesión 10: `inari run <script>` ─────────────────────────────────
//
// Invoked from the CLI binary surface (Sesión A wires the parser).
// Runs the user's existing `npm run <script>` with `NODE_OPTIONS`
// injecting `--import @inariwatch/capture/auto` +
// `--import @inariwatch/substrate-agent`. The `--import` flags only
// fire on Node ≥ 20.6; on older Node we fall back to `--require`
// against the same packages.
//
// Why NODE_OPTIONS and not direct `node --import …`: the user's
// `scripts.dev` may be `next dev` / `tsx server.ts` / `vite` etc, none
// of which are runnable as `node <file>`. NODE_OPTIONS gets inherited
// by every Node subprocess npm spawns, so the imports propagate
// without us having to rewrite the script. See `wrapper::compose_wrapped_dev`
// for the same compromise on the package-json-mutating path.
//
// Both packages MUST exist in the user's `node_modules/` for `--import`
// to resolve; this module makes no attempt to install them. The dock
// (Sesión 17) shows an "install @inariwatch/substrate-agent" prompt
// when the toggle is flipped on a repo that lacks it.

/// Plan captured for the `inari run` invocation. Public so integration
/// tests can assert the composed command surface without spawning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InariRunPlan {
    /// Process to spawn. On Windows we route through `cmd /C` because
    /// `npm` is a `.cmd` shim (same as `connect_project`).
    pub program:  String,
    /// Argv to pass to `program`.
    pub args:     Vec<String>,
    /// Resolved `cwd` (the user's repo root).
    pub cwd:      PathBuf,
    /// Env vars to set on the child. Currently a single
    /// `NODE_OPTIONS` entry.
    pub env:      Vec<(String, String)>,
    /// Script name resolved from `package.json` (`dev` by default).
    pub script:   String,
}

/// Compose an [`InariRunPlan`] without spawning. Public for tests +
/// for the dock so it can render a "what will run" preview before
/// the user clicks.
pub fn prepare_inari_run(repo: &Path, script_override: Option<&str>) -> Result<InariRunPlan, String> {
    if !repo.is_dir() {
        return Err(format!("not a directory: {}", repo.display()));
    }
    let pkg_path = repo.join("package.json");
    if !pkg_path.exists() {
        return Err("no package.json — point at the root of a Node project".to_string());
    }
    let pkg_text = std::fs::read_to_string(&pkg_path)
        .map_err(|e| format!("read package.json: {e}"))?;
    let pkg: Value = serde_json::from_str(&pkg_text)
        .map_err(|e| format!("parse package.json: {e}"))?;

    // Pick the script: explicit override wins, else first match in
    // dev → start → serve.
    let script = match script_override {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => pick_dev_script(&pkg),
    };
    // Confirm the script actually exists. The dock surfaces this to
    // the user as "no `<script>` script — pick another".
    let scripts = pkg.get("scripts").and_then(|s| s.as_object());
    let script_known = scripts.map(|s| s.contains_key(&script)).unwrap_or(false);
    if !script_known {
        return Err(format!("package.json has no scripts.{script}"));
    }

    let node_options = compose_node_options();

    // npm command shape — same routing connect_project uses, kept in
    // step on purpose.
    let (program, args) = if cfg!(windows) {
        (
            "cmd".to_string(),
            vec!["/C".to_string(), "npm".to_string(), "run".to_string(), script.clone()],
        )
    } else {
        (
            "npm".to_string(),
            vec!["run".to_string(), script.clone()],
        )
    };

    Ok(InariRunPlan {
        program,
        args,
        cwd: repo.to_path_buf(),
        env: vec![("NODE_OPTIONS".to_string(), node_options)],
        script,
    })
}

/// Compose the `NODE_OPTIONS` value the wrapper + CLI both share.
/// Returns the bare value (no key=) — callers set the key themselves
/// via `cmd.env(...)` / wrapper string formatting.
pub fn compose_node_options() -> String {
    "--import @inariwatch/capture/auto --import @inariwatch/substrate-agent".to_string()
}

/// Spawn the plan and return the child handle. The child inherits the
/// current process's stdin/stdout/stderr so the user sees real dev
/// server output. Production CLI surface; tests use [`prepare_inari_run`].
pub fn spawn_inari_run(plan: &InariRunPlan) -> std::io::Result<std::process::Child> {
    let mut cmd = std::process::Command::new(&plan.program);
    cmd.args(&plan.args);
    cmd.current_dir(&plan.cwd);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::inherit());
    cmd.stdout(std::process::Stdio::inherit());
    cmd.stderr(std::process::Stdio::inherit());
    cmd.spawn()
}
