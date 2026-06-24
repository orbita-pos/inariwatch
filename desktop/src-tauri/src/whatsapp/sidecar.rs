//! v0.3 S5 — Baileys sidecar lifecycle + JSON-RPC client.
//!
//! ## Process model
//!
//! One long-lived Node child process per Inari Live instance. The
//! sidecar (`desktop/src-tauri/sidecars/whatsapp/dist/main.js`) handles
//! N WhatsApp accounts inside its own process — each account has its own
//! Baileys socket but shares the same JSON-RPC channel back to Rust.
//!
//! ## Wire protocol
//!
//! Newline-delimited JSON-RPC 2.0 over stdin/stdout. Each line is a
//! complete JSON object. Three message shapes:
//!
//! ```json
//! // Request (Rust → Node)
//! {"jsonrpc":"2.0","id":42,"method":"send_message","params":{...}}
//!
//! // Response (Node → Rust, matched by `id`)
//! {"jsonrpc":"2.0","id":42,"result":{...}}            // success
//! {"jsonrpc":"2.0","id":42,"error":{"code":-32600,"message":"..."}} // failure
//!
//! // Notification (Node → Rust, no `id`)
//! {"jsonrpc":"2.0","method":"event","params":{"type":"qr_update", ...}}
//! ```
//!
//! Stderr from the sidecar is logged to tracing at INFO. Crashes
//! re-spawn after a 1s backoff (Inari Live keeps retrying — the user
//! sees `Failed` status if the spawn itself fails 3 times in a row).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio::task::JoinHandle;

use super::types::{
    AccountInfo, ConnectionStatus, SendMessageRequest, SendMessageResponse,
    WhatsAppEvent,
};

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("sidecar failed to spawn: {0}")]
    Spawn(String),
    #[error("sidecar exited unexpectedly: code={0:?}")]
    Exited(Option<i32>),
    #[error("RPC call '{method}' failed: {message}")]
    Rpc { method: String, message: String },
    #[error("RPC call '{method}' timed out after {timeout_ms}ms")]
    Timeout { method: String, timeout_ms: u64 },
    #[error("sidecar disconnected — pending RPC dropped")]
    Disconnected,
    #[error("invalid response shape: {0}")]
    InvalidResponse(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

// ── Wire types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct RpcRequest<'a> {
    jsonrpc: &'static str,
    id: i64,
    method: &'a str,
    params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct RpcMessage {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<i64>,
    /// Set on a notification ("event"); absent on a response.
    method: Option<String>,
    /// Set on a response; absent on a notification.
    result: Option<serde_json::Value>,
    error: Option<RpcError>,
    /// Set on a notification.
    params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RpcError {
    #[allow(dead_code)]
    code: i32,
    message: String,
}

// ── Manager ─────────────────────────────────────────────────────────────────

/// Configuration for spawning the sidecar.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Absolute path to the sidecar entry script (`dist/main.js`).
    /// Resolved by the caller from `app.path().resource_dir()` (release)
    /// or the workspace path (dev).
    pub script_path: PathBuf,
    /// Where the sidecar persists per-account credentials.
    /// `<app_local_data_dir>/whatsapp/<account_id>/{creds.json, .bak}`.
    pub auth_root: PathBuf,
    /// Override for tests — a stub binary the test fixture expects to find
    /// at this location instead of `node`. Production leaves this `None`
    /// and the manager uses `which("node")` (system PATH).
    pub node_binary: Option<PathBuf>,
    /// RPC timeout. 30s is generous — login_start can take that long
    /// while the user scans the QR.
    pub rpc_timeout_ms: u64,
}

impl SidecarConfig {
    pub fn new(script_path: PathBuf, auth_root: PathBuf) -> Self {
        Self {
            script_path,
            auth_root,
            node_binary: None,
            rpc_timeout_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SidecarManager {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    cfg: SidecarConfig,
    /// Pending RPC calls awaiting a response. Inserted on send, removed
    /// when the matching `id` lands on stdout.
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<serde_json::Value, String>>>>,
    /// Monotonic id allocator.
    next_id: AtomicI64,
    /// Stdin sink. None when the sidecar is not running. Wrapped in
    /// Mutex because tokio child stdin doesn't impl Clone — we hold it
    /// across awaits.
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    /// Channel that fans out sidecar events to subscribers (Tauri event
    /// bridge + accounts cache updater). Capacity = 64.
    events_tx: broadcast::Sender<WhatsAppEvent>,
    /// Last-known account snapshot. Updated by the events consumer.
    accounts: Mutex<HashMap<String, AccountInfo>>,
    /// Supervisor task handle — polled by `shutdown()`.
    supervisor: Mutex<Option<JoinHandle<()>>>,
    /// True when shutdown has been requested. Causes the supervisor to
    /// exit instead of re-spawning the child.
    shutdown_requested: std::sync::atomic::AtomicBool,
}

impl SidecarManager {
    /// Build (does NOT spawn). Call [`SidecarManager::start`] to actually
    /// launch the Node process.
    pub fn new(cfg: SidecarConfig) -> Self {
        let (events_tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(Inner {
                cfg,
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicI64::new(1),
                stdin: Mutex::new(None),
                events_tx,
                accounts: Mutex::new(HashMap::new()),
                supervisor: Mutex::new(None),
                shutdown_requested: std::sync::atomic::AtomicBool::new(false),
            }),
        }
    }

    /// Subscribe to sidecar events. Frontend bridges connect this to
    /// Tauri events; the relay dispatcher uses it to update its
    /// in-process cache.
    pub fn subscribe(&self) -> broadcast::Receiver<WhatsAppEvent> {
        self.inner.events_tx.subscribe()
    }

    /// Spawn the supervisor task, which in turn spawns the Node child.
    /// Idempotent — calling twice is a no-op (the second call returns
    /// without doing work).
    pub async fn start(&self) -> Result<(), SidecarError> {
        let mut sup = self.inner.supervisor.lock().await;
        if sup.is_some() {
            return Ok(());
        }
        let inner = self.inner.clone();
        *sup = Some(tokio::spawn(supervisor_loop(inner)));
        Ok(())
    }

    /// Request a shutdown. The supervisor exits without re-spawning
    /// after the current child terminates. Pending RPCs receive a
    /// `Disconnected` error.
    pub async fn shutdown(&self) {
        self.inner
            .shutdown_requested
            .store(true, Ordering::Relaxed);
        // Drop stdin → Node sees EOF and shuts down cleanly.
        {
            let mut s = self.inner.stdin.lock().await;
            s.take();
        }
        let mut sup = self.inner.supervisor.lock().await;
        if let Some(h) = sup.take() {
            let _ = h.await;
        }
        // Drop pending callers.
        let mut pending = self.inner.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("sidecar shutdown".into()));
        }
    }

    /// Snapshot the in-process accounts cache. Cheap — clones a small map.
    pub async fn list_accounts(&self) -> Vec<AccountInfo> {
        let map = self.inner.accounts.lock().await;
        map.values().cloned().collect()
    }

    /// Fetch a single account's snapshot.
    pub async fn account_status(&self, account_id: &str) -> Option<AccountInfo> {
        let map = self.inner.accounts.lock().await;
        map.get(account_id).cloned()
    }

    /// Begin a login flow for `account_id` with the given user-visible
    /// label. The sidecar emits `qr_update` events until the user scans;
    /// success arrives as a `linked` event. RPC return is opaque (`{}`).
    pub async fn login_start(
        &self,
        account_id: &str,
        label: &str,
    ) -> Result<(), SidecarError> {
        let params = serde_json::json!({
            "account_id": account_id,
            "label": label,
        });
        // Pre-seed the cache so the UI can render an entry immediately.
        {
            let mut map = self.inner.accounts.lock().await;
            map.insert(
                account_id.to_string(),
                AccountInfo {
                    account_id: account_id.to_string(),
                    label: label.to_string(),
                    self_jid: None,
                    status: ConnectionStatus::QrPending,
                    last_qr_at_ms: None,
                    last_linked_at_ms: None,
                },
            );
        }
        self.call_rpc("login_start", params).await.map(|_| ())
    }

    /// Poll until the sidecar's stdin handle is available. Returns Err
    /// if the deadline lapses — used by `resume_persisted_accounts`
    /// so we don't race the supervisor that spawns the Node child.
    pub async fn wait_until_ready(&self, timeout: Duration) -> Result<(), SidecarError> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            {
                let stdin = self.inner.stdin.lock().await;
                if stdin.is_some() {
                    return Ok(());
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err(SidecarError::Rpc {
                    method: "wait_until_ready".into(),
                    message: format!(
                        "sidecar did not become ready within {}ms",
                        timeout.as_millis()
                    ),
                });
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Scan `auth_root` for previously-paired accounts and re-issue
    /// `login_start` so Baileys reuses the persisted creds + signal
    /// keys (no QR scan). Called once at app boot.
    ///
    /// An account is considered "persisted" when its directory under
    /// `auth_root` contains `creds.json` — that's what Baileys writes
    /// after the first successful link. The companion `label.txt` is
    /// best-effort (defaults to "Personal" when missing) so a
    /// downgrade from an older sidecar build that didn't write the
    /// label doesn't strand the account.
    ///
    /// Returns the number of accounts that were submitted for
    /// resume; individual `login_start` failures are logged and
    /// skipped rather than failing the whole walk.
    pub async fn resume_persisted_accounts(&self) -> Result<usize, SidecarError> {
        let auth_root = self.inner.cfg.auth_root.clone();
        if !auth_root.exists() {
            return Ok(0);
        }
        // 5s budget — usually <100ms in practice. Long enough to cover
        // a slow `node` spawn on a cold disk without making the user
        // wait if the sidecar is genuinely broken.
        if let Err(e) = self.wait_until_ready(Duration::from_secs(5)).await {
            tracing::warn!(error = %e, "[whatsapp] resume skipped — sidecar not ready");
            return Ok(0);
        }

        let mut entries = match tokio::fs::read_dir(&auth_root).await {
            Ok(it) => it,
            Err(e) => {
                tracing::warn!(error = %e, "[whatsapp] resume read_dir failed");
                return Ok(0);
            }
        };
        let mut count = 0usize;
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(error = %e, "[whatsapp] resume next_entry failed");
                    break;
                }
            };
            let path = entry.path();
            let is_dir = entry
                .file_type()
                .await
                .map(|ft| ft.is_dir())
                .unwrap_or(false);
            if !is_dir {
                continue;
            }
            let account_id = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue,
            };
            if !path.join("creds.json").exists() {
                continue;
            }
            let label = tokio::fs::read_to_string(path.join("label.txt"))
                .await
                .map(|s| s.trim().to_string())
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Personal".to_string());
            match self.login_start(&account_id, &label).await {
                Ok(()) => {
                    count += 1;
                    tracing::info!(
                        account_id = %account_id,
                        label = %label,
                        "[whatsapp] resumed paired account"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        account_id = %account_id,
                        error = %e,
                        "[whatsapp] resume login_start failed"
                    );
                }
            }
        }
        Ok(count)
    }

    pub async fn send_message(
        &self,
        req: SendMessageRequest,
    ) -> Result<SendMessageResponse, SidecarError> {
        let value = self
            .call_rpc("send_message", serde_json::to_value(&req)?)
            .await?;
        let resp: SendMessageResponse = serde_json::from_value(value)
            .map_err(|e| SidecarError::InvalidResponse(e.to_string()))?;
        Ok(resp)
    }

    pub async fn logout(&self, account_id: &str) -> Result<(), SidecarError> {
        let params = serde_json::json!({"account_id": account_id});
        self.call_rpc("logout", params).await.map(|_| ())
    }

    /// Internal: send a JSON-RPC request and await its response.
    async fn call_rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, SidecarError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.inner.pending.lock().await;
            pending.insert(id, tx);
        }

        let body = serde_json::to_string(&RpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        })?;

        // Acquire stdin and write the line.
        {
            let mut stdin_guard = self.inner.stdin.lock().await;
            let stdin = stdin_guard.as_mut().ok_or_else(|| {
                SidecarError::Rpc {
                    method: method.into(),
                    message: "sidecar not running".into(),
                }
            })?;
            stdin.write_all(body.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
        }

        // Wait for either the response or the timeout.
        let timeout_ms = self.inner.cfg.rpc_timeout_ms;
        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            rx,
        )
        .await;

        // Best-effort: drop the pending entry so a late response doesn't
        // leak.
        {
            let mut pending = self.inner.pending.lock().await;
            pending.remove(&id);
        }

        match outcome {
            Err(_) => Err(SidecarError::Timeout {
                method: method.into(),
                timeout_ms,
            }),
            Ok(Err(_)) => Err(SidecarError::Disconnected),
            Ok(Ok(Err(msg))) => Err(SidecarError::Rpc {
                method: method.into(),
                message: msg,
            }),
            Ok(Ok(Ok(v))) => Ok(v),
        }
    }
}

// ── Supervisor + IO pumps ───────────────────────────────────────────────────

async fn supervisor_loop(inner: Arc<Inner>) {
    let mut backoff_ms: u64 = 1_000;
    loop {
        if inner.shutdown_requested.load(Ordering::Relaxed) {
            return;
        }
        match spawn_child(&inner).await {
            Ok(child) => {
                tracing::info!("[whatsapp] sidecar started");
                run_child(&inner, child).await;
                tracing::info!("[whatsapp] sidecar exited");
                if inner.shutdown_requested.load(Ordering::Relaxed) {
                    return;
                }
                // Reset backoff after a clean run; the next failure
                // will start at 1s again. If we're here because the
                // child crashed mid-pump, we still wait 1s before
                // re-spawning.
                backoff_ms = 1_000;
            }
            Err(err) => {
                tracing::warn!(error = %err, "[whatsapp] sidecar spawn failed");
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms.saturating_mul(2)).min(30_000);
            }
        }
        // Always brief pause between respawns so we don't wedge the CPU
        // on a script that exits immediately on every launch.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

async fn spawn_child(inner: &Arc<Inner>) -> Result<Child, SidecarError> {
    let node = inner
        .cfg
        .node_binary
        .clone()
        .unwrap_or_else(|| PathBuf::from("node"));
    // Make sure the auth root exists (sidecar will subdir per account).
    if let Err(err) = std::fs::create_dir_all(&inner.cfg.auth_root) {
        return Err(SidecarError::Spawn(format!(
            "create auth_root '{}': {}",
            inner.cfg.auth_root.display(),
            err
        )));
    }

    let mut cmd = Command::new(&node);
    cmd.arg(&inner.cfg.script_path)
        .arg("--auth-root")
        .arg(&inner.cfg.auth_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    cmd.spawn().map_err(|e| {
        SidecarError::Spawn(format!(
            "node {} {} : {}",
            node.display(),
            inner.cfg.script_path.display(),
            e
        ))
    })
}

async fn run_child(inner: &Arc<Inner>, mut child: Child) {
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Stash stdin so call_rpc can write to it.
    {
        let mut guard = inner.stdin.lock().await;
        *guard = stdin;
    }

    let stdout_inner = inner.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => handle_line(&stdout_inner, &line).await,
                    Ok(None) => break,
                    Err(err) => {
                        tracing::warn!(error = %err, "[whatsapp] stdout read error");
                        break;
                    }
                }
            }
        }
    });

    let stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(line = %line, "[whatsapp] sidecar stderr");
            }
        }
    });

    // Wait for the child to exit OR for shutdown.
    let _status = child.wait().await;

    // Tear down stdin so call_rpc starts failing fast.
    {
        let mut guard = inner.stdin.lock().await;
        guard.take();
    }

    // Drain pending RPCs.
    {
        let mut pending = inner.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("sidecar restarted mid-call".into()));
        }
    }

    let _ = stdout_task.await;
    let _ = stderr_task.await;
}

async fn handle_line(inner: &Arc<Inner>, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let msg: RpcMessage = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(error = %err, line = %line, "[whatsapp] dropped non-JSON line");
            return;
        }
    };
    if let Some(id) = msg.id {
        // Response.
        let pending_entry = {
            let mut pending = inner.pending.lock().await;
            pending.remove(&id)
        };
        if let Some(tx) = pending_entry {
            let result = if let Some(err) = msg.error {
                Err(err.message)
            } else {
                Ok(msg.result.unwrap_or(serde_json::Value::Null))
            };
            let _ = tx.send(result);
        }
        return;
    }

    // Notification.
    let method = msg.method.unwrap_or_default();
    if method != "event" {
        tracing::debug!(method = %method, "[whatsapp] ignored non-event notification");
        return;
    }
    let params = match msg.params {
        Some(p) => p,
        None => return,
    };
    let event: WhatsAppEvent = match serde_json::from_value(params.clone()) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(error = %err, params = %params, "[whatsapp] dropped malformed event");
            return;
        }
    };
    update_accounts_for_event(inner, &event).await;
    let _ = inner.events_tx.send(event);
}

async fn update_accounts_for_event(inner: &Arc<Inner>, event: &WhatsAppEvent) {
    let mut map = inner.accounts.lock().await;
    match event {
        WhatsAppEvent::QrUpdate {
            account_id, ts_ms, ..
        } => {
            if let Some(info) = map.get_mut(account_id) {
                info.status = ConnectionStatus::QrPending;
                info.last_qr_at_ms = Some(*ts_ms);
            }
        }
        WhatsAppEvent::Linked {
            account_id,
            self_jid,
            ts_ms,
        } => {
            if let Some(info) = map.get_mut(account_id) {
                info.status = ConnectionStatus::Connected;
                info.self_jid = Some(self_jid.clone());
                info.last_linked_at_ms = Some(*ts_ms);
            }
        }
        WhatsAppEvent::LoggedOut { account_id, .. } => {
            if let Some(info) = map.get_mut(account_id) {
                info.status = ConnectionStatus::Disconnected;
                info.self_jid = None;
            }
        }
        WhatsAppEvent::ConnectionStateChanged {
            account_id, status, ..
        } => {
            if let Some(info) = map.get_mut(account_id) {
                info.status = *status;
            }
        }
        WhatsAppEvent::Fatal { .. } => {
            // No state mutation — listeners (frontend toast) handle it.
        }
        WhatsAppEvent::MessageReceived { account_id, ts_ms, .. } => {
            // S8 — last-seen bookkeeping for the account. The
            // messenger gateway is the canonical consumer; we only
            // touch the cache so Settings → Channels can show
            // "received message at HH:MM" if it cares to.
            if let Some(info) = map.get_mut(account_id) {
                // Don't downgrade the connection status — receiving a
                // message implies we're online. Update last_linked_at
                // as a coarse "alive" timestamp; finer-grained
                // recv-time is owned by `messenger::events`.
                info.last_linked_at_ms = Some(*ts_ms);
            }
        }
    }
}
