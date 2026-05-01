//! llama.cpp sidecar lifecycle.
//!
//! Each loaded model runs in its own `llama-server` subprocess
//! bound to a localhost port. The [`RuntimeManager`] tracks the
//! mapping `model_id → endpoint`, spawns processes on demand, and
//! kills them on drop.
//!
//! ## Sidecar binary resolution
//!
//! Looked up in this order:
//! 1. `<app_resource_dir>/llama-server-{platform}` — bundled by
//!    `tauri.conf.json::bundle.resources` (S31 ships these binaries
//!    cross-platform; in S21 they're not yet vendored).
//! 2. `<app_local_data>/inari-live/bin/llama-server[.exe]` — sideloaded
//!    by power users.
//! 3. `llama-server` on `$PATH` — for developers running from source.
//!
//! If none resolves, [`RuntimeError::SidecarMissing`] is returned. The
//! dock surfaces this as "llama.cpp not bundled in this build".
//!
//! ## Tests
//!
//! Production callers go through [`spawn_sidecar`]. Tests instead call
//! [`RuntimeManager::register_external_endpoint`] to point a model id
//! at an in-process axum mock server — no subprocess, no
//! cross-platform binary needed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("llama-server binary not found (checked resources, app data, PATH)")]
    SidecarMissing,
    #[error("model {model_id} not loaded; call ensure_loaded first")]
    ModelNotLoaded { model_id: String },
    #[error("sidecar failed health check after {timeout_ms} ms")]
    HealthTimeout { timeout_ms: u64 },
    #[error("sidecar spawn failed: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("sidecar HTTP error: {0}")]
    Http(#[from] reqwest::Error),
}

/// Endpoint a model is reachable at. Held by the manager + handed to
/// `LocalAI::generate` for the actual completion call.
#[derive(Debug, Clone)]
pub struct ModelEndpoint {
    /// Base URL — e.g. `http://127.0.0.1:39871` (no trailing slash).
    pub base_url: String,
}

/// Per-model state. `Sidecar` rows own a child process; `External`
/// rows just hold the URL the test (or future remote llama-server)
/// supplied.
enum LoadedModel {
    Sidecar {
        endpoint: ModelEndpoint,
        // Held so Drop kills the process. Wrapped in Mutex because
        // tokio::process::Child's `kill()` takes &mut self.
        child:    Mutex<tokio::process::Child>,
    },
    External {
        endpoint: ModelEndpoint,
    },
}

impl LoadedModel {
    fn endpoint(&self) -> &ModelEndpoint {
        match self {
            LoadedModel::Sidecar { endpoint, .. }  => endpoint,
            LoadedModel::External { endpoint, .. } => endpoint,
        }
    }
}

/// Runtime manager. Cloneable + cheap (Arc internally). All state
/// lives behind a `RwLock` keyed on model_id.
#[derive(Clone)]
pub struct RuntimeManager {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    loaded:        RwLock<HashMap<String, Arc<LoadedModel>>>,
    sidecar_paths: SidecarPaths,
    http:          reqwest::Client,
}

/// Where the runtime looks for the `llama-server` binary. Production
/// builds resolve this from `AppHandle`; tests can leave both fields
/// `None` because they never spawn.
#[derive(Debug, Clone, Default)]
pub struct SidecarPaths {
    pub resource_dir:   Option<PathBuf>,
    pub app_local_data: Option<PathBuf>,
}

impl RuntimeManager {
    /// Construct a manager. `paths` is what [`spawn_sidecar`] uses to
    /// resolve the binary; [`register_external_endpoint`] doesn't
    /// touch it.
    pub fn new(paths: SidecarPaths) -> Self {
        let http = reqwest::Client::builder()
            // Health checks should be near-instant. Anything past
            // 2s means the sidecar is wedged.
            .timeout(Duration::from_secs(2))
            .build()
            .expect("reqwest client builds");
        Self {
            inner: Arc::new(RuntimeInner {
                loaded: RwLock::new(HashMap::new()),
                sidecar_paths: paths,
                http,
            }),
        }
    }

    /// Look up the endpoint for an already-loaded model.
    pub async fn endpoint_for(&self, model_id: &str) -> Result<ModelEndpoint, RuntimeError> {
        let loaded = self.inner.loaded.read().await;
        loaded.get(model_id)
            .map(|m| m.endpoint().clone())
            .ok_or_else(|| RuntimeError::ModelNotLoaded { model_id: model_id.to_string() })
    }

    /// True if the model is currently loaded (sidecar running OR an
    /// external endpoint is registered).
    pub async fn is_loaded(&self, model_id: &str) -> bool {
        self.inner.loaded.read().await.contains_key(model_id)
    }

    /// Test/IPC seam: pin an arbitrary base URL as the endpoint for
    /// `model_id`. Skips subprocess spawning entirely.
    pub async fn register_external_endpoint(&self, model_id: impl Into<String>, base_url: impl Into<String>) {
        let model_id = model_id.into();
        let endpoint = ModelEndpoint { base_url: base_url.into() };
        let mut loaded = self.inner.loaded.write().await;
        loaded.insert(model_id, Arc::new(LoadedModel::External { endpoint }));
    }

    /// Production sidecar spawn. Resolves the binary, picks a free
    /// localhost port, launches `llama-server -m <gguf> --port <p>
    /// --host 127.0.0.1 -ngl <auto>`, polls `/health` until it goes
    /// 200 or the timeout trips.
    ///
    /// `gguf_path` is the verified GGUF file path (from
    /// [`crate::local_ai::registry::ModelRegistry::ensure_local`]).
    pub async fn spawn_sidecar(
        &self,
        model_id:        &str,
        gguf_path:       &Path,
        health_timeout:  Duration,
    ) -> Result<ModelEndpoint, RuntimeError> {
        // Already loaded? Reuse.
        if let Some(ep) = self.try_existing_endpoint(model_id).await {
            return Ok(ep);
        }

        let bin_path = self.resolve_sidecar_binary().ok_or(RuntimeError::SidecarMissing)?;
        let port     = pick_free_port()?;
        let endpoint = ModelEndpoint { base_url: format!("http://127.0.0.1:{port}") };

        let mut cmd = tokio::process::Command::new(&bin_path);
        cmd.arg("-m").arg(gguf_path)
            .arg("--port").arg(port.to_string())
            .arg("--host").arg("127.0.0.1")
            // Quiet logs — llama-server is chatty otherwise.
            .arg("--log-disable");

        // Detach stdio so a wedged sidecar can't backpressure us via
        // a full pipe buffer. Inherit only stderr for crash logs.
        cmd.stdin (std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::inherit());

        // Windows: don't open a console window for the sidecar.
        // `tokio::process::Command::creation_flags` is built-in (no
        // extension trait import needed, unlike std).
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn()?;

        // Wait for health.
        wait_for_health(&self.inner.http, &endpoint.base_url, health_timeout).await?;

        let mut loaded = self.inner.loaded.write().await;
        loaded.insert(model_id.to_string(), Arc::new(LoadedModel::Sidecar {
            endpoint: endpoint.clone(),
            child:    Mutex::new(child),
        }));
        Ok(endpoint)
    }

    /// Issue a single `/health` against an existing endpoint. Used
    /// by the dock health widget + by integration tests.
    pub async fn ping_health(&self, model_id: &str) -> Result<bool, RuntimeError> {
        let ep = self.endpoint_for(model_id).await?;
        let url = format!("{}/health", ep.base_url.trim_end_matches('/'));
        match self.inner.http.get(&url).send().await {
            Ok(r)  => Ok(r.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    /// Stop a model. Sidecar processes are killed; external
    /// endpoints just get unregistered.
    ///
    /// Removing the Arc from the map drops the strong refcount this
    /// manager held; when no other clones are in flight, the
    /// `LoadedModel::Drop` impl runs and `start_kill`s the child.
    /// If a generate call is mid-flight the child stays alive until
    /// that clone drops — exactly the behaviour we want (don't yank
    /// the rug out from under an in-flight stream).
    pub async fn shutdown_model(&self, model_id: &str) -> Result<(), RuntimeError> {
        let mut loaded = self.inner.loaded.write().await;
        let _ = loaded.remove(model_id);
        Ok(())
    }

    /// Stop ALL loaded models. Called from the daemon shutdown path.
    pub async fn shutdown_all(&self) {
        let model_ids: Vec<String> = {
            let loaded = self.inner.loaded.read().await;
            loaded.keys().cloned().collect()
        };
        for id in model_ids {
            let _ = self.shutdown_model(&id).await;
        }
    }

    async fn try_existing_endpoint(&self, model_id: &str) -> Option<ModelEndpoint> {
        let loaded = self.inner.loaded.read().await;
        loaded.get(model_id).map(|m| m.endpoint().clone())
    }

    fn resolve_sidecar_binary(&self) -> Option<PathBuf> {
        let bin_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
        let platform_suffix = platform_suffix();
        let bundled_name = format!("llama-server-{platform_suffix}{}", if cfg!(windows) { ".exe" } else { "" });

        if let Some(dir) = &self.inner.sidecar_paths.resource_dir {
            let candidate = dir.join(&bundled_name);
            if candidate.exists() { return Some(candidate); }
            let plain = dir.join(bin_name);
            if plain.exists() { return Some(plain); }
        }
        if let Some(dir) = &self.inner.sidecar_paths.app_local_data {
            let candidate = dir.join("inari-live").join("bin").join(bin_name);
            if candidate.exists() { return Some(candidate); }
        }
        // Last resort: PATH lookup.
        which::which("llama-server").ok()
    }
}

/// Drop the sidecar children when the Arc<LoadedModel> is dropped.
/// `start_kill` is the non-blocking variant of `kill()` — fire and
/// forget. We don't `await` because Drop is sync.
impl Drop for LoadedModel {
    fn drop(&mut self) {
        if let LoadedModel::Sidecar { child, .. } = self {
            // Best-effort kill. If the lock is poisoned the OS will
            // reap the child when our process exits.
            if let Ok(mut guard) = child.try_lock() {
                let _ = guard.start_kill();
            }
        }
    }
}

fn platform_suffix() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "macos-arm64" } else { "macos-x86_64" }
    } else if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") { "linux-arm64" } else { "linux-x86_64" }
    } else {
        "unknown"
    }
}

/// Pick a free localhost port by binding 127.0.0.1:0 + reading the
/// chosen port. Same trick the MCP server uses (sensors::mcp).
pub fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

async fn wait_for_health(
    http:    &reqwest::Client,
    base:    &str,
    timeout: Duration,
) -> Result<(), RuntimeError> {
    let url   = format!("{}/health", base.trim_end_matches('/'));
    let start = std::time::Instant::now();
    let mut backoff_ms = 50u64;
    loop {
        match http.get(&url).send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            _ => {}
        }
        if start.elapsed() >= timeout {
            return Err(RuntimeError::HealthTimeout {
                timeout_ms: timeout.as_millis() as u64,
            });
        }
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(500);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_free_port_returns_valid_port() {
        let p = pick_free_port().expect("a port");
        assert!(p > 1024);
    }

    #[test]
    fn platform_suffix_is_known() {
        let s = platform_suffix();
        assert!(s != "unknown", "test must run on a known platform, got {s}");
    }
}
