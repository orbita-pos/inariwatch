//! EAP receipt emission. Mirror of `packages/ai-router/src/receipts.ts`.
//!
//! Per `INARI_AI_ARCHITECTURE.md` §12 (LOCKED 2026-05-02).
//!
//! Phase 1 emits **metadata-only** receipts — no Ed25519 signature.
//! Verified against the TS sink (`web/lib/ai-router/persist-receipt.ts`)
//! which also leaves `cloudReceipt: null` and never populates a
//! signature. When TS adds signing in Phase 4+, this crate adds it too.
//!
//! Receipt emission is **fire-and-forget**. Sink failures (panics, errors
//! returned by closures, etc.) are swallowed by design — receipts are
//! observability, not correctness, and must never break the dispatch
//! path.

use std::panic::AssertUnwindSafe;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::rules::Substrate;
use crate::tasks::{TaskName, TaskNamespace};

/// Mirrors the TS `RouterReceipt` interface.
///
/// Token counters are `Option<i64>` because the TS dispatch core coerces
/// 0-token responses to `null` so `/admin/ops` shows "no data" instead
/// of "0 tokens" for providers that didn't surface usage. Mirror that
/// exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterReceipt {
    pub task: TaskName,
    pub namespace: TaskNamespace,
    pub substrate: Substrate,
    /// String form so user-sidecar / capture-embedded / cli-linked
    /// (which have no [`crate::rules::AIProvider`] variant) can still
    /// be recorded. Cloud receipts use the matching
    /// `AIProvider::as_str()`.
    pub provider: String,
    pub model: String,
    pub ts_start: u64,
    pub ts_end: u64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation_session_id: Option<String>,

    pub is_platform_key: bool,
    pub fallback_used: bool,

    /// Token usage attribution. See struct doc for null-vs-zero policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<i64>,

    /// Optional payload + response hash slots. Phase 1 leaves these
    /// unset — web wiring may compute SHA-256 of the prompt body when
    /// persisting (matches TS receipts.ts comment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_hash: Option<String>,

    /// `"direct"` when same-process, `"relay"` when via
    /// relay.inariwatch.com (S2+).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_path: Option<RelayPath>,

    /// Hex-encoded Ed25519 signature. Reserved for Phase 4+. Stays
    /// `None` in v0.3 — see module-level docs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,

    /// When the dispatch ran on user-sidecar, the sidecar signs its own
    /// receipt locally (S27/S28 chain) and the relay forwards it back.
    /// Persisted as opaque JSON — never re-signed by web. For other
    /// substrates this stays `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_sidecar_receipt: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelayPath {
    Direct,
    Relay,
}

impl RelayPath {
    pub const fn as_str(self) -> &'static str {
        match self {
            RelayPath::Direct => "direct",
            RelayPath::Relay => "relay",
        }
    }
}

/// A receipt sink — same surface as the TS `ReceiptSink` type alias.
///
/// Sinks are synchronous because Rust does not have a stable cross-crate
/// "fire-and-forget async" primitive. Sinks that need to do IO should
/// spawn their own background task (the persist-receipt sink in
/// `web/lib/ai-router/persist-receipt.ts` does the equivalent with
/// `void doInsert(...)`).
///
/// We use a `Box<dyn Fn>` instead of a trait to keep the sink site
/// terse — `register_receipt_sink(|r| { ... })` Just Works.
pub type ReceiptSink = Box<dyn Fn(&RouterReceipt) + Send + Sync + 'static>;

static SINKS: Lazy<Mutex<Vec<ReceiptSink>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Register a sink. Multiple sinks may be registered; each is called
/// per dispatch. Order is preserved.
///
/// Unlike the TS variant we do **not** dedupe — Rust trait objects do
/// not have stable identity, and the de-dup case (Next.js HMR / Vitest
/// reloads) does not apply here. Callers that need idempotence should
/// gate their own `register_receipt_sink` call behind a `OnceLock`.
pub fn register_receipt_sink<F>(sink: F)
where
    F: Fn(&RouterReceipt) + Send + Sync + 'static,
{
    let mut sinks = SINKS.lock().expect("SINKS mutex poisoned");
    sinks.push(Box::new(sink));
}

/// Visible for tests — drop every sink. Not for runtime use.
pub fn clear_receipt_sinks() {
    let mut sinks = SINKS.lock().expect("SINKS mutex poisoned");
    sinks.clear();
}

/// Visible for tests — current sink count.
pub fn receipt_sink_count() -> usize {
    SINKS.lock().expect("SINKS mutex poisoned").len()
}

/// Fire-and-forget receipt emission. Panics inside sinks are caught and
/// swallowed; the dispatch path is **never** allowed to fail because of
/// a receipt sink.
pub fn emit_receipt(receipt: RouterReceipt) {
    let sinks = match SINKS.lock() {
        Ok(g) => g,
        // If the mutex is poisoned a previous sink panicked; we still
        // want to drop the receipt instead of propagating.
        Err(_) => return,
    };
    for sink in sinks.iter() {
        let r = AssertUnwindSafe(|| sink(&receipt));
        let _ = std::panic::catch_unwind(r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A guard that clears sinks at end-of-test so registrations from
    /// one test do not leak into another. `RUST_TEST_THREADS=1` is set
    /// at the workspace level (per `project_machine_constraints.md`),
    /// so single-threaded test runs make this safe.
    struct SinkGuard;
    impl Drop for SinkGuard {
        fn drop(&mut self) {
            clear_receipt_sinks();
        }
    }

    fn sample_receipt() -> RouterReceipt {
        RouterReceipt {
            task: TaskName::AlertAutoAnalyze,
            namespace: TaskNamespace::Alert,
            substrate: Substrate::Cloud,
            provider: "openai".to_string(),
            model: "gpt-4o-mini".to_string(),
            ts_start: 1_000,
            ts_end: 1_250,
            workspace_id: Some("ws_demo".to_string()),
            user_id: Some("user_demo".to_string()),
            project_id: None,
            alert_id: None,
            remediation_session_id: None,
            is_platform_key: false,
            fallback_used: false,
            input_tokens: Some(120),
            output_tokens: Some(40),
            cached_input_tokens: None,
            payload_hash: None,
            response_hash: None,
            relay_path: Some(RelayPath::Direct),
            signature: None,
            user_sidecar_receipt: None,
        }
    }

    #[test]
    fn signature_is_none_in_phase_1() {
        let r = sample_receipt();
        assert!(
            r.signature.is_none(),
            "Phase 1 must mirror TS receipts.ts — no Ed25519 signing yet",
        );
    }

    #[test]
    fn register_then_emit_calls_sink_once_per_dispatch() {
        let _g = SinkGuard;
        clear_receipt_sinks();
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        register_receipt_sink(move |_r| {
            c.fetch_add(1, Ordering::SeqCst);
        });
        emit_receipt(sample_receipt());
        emit_receipt(sample_receipt());
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn multiple_sinks_each_called_in_order() {
        let _g = SinkGuard;
        clear_receipt_sinks();
        let log = Arc::new(Mutex::new(Vec::<u8>::new()));
        let l1 = log.clone();
        register_receipt_sink(move |_r| l1.lock().unwrap().push(1));
        let l2 = log.clone();
        register_receipt_sink(move |_r| l2.lock().unwrap().push(2));
        emit_receipt(sample_receipt());
        assert_eq!(*log.lock().unwrap(), vec![1, 2]);
    }

    #[test]
    fn panic_in_sink_is_swallowed() {
        let _g = SinkGuard;
        clear_receipt_sinks();
        let after = Arc::new(AtomicUsize::new(0));
        register_receipt_sink(|_r| panic!("oh no"));
        let a = after.clone();
        register_receipt_sink(move |_r| {
            a.fetch_add(1, Ordering::SeqCst);
        });
        emit_receipt(sample_receipt());
        // Despite the first sink panicking, the second sink still ran
        // because the dispatch path must never observe a sink failure.
        assert_eq!(after.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn clear_drops_all_sinks() {
        let _g = SinkGuard;
        // Tests in other modules (dispatch::*) leave a sink registered
        // after their assertions. Clear at start so this test asserts
        // its own delta.
        clear_receipt_sinks();
        register_receipt_sink(|_r| {});
        register_receipt_sink(|_r| {});
        assert_eq!(receipt_sink_count(), 2);
        clear_receipt_sinks();
        assert_eq!(receipt_sink_count(), 0);
    }

    #[test]
    fn receipt_serializes_skipping_none() {
        let r = sample_receipt();
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["task"], "AlertAutoAnalyze");
        assert_eq!(json["substrate"], "cloud");
        assert_eq!(json["provider"], "openai");
        assert!(json.get("signature").is_none());
        assert!(json.get("project_id").is_none());
        assert_eq!(json["relay_path"], "direct");
    }
}
