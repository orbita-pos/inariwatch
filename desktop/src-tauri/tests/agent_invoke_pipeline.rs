//! Integration test exercising the full `ToolRegistry` invoke pipeline
//! through the public surface re-exported at `crate::agent::*`.
//!
//! The unit tests inside the module already cover the same scenarios in
//! depth; this test lives at the integration layer to lock the **public
//! API shape** for the next 9 sessions. If S3-S5 / S11 change the
//! external surface (rename / drop a re-export / change a signature),
//! they break here first.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use inariwatch_desktop_lib::agent::{
    AuditLog, ChatTool, InMemoryReceiptSink, PermissionDecision, PermissionLevel,
    PermissionResolver, RegistryError, ToolError, ToolInvocation, ToolMeta, ToolOutput,
    ToolRegistry, WitnessEmitter,
};
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::json;

struct Counter {
    meta: ToolMeta,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl ChatTool for Counter {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, _invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput {
            value: json!({ "ok": true, "calls": self.calls.load(Ordering::SeqCst) }),
            summary: Some("counter ticked".into()),
        })
    }
}

fn build_rig() -> (
    ToolRegistry,
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
    let reg = ToolRegistry::new(resolver.clone(), witness, audit.clone());
    (reg, sink, audit, resolver)
}

fn counter(name: &str, perm: PermissionLevel) -> (Arc<Counter>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let tool = Arc::new(Counter {
        meta: ToolMeta {
            name: name.into(),
            description: "integration test counter".into(),
            params_schema: json!({
                "type": "object",
                "properties": { "key": { "type": "string" } },
                "required": ["key"]
            }),
            default_permission: perm,
        },
        calls: calls.clone(),
    });
    (tool, calls)
}

#[tokio::test]
async fn auto_invoke_runs_end_to_end_through_public_api() {
    let (reg, sink, audit, _res) = build_rig();
    let (tool, calls) = counter("desktop.read_file", PermissionLevel::Auto);
    reg.register(tool).expect("register");

    let out = reg
        .invoke(
            "desktop.read_file",
            json!({ "key": "/tmp/x" }),
            Some("session-int".into()),
        )
        .await
        .expect("invoke ok");

    assert_eq!(out.value["ok"], json!(true));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(sink.len(), 1);

    let rows = audit.list_by_session("session-int").expect("list");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert!(row.success);
    assert_eq!(row.tool_name, "desktop.read_file");
    assert_eq!(row.permission, PermissionLevel::Auto);
    assert_eq!(row.permission_decision, PermissionDecision::Allow);
    assert!(row.witness_receipt_id.is_some());
}

#[tokio::test]
async fn confirm_then_invoke_confirmed_audits_one_row_per_eventual_decision() {
    let (reg, sink, audit, _res) = build_rig();
    let (tool, calls) = counter("local.run_shell", PermissionLevel::Confirm);
    reg.register(tool).expect("register");

    // First call short-circuits without auditing.
    let err = reg
        .invoke("local.run_shell", json!({ "key": "ls" }), None)
        .await
        .expect_err("must require confirm");
    assert!(matches!(err, RegistryError::RequiresConfirm));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(audit.count().expect("count"), 0);
    assert_eq!(sink.len(), 0);

    // After the UI confirms, the canonical row lands.
    let _out = reg
        .invoke_confirmed("local.run_shell", json!({ "key": "ls" }), None)
        .await
        .expect("ok");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(audit.count().expect("count"), 1);
    let row = audit.list_recent(1).expect("list").pop().unwrap();
    assert!(row.success);
    assert_eq!(row.permission, PermissionLevel::Confirm);
    assert_eq!(row.permission_decision, PermissionDecision::Allow);
}

#[tokio::test]
async fn schema_invalid_args_audit_a_failure_row_without_executing() {
    let (reg, sink, audit, _res) = build_rig();
    let (tool, calls) = counter("desktop.read_file", PermissionLevel::Auto);
    reg.register(tool).expect("register");

    let err = reg
        .invoke("desktop.read_file", json!({}), None)
        .await
        .expect_err("must reject");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(sink.len(), 1);
    let row = audit.list_recent(1).expect("list").pop().unwrap();
    assert!(!row.success);
    assert!(row.error.unwrap().contains("schema invalid"));
}

#[tokio::test]
async fn list_returns_every_registered_tool_via_public_api() {
    let (reg, _sink, _audit, _res) = build_rig();
    let (a, _) = counter("desktop.read_file", PermissionLevel::Auto);
    let (b, _) = counter("local.run_shell", PermissionLevel::Confirm);
    reg.register(a).unwrap();
    reg.register(b).unwrap();

    let metas = reg.list();
    assert_eq!(metas.len(), 2);
    let names: std::collections::HashSet<_> = metas.iter().map(|m| m.name.as_str()).collect();
    assert!(names.contains("desktop.read_file"));
    assert!(names.contains("local.run_shell"));
}
