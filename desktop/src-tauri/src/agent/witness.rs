//! Witness receipt emission for tool invocations.
//!
//! Every successful or failed invoke produces a [`WitnessReceipt`]
//! summarising who-called-what-with-what-args-and-got-what-result. The
//! [`ToolRegistry`] calls [`WitnessEmitter::open`] before the tool's
//! `execute()` and [`WitnessEmitter::close`] after — implementations
//! never have to remember to emit, which is the whole point.
//!
//! In S2 we emit metadata-only receipts (no signature). The Witness
//! sidecar wiring lives in S6 (chat surface) where the chat session
//! owns the signing key; S2 just defines the shape and the in-memory
//! sink so audit + tests work end-to-end. The shape is intentionally
//! a superset of the v0.3 S2.5 `ai_router_receipts` row so future
//! sessions can fold the two ledgers together if we want (one
//! receipt → cloud `ai_router_receipts`, one → witness sidecar).
//!
//! [`ToolRegistry`]: super::ToolRegistry

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::PermissionLevel;

/// One Witness receipt for a tool invocation. Self-contained — the
/// `args_sha256` / `result_sha256` digests let downstream verifiers
/// confirm the audit row without having to re-fetch the original
/// payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WitnessReceipt {
    pub invocation_id: String,
    pub tool_name: String,
    pub session_id: Option<String>,
    pub args_sha256: String,
    pub result_sha256: Option<String>,
    pub permission: PermissionLevel,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub success: bool,
    pub error: Option<String>,
}

/// Sink trait so different deployments can route receipts differently
/// (in-memory for tests, witness-sidecar for production, dropped on
/// the floor for opt-out). All implementations are `Send + Sync`.
pub trait ReceiptSink: Send + Sync {
    fn record(&self, receipt: WitnessReceipt);
}

/// Default sink — keeps receipts in memory bounded to N most recent.
/// Used by tests and as the fallback when the witness sidecar isn't
/// installed yet.
pub struct InMemoryReceiptSink {
    buf: Mutex<std::collections::VecDeque<WitnessReceipt>>,
    cap: usize,
}

impl InMemoryReceiptSink {
    pub fn new(cap: usize) -> Self {
        let cap = cap.max(1);
        Self {
            buf: Mutex::new(std::collections::VecDeque::with_capacity(cap)),
            cap,
        }
    }

    /// Snapshot of the current ring buffer (oldest first).
    pub fn snapshot(&self) -> Vec<WitnessReceipt> {
        self.buf
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Number of receipts currently held. Useful for tests asserting
    /// "exactly one receipt was emitted".
    pub fn len(&self) -> usize {
        self.buf.lock().map(|b| b.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl ReceiptSink for InMemoryReceiptSink {
    fn record(&self, receipt: WitnessReceipt) {
        if let Ok(mut b) = self.buf.lock() {
            if b.len() >= self.cap {
                b.pop_front();
            }
            b.push_back(receipt);
        }
    }
}

/// Wraps the sink + emits open/close pairs around each tool call. The
/// registry holds one `Arc<WitnessEmitter>` for the lifetime of the
/// agent.
pub struct WitnessEmitter {
    sink: Arc<dyn ReceiptSink>,
}

impl WitnessEmitter {
    pub fn new(sink: Arc<dyn ReceiptSink>) -> Self {
        Self { sink }
    }

    /// Hash the args + return the `started_at_ms` so the registry can
    /// pass it back to [`Self::close`]. The args digest is also passed
    /// to `close` so we never re-hash the same payload twice.
    pub fn open(&self, args: &serde_json::Value) -> WitnessOpen {
        WitnessOpen {
            args_sha256: sha256_hex_value(args),
            started_at_ms: unix_ms_now(),
        }
    }

    /// Finish the receipt with the result + outcome and ship to sink.
    /// Returns the receipt so callers (the registry, tests) can
    /// inspect it without re-reading the sink.
    #[allow(clippy::too_many_arguments)]
    pub fn close(
        &self,
        invocation_id: String,
        tool_name: String,
        session_id: Option<String>,
        open: WitnessOpen,
        result: Option<&serde_json::Value>,
        permission: PermissionLevel,
        success: bool,
        error: Option<String>,
    ) -> WitnessReceipt {
        let receipt = WitnessReceipt {
            invocation_id,
            tool_name,
            session_id,
            args_sha256: open.args_sha256,
            result_sha256: result.map(sha256_hex_value),
            permission,
            started_at_ms: open.started_at_ms,
            finished_at_ms: unix_ms_now(),
            success,
            error,
        };
        self.sink.record(receipt.clone());
        receipt
    }
}

/// Token returned from [`WitnessEmitter::open`]. Carries the args
/// digest forward so we hash exactly once per invocation.
#[derive(Debug, Clone)]
pub struct WitnessOpen {
    pub args_sha256: String,
    pub started_at_ms: u64,
}

fn sha256_hex_value(value: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    // `serde_json::to_vec` produces a stable byte sequence for any given
    // Value — sufficient for "did the args / result change" semantics.
    // Full RFC 8785 / JCS canonicalisation (object-key sort + number
    // normalisation) is the witness-core job; we pull that in when the
    // sidecar wiring lands in v0.3 S6.
    let canonical = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&canonical);
    format!("{:x}", hasher.finalize())
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn emitter() -> (WitnessEmitter, Arc<InMemoryReceiptSink>) {
        let sink = Arc::new(InMemoryReceiptSink::new(8));
        let emitter = WitnessEmitter::new(sink.clone());
        (emitter, sink)
    }

    #[test]
    fn open_close_emits_one_receipt_with_stable_shape() {
        let (em, sink) = emitter();
        let args = json!({ "path": "/tmp/x" });
        let result = json!({ "ok": true });
        let open = em.open(&args);
        let receipt = em.close(
            "id-1".into(),
            "desktop.open_in_editor".into(),
            Some("session-1".into()),
            open,
            Some(&result),
            PermissionLevel::Auto,
            true,
            None,
        );

        assert_eq!(receipt.invocation_id, "id-1");
        assert_eq!(receipt.tool_name, "desktop.open_in_editor");
        assert_eq!(receipt.session_id.as_deref(), Some("session-1"));
        assert!(receipt.success);
        assert!(receipt.error.is_none());
        assert!(receipt.result_sha256.is_some());
        assert!(receipt.finished_at_ms >= receipt.started_at_ms);

        let snap = sink.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0], receipt);
    }

    #[test]
    fn args_sha256_is_deterministic_for_same_json() {
        let (em, _sink) = emitter();
        let a = em.open(&json!({ "path": "/tmp/x" }));
        let b = em.open(&json!({ "path": "/tmp/x" }));
        assert_eq!(a.args_sha256, b.args_sha256);
    }

    #[test]
    fn args_sha256_differs_for_different_json() {
        let (em, _sink) = emitter();
        let a = em.open(&json!({ "path": "/tmp/x" }));
        let b = em.open(&json!({ "path": "/tmp/y" }));
        assert_ne!(a.args_sha256, b.args_sha256);
    }

    #[test]
    fn failed_invoke_records_error_and_no_result_hash() {
        let (em, sink) = emitter();
        let args = json!({});
        let open = em.open(&args);
        let receipt = em.close(
            "id-2".into(),
            "local.run_shell".into(),
            None,
            open,
            None,
            PermissionLevel::Confirm,
            false,
            Some("editor exited 1".into()),
        );
        assert!(!receipt.success);
        assert_eq!(receipt.error.as_deref(), Some("editor exited 1"));
        assert!(receipt.result_sha256.is_none());
        assert_eq!(sink.snapshot().len(), 1);
    }

    #[test]
    fn in_memory_sink_evicts_oldest_at_capacity() {
        let sink = InMemoryReceiptSink::new(3);
        for i in 0..5 {
            let receipt = WitnessReceipt {
                invocation_id: format!("id-{i}"),
                tool_name: "t".into(),
                session_id: None,
                args_sha256: "a".into(),
                result_sha256: None,
                permission: PermissionLevel::Auto,
                started_at_ms: i,
                finished_at_ms: i,
                success: true,
                error: None,
            };
            sink.record(receipt);
        }
        let snap = sink.snapshot();
        assert_eq!(snap.len(), 3);
        // Oldest two ("id-0", "id-1") evicted; newest three remain.
        assert_eq!(snap[0].invocation_id, "id-2");
        assert_eq!(snap[2].invocation_id, "id-4");
    }

    #[test]
    fn in_memory_sink_capacity_clamps_to_one() {
        let sink = InMemoryReceiptSink::new(0);
        let receipt = WitnessReceipt {
            invocation_id: "id-only".into(),
            tool_name: "t".into(),
            session_id: None,
            args_sha256: "a".into(),
            result_sha256: None,
            permission: PermissionLevel::Auto,
            started_at_ms: 0,
            finished_at_ms: 0,
            success: true,
            error: None,
        };
        sink.record(receipt);
        assert_eq!(sink.snapshot().len(), 1);
    }

    #[test]
    fn receipt_round_trips_through_json() {
        let (em, _sink) = emitter();
        let args = json!({ "k": [1, 2, 3] });
        let result = json!({ "ok": true });
        let receipt = em.close(
            "id-3".into(),
            "t".into(),
            Some("s".into()),
            em.open(&args),
            Some(&result),
            PermissionLevel::Confirm,
            true,
            None,
        );
        let bytes = serde_json::to_vec(&receipt).unwrap();
        let back: WitnessReceipt = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(receipt, back);
    }
}
