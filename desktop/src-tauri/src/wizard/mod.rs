//! Inari Live V1 — Session 3 Add-Project wizard.
//!
//! When the user clicks "Add Project" on web, the relay routes a
//! `project.wizard.open` task to this desktop install. The arm in
//! `crate::relay_client::handle_dispatch_full` calls
//! [`WizardStore::set_pending`] with the payload, which:
//!   1. persists the wizard request in-memory so a slow webview boot
//!      doesn't drop it,
//!   2. emits a `wizard:opened` Tauri event the React side picks up to
//!      auto-render `AddProjectWizard`.
//!
//! From there the IPC commands in `crate::ipc::wizard` drive the
//! pipeline:
//!
//!   wizard_get_pending   → returns the queued payload (called on
//!                          mount + window-focus).
//!   wizard_detect_clone  → scans `~/code` etc. for a matching repo.
//!   wizard_run_install   → npm install + config patch + .env.local +
//!                          mint token via web → sync to Vercel via web →
//!                          backup plaintext to keyring.
//!   wizard_run_dev       → spawn `npm run dev` in the repo + auto-
//!                          inject the test event once the server is
//!                          ready.
//!   wizard_dismiss       → clears the pending payload.
//!
//! Per the locked decision tree (see `INARI_LIVE_V1_PLAN.md` →
//! "Add Project flow") the wizard MUST NOT touch git: no commits, no
//! pushes, no PRs. The user's working tree stays dirty after the
//! install — they decide when to ship.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub mod detect;
pub mod dev;
pub mod install;

/// Payload the web router sends with `project.wizard.open`. Mirrors
/// `web/lib/relay/wizard-events.ts::WizardOpenPayload`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WizardPayload {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "projectSlug")]
    pub project_slug: String,
    #[serde(rename = "repoFullName")]
    pub repo_full_name: String,
    #[serde(default)]
    pub framework: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Detection result returned from `wizard_detect_clone`.
#[derive(Debug, Clone, Serialize)]
pub struct DetectionResult {
    /// Absolute path of the matched local clone, or null when no
    /// match was found in any of the configured search directories.
    pub path: Option<PathBuf>,
    /// Detected framework hint from the matched clone's package.json
    /// (Cargo.toml etc. fall back to `node`). Null when nothing
    /// matched. Mirrors the web-side enum: next / express / vite /
    /// node.
    pub framework: Option<String>,
    /// Detected host hint from file markers in the clone
    /// (`vercel.json`, `.vercel/project.json`, etc). Null when no
    /// host is detectable; the wizard treats null as "Tier 3 manual"
    /// and shows snippet copy.
    pub host: Option<String>,
}

/// Tauri event channel the React side listens on. Defined here so
/// callers don't drift on the string.
pub const EVT_WIZARD_OPENED: &str = "wizard:opened";
pub const EVT_WIZARD_PROGRESS: &str = "wizard:progress";

/// Per-wizard install/run progress event. Pushed via Tauri so the
/// React side can render a live log without a polling IPC.
#[derive(Debug, Clone, Serialize)]
pub struct WizardProgress {
    #[serde(rename = "projectId")]
    pub project_id: String,
    /// `install.npm`, `install.patch_config`, `install.env_local`,
    /// `install.mint_token`, `install.sync_vercel`, `install.keyring`,
    /// `dev.spawn`, `dev.ready`, `dev.test_event`,
    /// `dev.test_event_acked`, or `error`.
    pub stage: String,
    /// Human-readable line for the wizard's log tail. Capped at 280
    /// chars on emit so a malicious or runaway tool can't blow up
    /// the IPC payload.
    pub message: String,
    /// 0.0..=1.0 — null when the stage is not progress-bound.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f32>,
}

/// In-memory pending-wizard state. Survives a webview reload but
/// resets on app restart (which is fine — the user re-opens from web
/// in that case). Wrapped in a Mutex so the relay-dispatch thread
/// can write while the IPC read commands fire concurrently.
#[derive(Debug, Default)]
pub struct WizardStore {
    inner: Mutex<Option<WizardPayload>>,
}

impl WizardStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(None),
        })
    }

    /// Replace any current pending payload + emit `wizard:opened`. The
    /// frontend treats the second emit as a "switch to this project"
    /// — we do NOT queue, since users can only run one wizard at a
    /// time.
    pub fn set_pending(&self, app: &AppHandle, payload: WizardPayload) {
        if let Ok(mut g) = self.inner.lock() {
            *g = Some(payload.clone());
        }
        // Best-effort emit. A stale webview that hasn't subscribed yet
        // calls `wizard_get_pending` on mount and picks up the payload
        // from the lock.
        let _ = app.emit(EVT_WIZARD_OPENED, &payload);
    }

    /// Read the current pending payload without consuming it. The
    /// React side calls this from `AddProjectWizard` mount so a webview
    /// that booted AFTER the dispatch arrived still sees the payload.
    pub fn pending(&self) -> Option<WizardPayload> {
        self.inner.lock().ok().and_then(|g| g.clone())
    }

    /// Drop the current pending payload. Called when the user clicks
    /// "Done" or "Dismiss" in the wizard. Idempotent.
    pub fn clear(&self) {
        if let Ok(mut g) = self.inner.lock() {
            *g = None;
        }
    }
}

/// Helper: emit a progress event with the message capped to 280 chars
/// so a runaway log line can't blow up the IPC. Returns the same
/// `Result` shape as `Emitter::emit` for callers that want to log
/// failures (we currently log-and-continue everywhere).
pub fn emit_progress(app: &AppHandle, project_id: &str, stage: &str, message: &str, fraction: Option<f32>) {
    let trimmed: String = message.chars().take(280).collect();
    let evt = WizardProgress {
        project_id: project_id.to_string(),
        stage: stage.to_string(),
        message: trimmed,
        fraction,
    };
    if let Err(e) = app.emit(EVT_WIZARD_PROGRESS, &evt) {
        tracing::warn!(error = %e, "wizard:progress emit failed");
    }
}
