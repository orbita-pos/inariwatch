//! Inari Live LSP server.
//!
//! TCP listener on `127.0.0.1:9877` (LSP) — distinct from the local MCP
//! port at 9876. Editors that speak stdio LSP connect through the
//! `inari-lsp-stdio` sidecar binary which forwards stdin/stdout to this
//! port. Editors with native TCP LSP support (Helix, Neovim with
//! `tcp_connect`) connect directly.
//!
//! Sesión 22 ships the wire skeleton + cancel mechanic + document cache
//! with **stub** completion / codeAction / hover. Sesión 23 wires real
//! Tab completion through `LocalAI::generate(.., fim_mode=true)`. The
//! TODO markers in `handlers/completion.rs` flag the swap site.

pub mod document_sync;
pub mod handlers;
pub mod protocol;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

use crate::lsp::document_sync::{ContentChange, DocumentStore};
use crate::lsp::protocol::{
    decode, read_message, write_message, InboundMessage, NotificationMessage, RequestId,
    ResponseError, ResponseMessage,
};

/// Bind the LSP server on `127.0.0.1:port` and spawn the accept loop in
/// the background. Returns the bound socket address (useful when port == 0
/// for tests). Errors only on initial bind failure.
pub async fn start_lsp_server(port: u16) -> std::io::Result<SocketAddr> {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).await?;
    let bound = listener.local_addr()?;
    let state = Arc::new(LspState::new());
    tokio::spawn(accept_loop(listener, state));
    Ok(bound)
}

/// Test helper: bind on `127.0.0.1:0` and return the bound addr + the
/// shared state handle so a test can poke knobs (e.g., completion
/// delay) before driving the server.
pub async fn start_lsp_server_for_test() -> std::io::Result<(SocketAddr, Arc<LspState>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bound = listener.local_addr()?;
    let state = Arc::new(LspState::new());
    let s2 = state.clone();
    tokio::spawn(accept_loop(listener, s2));
    Ok((bound, state))
}

// ── State ─────────────────────────────────────────────────────────────────────

/// Server-wide state. Held in an `Arc` and shared across connection
/// handlers + tests.
pub struct LspState {
    /// `textDocument/didOpen|didChange|didClose` cache.
    pub documents: DocumentStore,

    /// Map from in-flight request id → cancellation sender. Each request
    /// inserts a fresh `oneshot` and removes it on completion (or has it
    /// fired by `$/cancelRequest`).
    pending: Mutex<HashMap<RequestId, oneshot::Sender<()>>>,

    /// `true` once `initialize` has succeeded. Other requests before this
    /// flag flips return `-32002 ServerNotInitialized` per LSP 3.17.
    initialized: AtomicBool,

    /// Test knob: when > 0, the completion handler sleeps this many ms
    /// before computing the stub. Lets `lsp_cancel_request_works.rs`
    /// observe a request that is genuinely pending. Production code
    /// never writes this field.
    completion_delay_ms: AtomicU64,
}

impl LspState {
    pub fn new() -> Self {
        Self {
            documents: DocumentStore::new(),
            pending: Mutex::new(HashMap::new()),
            initialized: AtomicBool::new(false),
            completion_delay_ms: AtomicU64::new(0),
        }
    }

    pub fn is_initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    pub fn mark_initialized(&self) {
        self.initialized.store(true, Ordering::SeqCst);
    }

    /// Test knob. Sets the per-request artificial delay used by the
    /// completion handler.
    pub fn set_completion_delay_ms(&self, ms: u64) {
        self.completion_delay_ms.store(ms, Ordering::Relaxed);
    }

    pub fn completion_delay_ms(&self) -> u64 {
        self.completion_delay_ms.load(Ordering::Relaxed)
    }

    /// Register an in-flight request; returns the receiver the handler
    /// awaits to observe a cancel.
    pub fn register_pending(&self, id: RequestId) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        let mut g = self.pending.lock().expect("LspState pending mutex poisoned");
        // If a duplicate id is registered (broken client), drop the
        // older sender — its receiver will see `Closed` and the request
        // will continue normally. The new one wins the cancel race.
        g.insert(id, tx);
        rx
    }

    pub fn complete_pending(&self, id: &RequestId) {
        let mut g = self.pending.lock().expect("LspState pending mutex poisoned");
        g.remove(id);
    }

    /// Trigger cancellation for `id`. No-op if no such request is in
    /// flight (the handler may already have completed).
    pub fn cancel(&self, id: &RequestId) {
        let tx = {
            let mut g = self.pending.lock().expect("LspState pending mutex poisoned");
            g.remove(id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("LspState pending mutex poisoned").len()
    }
}

impl Default for LspState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Accept loop ──────────────────────────────────────────────────────────────

async fn accept_loop(listener: TcpListener, state: Arc<LspState>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[lsp] accept error: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        eprintln!("[lsp] connection from {peer}");
        let s = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, s).await {
                eprintln!("[lsp] connection error: {e}");
            }
        });
    }
}

// ── Per-connection handler ───────────────────────────────────────────────────

async fn handle_connection(
    stream: TcpStream,
    state: Arc<LspState>,
) -> std::io::Result<()> {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    // Outbound is serialised through an mpsc — multiple request handlers
    // can complete out of order without interleaving frames on the wire.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer_task = {
        let mut writer = write_half;
        tokio::spawn(async move {
            while let Some(payload) = out_rx.recv().await {
                if let Err(e) = write_message(&mut writer, &payload).await {
                    eprintln!("[lsp] write error: {e}");
                    break;
                }
            }
            let _ = writer.shutdown().await;
        })
    };

    loop {
        let body = match read_message(&mut reader).await {
            Ok(Some(b)) => b,
            Ok(None) => break,
            Err(e) => {
                eprintln!("[lsp] read error: {e}");
                break;
            }
        };

        match decode(&body) {
            Ok(InboundMessage::Request { id, method, params }) => {
                dispatch_request(state.clone(), id, method, params, out_tx.clone());
            }
            Ok(InboundMessage::Notification { method, params }) => {
                dispatch_notification(state.clone(), method, params, &out_tx);
            }
            Ok(InboundMessage::Response { id, .. }) => {
                eprintln!("[lsp] received unsolicited response id={id:?} — ignoring");
            }
            Err(err) => {
                // Best-effort: we don't know the id, so emit a JSON-RPC
                // error with id=null per the spec.
                let payload = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id":      null,
                    "error":   err,
                });
                let _ = out_tx.send(serde_json::to_vec(&payload).unwrap_or_default());
            }
        }
    }

    drop(out_tx);
    let _ = writer_task.await;
    Ok(())
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

fn dispatch_request(
    state: Arc<LspState>,
    id: RequestId,
    method: String,
    params: Value,
    out_tx: mpsc::UnboundedSender<Vec<u8>>,
) {
    tokio::spawn(async move {
        let response = run_request(state, id, method, params).await;
        let payload = serde_json::to_vec(&response).unwrap_or_else(|_| Vec::new());
        let _ = out_tx.send(payload);
    });
}

async fn run_request(
    state: Arc<LspState>,
    id: RequestId,
    method: String,
    params: Value,
) -> ResponseMessage {
    // `initialize` and `shutdown` are special: handled inline (no cancel
    // channel — they cannot meaningfully be cancelled).
    match method.as_str() {
        "initialize" => {
            let result = handlers::initialize::handle(params);
            state.mark_initialized();
            return ResponseMessage::success(id, result);
        }
        "shutdown" => {
            return ResponseMessage::success(id, Value::Null);
        }
        _ => {}
    }

    if !state.is_initialized() {
        return ResponseMessage::fail(
            id,
            ResponseError {
                code: -32002,
                message: "server not initialized".into(),
                data: None,
            },
        );
    }

    let cancel_rx = state.register_pending(id.clone());
    let result = match method.as_str() {
        "textDocument/completion" => {
            let resp = handlers::completion::handle(state.clone(), id.clone(), params, cancel_rx).await;
            state.complete_pending(&id);
            return resp;
        }
        "textDocument/codeAction" => Ok(handlers::code_action::handle(params)),
        "textDocument/hover"      => Ok(handlers::hover::handle(params)),
        other => Err(ResponseError::method_not_found(other)),
    };
    state.complete_pending(&id);

    match result {
        Ok(v)  => ResponseMessage::success(id, v),
        Err(e) => ResponseMessage::fail(id, e),
    }
}

fn dispatch_notification(
    state: Arc<LspState>,
    method: String,
    params: Value,
    _out_tx: &mpsc::UnboundedSender<Vec<u8>>,
) {
    match method.as_str() {
        "$/cancelRequest" => handlers::cancel::handle(&state, params),
        "initialized"     => { /* client ack — no-op */ }
        "exit"            => { /* upstream daemon kills the process tree */ }
        "textDocument/didOpen"   => handle_did_open(&state, params),
        "textDocument/didChange" => handle_did_change(&state, params),
        "textDocument/didClose"  => handle_did_close(&state, params),
        other => {
            eprintln!("[lsp] unhandled notification: {other}");
        }
    }
}

fn handle_did_open(state: &Arc<LspState>, params: Value) {
    let Some(td) = params.get("textDocument") else { return };
    let Some(uri) = td.get("uri").and_then(Value::as_str) else { return };
    let language_id = td.get("languageId").and_then(Value::as_str).unwrap_or("").to_string();
    let version = td.get("version").and_then(Value::as_i64).unwrap_or(0) as i32;
    let text = td.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    state.documents.open(uri.to_string(), language_id, version, text);
}

fn handle_did_change(state: &Arc<LspState>, params: Value) {
    let Some(td) = params.get("textDocument") else { return };
    let Some(uri) = td.get("uri").and_then(Value::as_str) else { return };
    let version = td.get("version").and_then(Value::as_i64).unwrap_or(0) as i32;
    let changes_v = params.get("contentChanges").cloned().unwrap_or(Value::Array(vec![]));
    let changes: Vec<ContentChange> = match serde_json::from_value(changes_v) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[lsp] didChange contentChanges decode error: {e}");
            return;
        }
    };
    if let Err(e) = state.documents.apply_changes(uri, version, &changes) {
        eprintln!("[lsp] didChange apply error: {e}");
    }
}

fn handle_did_close(state: &Arc<LspState>, params: Value) {
    let Some(td) = params.get("textDocument") else { return };
    let Some(uri) = td.get("uri").and_then(Value::as_str) else { return };
    state.documents.close(uri);
}

// `NotificationMessage` is currently unused on the server-emit side
// (every method we implement is request/response or pure notification
// from client → server). Keeping the type exported so S23+'s
// `$/progress` and `window/showMessage` paths can use it without
// re-declaring.
#[allow(dead_code)]
fn _unused_emit_notification_path(method: &str, params: Value) -> NotificationMessage {
    NotificationMessage::new(method, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_register_cancel_complete() {
        let s = LspState::new();
        let id = RequestId::Number(1);
        let rx = s.register_pending(id.clone());
        assert_eq!(s.pending_count(), 1);
        s.cancel(&id);
        // After cancel, the pending entry is removed AND the rx fires.
        assert_eq!(s.pending_count(), 0);
        // The receiver should now resolve to Ok(()).
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let v = rx.await;
            assert!(v.is_ok());
        });
    }

    #[test]
    fn state_complete_pending_removes_entry() {
        let s = LspState::new();
        let id = RequestId::Number(2);
        let _rx = s.register_pending(id.clone());
        assert_eq!(s.pending_count(), 1);
        s.complete_pending(&id);
        assert_eq!(s.pending_count(), 0);
    }

    #[test]
    fn cancel_unknown_id_is_noop() {
        let s = LspState::new();
        s.cancel(&RequestId::Number(42)); // no panic
    }
}
