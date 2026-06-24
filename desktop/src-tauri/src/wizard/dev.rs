//! "Run dev now" + auto-inject test event for the Add-Project wizard.
//!
//! Spawns `npm run dev` in the user's repo and watches stdout for the
//! framework-specific "ready" line. As soon as we see one, we POST a
//! synthetic event tagged `_inariwatch_test: true` directly to the
//! capture webhook so the wizard's SSE listener can confirm the
//! pipeline is alive end-to-end.
//!
//! Per the locked decision (single test inject, no in-repo code), the
//! POST goes straight to `<api>/capture/<projectId>` with the freshly-
//! minted DSN as the bearer-style secret in the URL — no code runs in
//! the user's app, no SDK wiring depends on dev-server lifecycle.
//!
//! The dev process is left running after we inject — closing it is a
//! follow-up wizard step the user takes intentionally. We DO surface
//! the spawned PID via a Tauri event so a future "stop dev" button can
//! reach it.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command as AsyncCommand};

use crate::cloud::api::http_client;
use crate::store::{settings, Store};

use super::emit_progress;

/// Settings-store key for the keyring backup written in `install.rs`.
/// We read it back here to retrieve the just-minted DSN for the test
/// event POST. The plaintext lives in the OS settings store; if the
/// user revoked the device or wiped settings between mint and run,
/// the test event quietly skips with a graceful message.
const KEYRING_PROJECT_PREFIX: &str = "project-token-";

/// "Ready" markers we watch for in the dev process stdout. First match
/// wins. Each entry is a substring search so framework-specific noise
/// before / after doesn't matter.
const READY_MARKERS: &[&str] = &[
    "Ready in",        // Next.js 13+
    "ready in",        // Next.js 13+ lowercase
    "ready - started", // Next.js 12 / older
    "Local:",          // Vite, common dev-server line
    "Server running",  // Express common copy
    "listening on",    // Generic Node servers
];

/// IPC payload coming in from the React side.
#[derive(Debug, Clone, Deserialize)]
pub struct RunDevArgs {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "repoPath")]
    pub repo_path: PathBuf,
    /// Optional script name override. Defaults to `dev`.
    #[serde(default)]
    pub script: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunDevResult {
    pub pid: Option<u32>,
    pub injected: bool,
    pub note: Option<String>,
}

/// Spawn the dev server + auto-inject a test event once it's ready.
///
/// Lifetime: the dev process is intentionally moved into a detached
/// tokio task. The wizard does NOT track it long-term — closing the
/// dev server is the user's job (Ctrl+C in their terminal, or a future
/// "stop dev" button). We do, however, race the readiness wait against
/// a 60-second timeout so a misconfigured project doesn't hang the
/// wizard forever.
pub async fn run_dev_and_inject(
    app: &AppHandle,
    store: &Arc<Store>,
    args: RunDevArgs,
) -> Result<RunDevResult, String> {
    emit_progress(app, &args.project_id, "dev.spawn", "Starting npm run dev", Some(0.10));

    let script = args.script.unwrap_or_else(|| "dev".to_string());
    let mut child: Child = AsyncCommand::new(npm_executable())
        .arg("run")
        .arg(&script)
        .current_dir(&args.repo_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("npm run {} spawn: {}", script, e))?;

    let pid = child.id();
    emit_progress(app, &args.project_id, "dev.spawn",
        &format!("npm run {} pid={}", script, pid.unwrap_or(0)), Some(0.20));

    // Drain stdout with a parallel readiness watcher. We share a
    // ready-flag through tokio::sync::Notify so the moment any line
    // contains a marker, the inject path can fire.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let ready_notify = Arc::new(tokio::sync::Notify::new());

    if let Some(s) = stdout {
        let mut reader = BufReader::new(s).lines();
        let app2 = app.clone();
        let pid2 = args.project_id.clone();
        let notify = ready_notify.clone();
        tokio::spawn(async move {
            let mut announced = false;
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(&app2, &pid2, "dev.stdout", &line, None);
                if !announced && READY_MARKERS.iter().any(|m| line.contains(*m)) {
                    announced = true;
                    notify.notify_one();
                }
            }
        });
    }
    if let Some(s) = stderr {
        let mut reader = BufReader::new(s).lines();
        let app2 = app.clone();
        let pid2 = args.project_id.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(&app2, &pid2, "dev.stderr", &line, None);
            }
        });
    }

    // Wait for ready marker OR 60-second timeout. After timeout we
    // STILL fire the test event — some user setups (e.g. custom server
    // scripts) may not log a marker we recognise. The capture endpoint
    // doesn't care whether the dev server is up; the test event verifies
    // the cloud pipeline regardless.
    let wait = tokio::time::timeout(Duration::from_secs(60), ready_notify.notified()).await;
    let timed_out = wait.is_err();

    emit_progress(app, &args.project_id, "dev.ready",
        if timed_out { "60s timeout — firing test event anyway" } else { "Dev server ready" },
        Some(0.55));

    // Detach the child so it keeps running after this function returns.
    // tokio::process::Child's drop normally kills the child — we need
    // it alive so the user can keep poking the dev server. Spawning a
    // task that holds the handle without awaiting prevents the drop.
    tokio::spawn(async move {
        // Keep child alive until app shutdown — we never call .wait()
        // here so the child isn't reaped. Tokio runtime owns the
        // descriptor; OS reaps it when the process exits naturally.
        let _ = child;
        // Hold the future open for a long time. We're not awaiting
        // anything important — just keeping the Child handle in scope.
        tokio::time::sleep(Duration::from_secs(60 * 60 * 24)).await;
    });

    // Inject the test event.
    emit_progress(app, &args.project_id, "dev.test_event", "Injecting test event", Some(0.75));
    let inject = inject_test_event(store, &args.project_id).await;
    match inject {
        Ok(()) => {
            emit_progress(app, &args.project_id, "dev.test_event_acked",
                "Test event accepted by capture pipeline", Some(0.95));
            Ok(RunDevResult { pid, injected: true, note: None })
        }
        Err(e) => {
            emit_progress(app, &args.project_id, "dev.test_event_failed",
                &format!("Test event POST failed: {}", e), Some(0.95));
            Ok(RunDevResult { pid, injected: false, note: Some(e) })
        }
    }
}

/// Standalone manual-trigger variant for the wizard's "Inject test
/// event" button. Skips the dev-server spawn and just hits the webhook.
pub async fn inject_test_event_manual(
    app: &AppHandle,
    store: &Arc<Store>,
    project_id: &str,
) -> Result<(), String> {
    emit_progress(app, project_id, "dev.test_event", "Injecting test event", Some(0.50));
    inject_test_event(store, project_id).await?;
    emit_progress(app, project_id, "dev.test_event_acked",
        "Test event accepted by capture pipeline", Some(1.0));
    Ok(())
}

async fn inject_test_event(store: &Arc<Store>, project_id: &str) -> Result<(), String> {
    let backup_key = format!("{}{}", KEYRING_PROJECT_PREFIX, project_id);
    let plaintext = settings::get(store, &backup_key)
        .map_err(|e| format!("read keyring backup: {}", e))?
        .ok_or_else(|| "no project token backup found — run install first".to_string())?;

    let api_url = settings::get(store, "dashboard_url")
        .ok()
        .flatten()
        .unwrap_or_else(|| crate::cloud::api::DEFAULT_API_URL.to_string());
    let api_url = api_url.trim_end_matches('/');

    // Capture webhook accepts the secret as a Bearer header. The body
    // must be valid JSON the SDK would have produced — we mimic the
    // shape (`fingerprint`, `title`, `severity`, `_inariwatch_test`)
    // so the wizard-test-event branch in route.ts triggers cleanly.
    let body = serde_json::json!({
        "fingerprint": format!("iwk-wizard-test:{}", project_id),
        "title": "InariWatch wizard test event",
        "body": "Synthetic event injected by Inari Live's Add-Project wizard.",
        "severity": "info",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "environment": "wizard-test",
        "_inariwatch_test": true,
    });

    let url = format!("{}/capture/{}", api_url, urlencoding::encode(project_id));
    let res = http_client()
        .post(&url)
        .bearer_auth(&plaintext)
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(15))
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("test event POST: {}", e))?;
    let status = res.status();
    if !status.is_success() {
        let body_txt = res.text().await.unwrap_or_default();
        return Err(format!("test event POST returned {}: {}", status, body_txt.chars().take(200).collect::<String>()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn npm_executable() -> &'static str { "npm.cmd" }
#[cfg(not(target_os = "windows"))]
fn npm_executable() -> &'static str { "npm" }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_markers_match_canonical_lines() {
        // These are the lines we observed on next/vite/express in the wild.
        let lines = [
            "▲ Next.js 15.1.0",
            "  Local:        http://localhost:3000",
            "  ✓ Ready in 432ms",
            "express: Server running on port 3000",
            "vite v5.0.0  ready in 211 ms",
            "  ➜  Local:   http://localhost:5173/",
            "Listening on http://localhost:8080",
        ];
        for line in lines {
            assert!(
                READY_MARKERS.iter().any(|m| line.contains(*m)),
                "no marker matched: {}", line,
            );
        }
    }
}
