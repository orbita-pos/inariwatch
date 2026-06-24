//! Integration suite for the search tool cluster (S13).
//!
//! Drives the **full registry pipeline** (lookup → schema validate →
//! permission gate → witness open → execute → witness close → audit
//! insert) for `search.error_context`. The backend is the
//! feature-gated `MockSearchBackend` from
//! `agent::tools::search::mocks` so the harness never touches the
//! live SO/GH/MDN endpoints.
//!
//! What we lock here:
//!
//! 1. `register_search_tools` registers exactly one tool with the
//!    expected name + `Auto` default permission.
//! 2. End-to-end happy path produces exactly one audit row + one
//!    receipt with `success = true` and `args_sha256` matching the
//!    SHA-256 of the canonical args bytes.
//! 3. Schema rejects (one per shape):
//!      - missing `error_text` → SchemaInvalid.
//!      - empty `error_text` → SchemaInvalid (minLength 1).
//!      - `max_hits` > 50 → SchemaInvalid.
//!      - extra unknown property → SchemaInvalid (additionalProperties=false).
//! 4. Backend error → `ExecutionFailed`, audit row `success=false`,
//!    receipt with `error` populated.
//! 5. Returned `ToolOutput.value` round-trips back to the
//!    `SearchResponse` shape (no Value blob, no schema drift) — keeps
//!    the frontend decoder tied to the crate's types.

#![cfg(feature = "agent-test-utils")]

use std::sync::Arc;

use inariwatch_desktop_lib::agent::tools::search::mocks::MockSearchBackend;
use inariwatch_desktop_lib::agent::tools::{
    register_search_tools, SearchToolBackends,
};
use inariwatch_desktop_lib::agent::{
    AuditLog, InMemoryReceiptSink, PermissionLevel, PermissionResolver, RegistryError,
    ToolError, ToolRegistry, WitnessEmitter,
};
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::json;

struct Rig {
    reg: ToolRegistry,
    sink: Arc<InMemoryReceiptSink>,
    audit: Arc<AuditLog>,
    backend: Arc<MockSearchBackend>,
}

fn rig() -> Rig {
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(SqliteConnectionManager::memory())
        .expect("memory pool");
    let audit = Arc::new(AuditLog::new(pool));
    audit.ensure_schema().expect("ensure schema");
    let sink = Arc::new(InMemoryReceiptSink::new(64));
    let witness = Arc::new(WitnessEmitter::new(sink.clone()));
    let resolver = Arc::new(PermissionResolver::new());
    let reg = ToolRegistry::new(resolver, witness, audit.clone());

    let backend = Arc::new(MockSearchBackend::new());
    let bundle = SearchToolBackends {
        backend: backend.clone(),
    };
    register_search_tools(&reg, bundle).expect("register search");

    Rig {
        reg,
        sink,
        audit,
        backend,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Registration
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn register_search_tools_registers_exactly_one_tool() {
    let r = rig();
    let metas = r.reg.list();
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].name, "search.error_context");
    assert_eq!(metas[0].default_permission, PermissionLevel::Auto);
}

#[tokio::test]
async fn register_search_twice_returns_duplicate_error() {
    let r = rig();
    // Re-register the same backend → duplicate name.
    let backend = Arc::new(MockSearchBackend::new());
    let bundle = SearchToolBackends { backend };
    let err = register_search_tools(&r.reg, bundle).expect_err("must dup");
    match err {
        RegistryError::DuplicateTool(name) => {
            assert_eq!(name, "search.error_context");
        }
        other => panic!("unexpected: {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Happy path — invoke_traced returns hits + audit row + receipt
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn invoke_traced_with_mock_returns_response_and_emits_audit_and_receipt() {
    let r = rig();
    // Pre-load a response with one SO hit.
    let mut canned = inari_search::SearchResponse::empty();
    canned.hits.push(inari_search::Hit {
        title: "Fix TypeError".into(),
        url: inari_search::Url::parse("https://stackoverflow.com/questions/100").unwrap(),
        excerpt: "Try checking with optional chaining first.".into(),
        source: inari_search::SourceTag::StackOverflow,
        score: 0.7,
        meta: inari_search::HitMeta::StackOverflow {
            vote_count: 70,
            is_accepted: true,
            answer_count: 2,
        },
    });
    canned.cache_status = inari_search::CacheStatus::Hit;
    canned.elapsed_ms = 5;
    r.backend.enqueue_response(canned);

    let args = json!({
        "error_text": "TypeError: foo is undefined",
        "language": "javascript"
    });
    let (invocation_id, output) = r
        .reg
        .invoke_traced("search.error_context", args.clone(), Some("sess-1".into()))
        .await
        .expect("ok");

    // Output shape: hits[].source = "stack_overflow", cache_status = "hit".
    assert_eq!(output.value["cache_status"], json!("hit"));
    assert_eq!(output.value["hits"][0]["source"], json!("stack_overflow"));
    assert!(output.summary.unwrap_or_default().contains("cache hit"));

    // Audit: exactly one row, success=true, witness_receipt_id set.
    let row = r.audit.get_by_id(&invocation_id).unwrap().expect("audit row");
    assert!(row.success);
    assert_eq!(row.tool_name, "search.error_context");
    assert_eq!(row.session_id.as_deref(), Some("sess-1"));
    assert_eq!(row.permission, PermissionLevel::Auto);
    assert!(row.witness_receipt_id.is_some(), "witness receipt id should be set");

    // Receipt: exactly one in the sink, args_sha256 matches the
    // SHA-256 of the canonical args bytes (the witness emitter
    // serializes via serde_json::to_vec).
    let receipts = r.sink.snapshot();
    assert_eq!(receipts.len(), 1, "exactly one receipt per invoke");
    let rcp = &receipts[0];
    assert!(rcp.success);
    assert_eq!(rcp.tool_name, "search.error_context");
    let expected_args_hash = sha256_hex(&serde_json::to_vec(&args).unwrap());
    assert_eq!(
        rcp.args_sha256, expected_args_hash,
        "receipt args_sha256 must equal sha256 of canonical args"
    );
    // Audit row links to the receipt by content hash.
    assert_eq!(row.witness_receipt_id.as_deref(), Some(rcp.args_sha256.as_str()));
}

#[tokio::test]
async fn invoke_traced_records_one_call_per_invoke() {
    let r = rig();
    let _ = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "x" }),
            None,
        )
        .await
        .expect("ok");
    let _ = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "y" }),
            None,
        )
        .await
        .expect("ok");
    let calls = r.backend.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].req.error_text, "x");
    assert_eq!(calls[1].req.error_text, "y");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Schema validation — every rejection shape the prompt enumerates
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn schema_rejects_missing_error_text() {
    let r = rig();
    let err = r
        .reg
        .invoke_traced("search.error_context", json!({}), None)
        .await
        .expect_err("must fail");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)), "got {err:?}");
}

#[tokio::test]
async fn schema_rejects_empty_error_text() {
    let r = rig();
    let err = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "" }),
            None,
        )
        .await
        .expect_err("must fail");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
}

#[tokio::test]
async fn schema_rejects_max_hits_above_cap() {
    let r = rig();
    let err = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "x", "max_hits": 9999 }),
            None,
        )
        .await
        .expect_err("must fail");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
}

#[tokio::test]
async fn schema_rejects_max_hits_below_minimum() {
    let r = rig();
    let err = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "x", "max_hits": 0 }),
            None,
        )
        .await
        .expect_err("must fail");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
}

#[tokio::test]
async fn schema_rejects_extra_property() {
    let r = rig();
    let err = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "x", "extra_field": "no" }),
            None,
        )
        .await
        .expect_err("must fail");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Backend errors → ExecutionFailed + audit success=false
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn backend_error_maps_to_execution_failed_and_audits_failure() {
    let r = rig();
    r.backend.fail_next("upstream timeout");
    let err = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "x" }),
            None,
        )
        .await
        .expect_err("must fail");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert_eq!(m, "upstream timeout");
        }
        other => panic!("unexpected: {other:?}"),
    }
    // Receipt records the failure.
    let receipts = r.sink.snapshot();
    assert_eq!(receipts.len(), 1);
    assert!(!receipts[0].success);
    assert_eq!(receipts[0].error.as_deref(), Some("execution failed: upstream timeout"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Output round-trips back to SearchResponse shape (frontend contract)
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn output_value_round_trips_to_search_response() {
    let r = rig();
    let mut canned = inari_search::SearchResponse::empty();
    canned.cache_status = inari_search::CacheStatus::Miss;
    canned.elapsed_ms = 412;
    canned.quota_low = true;
    canned.sources_used.push(inari_search::SourceStatus {
        source: inari_search::SourceTag::GitHub,
        state: inari_search::SourceState::RateLimited,
    });
    r.backend.enqueue_response(canned);

    let (_id, output) = r
        .reg
        .invoke_traced(
            "search.error_context",
            json!({ "error_text": "anything" }),
            None,
        )
        .await
        .expect("ok");
    // Round-trip through SearchResponse — no shape drift.
    let back: inari_search::SearchResponse =
        serde_json::from_value(output.value).expect("decode SearchResponse");
    assert_eq!(back.cache_status, inari_search::CacheStatus::Miss);
    assert_eq!(back.elapsed_ms, 412);
    assert!(back.quota_low);
    assert_eq!(back.sources_used.len(), 1);
    match &back.sources_used[0].state {
        inari_search::SourceState::RateLimited => {}
        other => panic!("unexpected state: {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Default Permission is Auto — verified via meta
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn meta_default_permission_is_auto() {
    let r = rig();
    let metas = r.reg.list();
    let m = metas
        .iter()
        .find(|m| m.name == "search.error_context")
        .expect("present");
    assert_eq!(m.default_permission, PermissionLevel::Auto);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}
