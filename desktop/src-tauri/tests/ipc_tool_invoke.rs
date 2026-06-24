//! S6 — integration tests for the chat-agent tool-invocation IPC.
//!
//! These tests drive the registry through the same wrapper functions
//! the IPC commands call — `desktop_tool_invoke`'s `map_registry_result`
//! and the public `agent::ToolRegistry::invoke_traced` /
//! `invoke_traced_confirmed` methods. We don't actually mount Tauri
//! state here (that's exercised in `cargo tauri dev` smoke); the
//! integration layer's job is to assert the **wire shape** the chat
//! surface depends on, plus the audit-row + receipt persistence
//! contract.
//!
//! Coverage:
//!
//! - `Auto`-level tool: end-to-end → `Output { invocation_id, ... }`,
//!   one audit row + one receipt persisted.
//! - `Confirm`-level tool: first call returns `RequiresConfirm`, no
//!   audit row written. `invoke_traced_confirmed` then writes the
//!   canonical row.
//! - Unknown tool name: error path the IPC surfaces as IpcError.
//! - `desktop_tool_catalog` (via `catalog_all()`): the 15 registered
//!   tool names appear in cluster registration order.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use inariwatch_desktop_lib::agent::tools::catalog_all;
use inariwatch_desktop_lib::agent::{
    AuditLog, ChatTool, InMemoryReceiptSink, PermissionLevel, PermissionResolver, RegistryError,
    ToolError, ToolInvocation, ToolMeta, ToolOutput, ToolRegistry, WitnessEmitter,
};
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::{json, Value};

struct TestTool {
    meta: ToolMeta,
    calls: Arc<AtomicUsize>,
    outcome: Outcome,
}

enum Outcome {
    Echo,
    Fail(String),
}

#[async_trait]
impl ChatTool for TestTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match &self.outcome {
            Outcome::Echo => Ok(ToolOutput {
                value: json!({ "ok": true, "args": invocation.args }),
                summary: Some(format!("called {}", invocation.tool_name)),
            }),
            Outcome::Fail(msg) => Err(ToolError::ExecutionFailed(msg.clone())),
        }
    }
}

fn build_rig() -> (
    Arc<ToolRegistry>,
    Arc<InMemoryReceiptSink>,
    Arc<AuditLog>,
    Arc<PermissionResolver>,
) {
    let manager = SqliteConnectionManager::memory();
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(manager)
        .expect("memory pool");
    let audit = Arc::new(AuditLog::new(pool));
    audit.ensure_schema().expect("ensure schema");
    let sink = Arc::new(InMemoryReceiptSink::new(16));
    let witness = Arc::new(WitnessEmitter::new(sink.clone()));
    let resolver = Arc::new(PermissionResolver::new());
    let reg = Arc::new(ToolRegistry::new(resolver.clone(), witness, audit.clone()));
    (reg, sink, audit, resolver)
}

fn register_tool(
    reg: &ToolRegistry,
    name: &str,
    perm: PermissionLevel,
    outcome: Outcome,
) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    let tool = Arc::new(TestTool {
        meta: ToolMeta {
            name: name.into(),
            description: format!("test tool {name}"),
            params_schema: json!({
                "type": "object",
                "properties": { "k": { "type": "string" } },
                "required": ["k"]
            }),
            default_permission: perm,
        },
        calls: calls.clone(),
        outcome,
    });
    reg.register(tool).expect("register");
    calls
}

#[tokio::test]
async fn invoke_traced_auto_tool_persists_audit_row_and_returns_invocation_id() {
    let (reg, sink, audit, _res) = build_rig();
    let _calls = register_tool(&reg, "desktop.read_file", PermissionLevel::Auto, Outcome::Echo);

    let (invocation_id, output) = reg
        .invoke_traced(
            "desktop.read_file",
            json!({ "k": "v" }),
            Some("session-int".into()),
        )
        .await
        .expect("invoke ok");

    // Wire shape: invocation_id is a non-empty hex (UUID v4 simple).
    assert!(invocation_id.len() >= 16, "invocation id looks short: {invocation_id}");
    // Output carries the structured payload the IPC turns into ToolOutputDto.
    assert_eq!(output.value["ok"], json!(true));
    assert_eq!(output.summary.as_deref(), Some("called desktop.read_file"));

    // Persistence: one audit row keyed by the same id we got back.
    assert_eq!(audit.count().unwrap(), 1);
    let row = audit.get_by_id(&invocation_id).unwrap().expect("row present");
    assert_eq!(row.id, invocation_id);
    assert!(row.success);
    assert_eq!(row.tool_name, "desktop.read_file");
    assert!(row.witness_receipt_id.is_some());
    // One receipt published; sink len asserts the contract.
    assert_eq!(sink.len(), 1);
}

#[tokio::test]
async fn invoke_traced_confirm_tool_short_circuits_then_invoke_confirmed_runs() {
    let (reg, sink, audit, _res) = build_rig();
    let calls = register_tool(
        &reg,
        "local.run_shell",
        PermissionLevel::Confirm,
        Outcome::Echo,
    );

    // First invoke must return RequiresConfirm. No audit row, no receipt.
    let err = reg
        .invoke_traced("local.run_shell", json!({ "k": "ls" }), None)
        .await
        .expect_err("must short-circuit");
    assert!(matches!(err, RegistryError::RequiresConfirm));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(audit.count().unwrap(), 0);
    assert_eq!(sink.len(), 0);

    // Second call (confirmed) actually runs and writes the canonical row.
    let (invocation_id, _out) = reg
        .invoke_traced_confirmed("local.run_shell", json!({ "k": "ls" }), None)
        .await
        .expect("ok");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(audit.count().unwrap(), 1);
    let row = audit.get_by_id(&invocation_id).unwrap().expect("row");
    assert_eq!(row.permission, PermissionLevel::Confirm);
}

#[tokio::test]
async fn invoke_traced_unknown_tool_returns_unknown_tool_error() {
    let (reg, _sink, audit, _res) = build_rig();
    let err = reg
        .invoke_traced("nope.ghost", json!({}), None)
        .await
        .expect_err("must fail");
    assert!(matches!(err, RegistryError::UnknownTool(s) if s == "nope.ghost"));
    // Pure short-circuit at lookup — no audit row.
    assert_eq!(audit.count().unwrap(), 0);
}

#[tokio::test]
async fn invoke_traced_denied_tool_audits_failure_and_returns_permission_denied() {
    let (reg, sink, audit, resolver) = build_rig();
    let calls = register_tool(&reg, "desktop.notify", PermissionLevel::Auto, Outcome::Echo);
    resolver.set_override("desktop.notify", PermissionLevel::Deny);

    let err = reg
        .invoke_traced("desktop.notify", json!({ "k": "boom" }), None)
        .await
        .expect_err("must deny");
    assert!(matches!(err, RegistryError::PermissionDenied));
    // The audit row is written (so the user has a paper trail of the denial).
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(audit.count().unwrap(), 1);
    assert_eq!(sink.len(), 1);
    let row = audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
    assert_eq!(row.permission, PermissionLevel::Deny);
}

#[tokio::test]
async fn execute_failure_audits_a_failure_row_with_error_text() {
    let (reg, sink, audit, _res) = build_rig();
    let calls = register_tool(
        &reg,
        "local.run_shell",
        PermissionLevel::Auto,
        Outcome::Fail("ENOENT".into()),
    );

    let err = reg
        .invoke_traced("local.run_shell", json!({ "k": "ls" }), None)
        .await
        .expect_err("must fail");
    assert!(matches!(
        err,
        RegistryError::Tool(ToolError::ExecutionFailed(_))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(audit.count().unwrap(), 1);
    assert_eq!(sink.len(), 1);
    let row = audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
    assert!(row.error.unwrap().contains("ENOENT"));
}

#[test]
fn catalog_all_returns_the_15_canonical_tool_names_in_cluster_order() {
    // S3 (6) → S4 (6) → S5 (3). The chat surface relies on this stable
    // order to render the LLM-side prompt deterministically.
    let metas = catalog_all();
    let names: Vec<&str> = metas.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            // S3 — desktop_os
            "desktop.open_in_editor",
            "desktop.open_url",
            "desktop.read_clipboard",
            "desktop.write_clipboard",
            "desktop.notify",
            "desktop.focus_window",
            // S4 — local_exec
            "local.run_shell",
            "local.read_file",
            "local.write_file",
            "local.run_test",
            "local.git_status",
            "local.git_diff",
            // S5 — comm
            "comm.send_whatsapp",
            "comm.send_telegram",
            "comm.send_slack",
        ]
    );
    assert_eq!(metas.len(), 15);
}

#[test]
fn catalog_all_metadata_fields_are_non_empty() {
    // Wire-shape guard: the IPC turns each ToolMeta into a ToolMetaDto
    // with the same fields. Anything blank means the LLM gets a tool
    // it can't reason about.
    for m in catalog_all() {
        assert!(!m.name.is_empty(), "tool with empty name");
        assert!(!m.description.is_empty(), "{} missing description", m.name);
        assert!(
            m.params_schema.is_object(),
            "{} schema is not an object",
            m.name
        );
        // params_schema must have a `type` field (every concrete tool's
        // schema is an object), so the LLM can validate args against
        // it before round-tripping.
        let schema_obj: &Value = &m.params_schema;
        assert!(
            schema_obj.get("type").is_some(),
            "{} schema missing 'type'",
            m.name
        );
    }
}
