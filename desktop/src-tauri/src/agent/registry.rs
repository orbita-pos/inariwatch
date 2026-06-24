//! Orchestrator that holds [`ChatTool`] implementations, walks the full
//! invoke pipeline, and ships the audit trail to the audit log + the
//! Witness sidecar.
//!
//! Pipeline (per `invoke()` call):
//!
//! 1. **Lookup** — fail with `RegistryError::UnknownTool` if missing.
//! 2. **Schema validate** — args vs `ToolMeta::params_schema`. Fail
//!    with `RegistryError::SchemaInvalid` (and persist a row marking
//!    `success = false`).
//! 3. **Permission decide** — `Auto → Allow`, `Confirm →
//!    RequiresConfirm` (short-circuit), `Deny → Denied`. The
//!    `RequiresConfirm` short-circuit returns immediately so the chat
//!    surface (S6+) can raise a UI prompt; once approved, it
//!    re-invokes through `invoke_confirmed()` which skips the gate.
//! 4. **Witness open** — hashes args + records `started_at`.
//! 5. **`tool.execute()`** — the actual side effect.
//! 6. **Witness close** — hashes result, records `finished_at`,
//!    persists the receipt to the sink.
//! 7. **Audit insert** — one row in `tool_invocations`.
//!
//! Steps 4-7 also run when `execute()` returns `Err(_)` so failures
//! land in the audit trail. Steps 1-3 produce audit rows on their own
//! failure paths too — the only thing that doesn't emit a row is a
//! `RequiresConfirm` short-circuit (the chat surface re-invokes via
//! `invoke_confirmed()`, which DOES audit, so we stay one-row-per
//! eventual-decision).
//!
//! [`ChatTool`]: super::ChatTool

use jsonschema::JSONSchema;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use uuid::Uuid;

use super::{
    AuditEntry, AuditError, AuditLog, ChatTool, PermissionDecision, PermissionLevel,
    PermissionResolver, ToolError, ToolInvocation, ToolMeta, ToolOutput, WitnessEmitter,
    WitnessReceipt,
};

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    #[error("duplicate tool: {0}")]
    DuplicateTool(String),
    #[error("permission denied")]
    PermissionDenied,
    #[error("requires confirmation")]
    RequiresConfirm,
    #[error("schema validation failed: {0}")]
    SchemaInvalid(String),
    #[error("invalid schema: {0}")]
    SchemaCompile(String),
    #[error("audit: {0}")]
    Audit(#[from] AuditError),
    #[error(transparent)]
    Tool(#[from] ToolError),
}

/// In-memory tool table + invoke pipeline. One per chat agent.
pub struct ToolRegistry {
    tools: RwLock<HashMap<String, Arc<dyn ChatTool>>>,
    permission: Arc<PermissionResolver>,
    witness: Arc<WitnessEmitter>,
    audit: Arc<AuditLog>,
}

impl ToolRegistry {
    pub fn new(
        permission: Arc<PermissionResolver>,
        witness: Arc<WitnessEmitter>,
        audit: Arc<AuditLog>,
    ) -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            permission,
            witness,
            audit,
        }
    }

    /// Register a tool. Errors if the name is already taken — the
    /// registry rejects shadowing on purpose so concrete tools can't
    /// silently override one another at boot.
    pub fn register(&self, tool: Arc<dyn ChatTool>) -> Result<(), RegistryError> {
        let name = tool.meta().name.clone();
        let mut map = self.tools.write().expect("registry tools lock poisoned");
        if map.contains_key(&name) {
            return Err(RegistryError::DuplicateTool(name));
        }
        map.insert(name, tool);
        Ok(())
    }

    /// Unregister and return the tool if present. Used by skill-pack
    /// hot-reload + tests.
    pub fn unregister(&self, name: &str) -> Option<Arc<dyn ChatTool>> {
        let mut map = self.tools.write().expect("registry tools lock poisoned");
        map.remove(name)
    }

    /// Snapshot of every tool's metadata. Cheap to clone.
    pub fn list(&self) -> Vec<ToolMeta> {
        self.tools
            .read()
            .map(|m| m.values().map(|t| t.meta().clone()).collect())
            .unwrap_or_default()
    }

    /// True if `name` is registered.
    pub fn has(&self, name: &str) -> bool {
        self.tools
            .read()
            .map(|m| m.contains_key(name))
            .unwrap_or(false)
    }

    /// Full invoke pipeline. Returns `RequiresConfirm` immediately for
    /// `Confirm`-level tools — the chat surface raises a UI prompt
    /// and re-invokes via [`Self::invoke_confirmed`] once approved.
    pub async fn invoke(
        &self,
        tool_name: &str,
        args: Value,
        session_id: Option<String>,
    ) -> Result<ToolOutput, RegistryError> {
        self.invoke_inner(tool_name, args, session_id, false, "agent")
            .await
            .map(|(_, out)| out)
    }

    /// Variant called after the UI has shown a confirmation prompt and
    /// the user approved. Skips the permission gate entirely (the UI
    /// is the gate at that point).
    pub async fn invoke_confirmed(
        &self,
        tool_name: &str,
        args: Value,
        session_id: Option<String>,
    ) -> Result<ToolOutput, RegistryError> {
        self.invoke_inner(tool_name, args, session_id, true, "agent")
            .await
            .map(|(_, out)| out)
    }

    /// Same as [`Self::invoke`] but additionally returns the registry's
    /// invocation id. The IPC layer (S6) keeps this so the chat
    /// surface can drive the witness verifier modal directly against
    /// the audit-row id (the modal does
    /// `desktop_audit_get(invocation_id)` + `desktop_audit_verify`).
    pub async fn invoke_traced(
        &self,
        tool_name: &str,
        args: Value,
        session_id: Option<String>,
    ) -> Result<(String, ToolOutput), RegistryError> {
        self.invoke_inner(tool_name, args, session_id, false, "agent").await
    }

    /// `invoke_traced` after a UI confirmation. Same trace semantics as
    /// [`Self::invoke_confirmed`] — skips the permission gate entirely.
    pub async fn invoke_traced_confirmed(
        &self,
        tool_name: &str,
        args: Value,
        session_id: Option<String>,
    ) -> Result<(String, ToolOutput), RegistryError> {
        self.invoke_inner(tool_name, args, session_id, true, "agent").await
    }

    /// `invoke_traced` for a user-typed slash command. Bypasses the
    /// `Confirm` gate (the typing IS the consent) but **respects** the
    /// `Deny` override from Settings → Permissions (Option A from the
    /// trust-ladder design discussion). The audit row records
    /// `source = "slash"` so the chain reflects who initiated the
    /// invoke. Note: the Witness receipt itself does not carry the
    /// source; attribution lives only in the audit row.
    pub async fn invoke_traced_via_slash(
        &self,
        tool_name: &str,
        args: Value,
        session_id: Option<String>,
    ) -> Result<(String, ToolOutput), RegistryError> {
        // Read the tool's default_permission so the Deny check uses
        // the same default the LLM-driven path would. UnknownTool
        // surfaces here cleanly without bothering invoke_inner.
        let default_perm = self
            .tools
            .read()
            .ok()
            .and_then(|m| m.get(tool_name).map(|t| t.meta().default_permission))
            .ok_or_else(|| RegistryError::UnknownTool(tool_name.to_string()))?;

        let effective = self
            .permission
            .effective_level(tool_name, default_perm);

        // Slash bypasses Confirm but NOT Deny. When the user has
        // explicitly set Deny in Settings, we route through
        // `confirmed=false` so the existing Deny path runs the
        // permission_decision audit row. The IPC layer translates
        // `RegistryError::PermissionDenied` into a friendly
        // "this tool is set to Deny — change it in Settings" toast.
        let confirmed = effective != PermissionLevel::Deny;
        self.invoke_inner(tool_name, args, session_id, confirmed, "slash")
            .await
    }

    async fn invoke_inner(
        &self,
        tool_name: &str,
        args: Value,
        session_id: Option<String>,
        confirmed: bool,
        source: &str,
    ) -> Result<(String, ToolOutput), RegistryError> {
        let tool = self
            .tools
            .read()
            .ok()
            .and_then(|m| m.get(tool_name).cloned())
            .ok_or_else(|| RegistryError::UnknownTool(tool_name.to_string()))?;

        let meta = tool.meta().clone();
        let invocation_id = Uuid::new_v4().simple().to_string();
        let effective_perm = self
            .permission
            .effective_level(&meta.name, meta.default_permission);
        let decision = if confirmed {
            // `invoke_confirmed` bypasses the gate but we still record
            // what the resolver would have said for the audit trail.
            PermissionDecision::Allow
        } else {
            self.permission.decide(&meta.name, meta.default_permission)
        };

        // Permission short-circuits.
        match decision {
            PermissionDecision::Denied => {
                let started = self.witness.open(&args);
                let receipt = self.witness.close(
                    invocation_id.clone(),
                    meta.name.clone(),
                    session_id.clone(),
                    started,
                    None,
                    effective_perm,
                    false,
                    Some("permission denied".into()),
                );
                self.persist_audit(
                    &invocation_id,
                    &meta.name,
                    &session_id,
                    &args,
                    None,
                    effective_perm,
                    decision,
                    Some(&receipt),
                    false,
                    Some("permission denied"),
                    source,
                )?;
                return Err(RegistryError::PermissionDenied);
            }
            PermissionDecision::RequiresConfirm => {
                // Do NOT audit yet — `invoke_confirmed` will write the
                // canonical row when the UI re-enters the pipeline.
                return Err(RegistryError::RequiresConfirm);
            }
            PermissionDecision::Allow => {}
        }

        // Schema validation. Compile failures and validation failures
        // both audit so the user has a paper trail of "model emitted
        // bad args, here's why".
        if let Err(reason) = validate_schema(&meta.params_schema, &args) {
            let started = self.witness.open(&args);
            let receipt = self.witness.close(
                invocation_id.clone(),
                meta.name.clone(),
                session_id.clone(),
                started,
                None,
                effective_perm,
                false,
                Some(format!("schema invalid: {reason}")),
            );
            self.persist_audit(
                &invocation_id,
                &meta.name,
                &session_id,
                &args,
                None,
                effective_perm,
                decision,
                Some(&receipt),
                false,
                Some(&format!("schema invalid: {reason}")),
                source,
            )?;
            return Err(RegistryError::SchemaInvalid(reason));
        }

        // Witness open + execute + close.
        let invocation = ToolInvocation {
            id: invocation_id.clone(),
            tool_name: meta.name.clone(),
            args: args.clone(),
            session_id: session_id.clone(),
        };
        let opened = self.witness.open(&args);
        let exec_result = tool.execute(&invocation).await;

        match exec_result {
            Ok(output) => {
                let receipt = self.witness.close(
                    invocation_id.clone(),
                    meta.name.clone(),
                    session_id.clone(),
                    opened,
                    Some(&output.value),
                    effective_perm,
                    true,
                    None,
                );
                self.persist_audit(
                    &invocation_id,
                    &meta.name,
                    &session_id,
                    &args,
                    Some(&output.value),
                    effective_perm,
                    decision,
                    Some(&receipt),
                    true,
                    None,
                    source,
                )?;
                Ok((invocation_id, output))
            }
            Err(err) => {
                let err_msg = err.to_string();
                let receipt = self.witness.close(
                    invocation_id.clone(),
                    meta.name.clone(),
                    session_id.clone(),
                    opened,
                    None,
                    effective_perm,
                    false,
                    Some(err_msg.clone()),
                );
                self.persist_audit(
                    &invocation_id,
                    &meta.name,
                    &session_id,
                    &args,
                    None,
                    effective_perm,
                    decision,
                    Some(&receipt),
                    false,
                    Some(&err_msg),
                    source,
                )?;
                Err(RegistryError::Tool(err))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn persist_audit(
        &self,
        id: &str,
        tool_name: &str,
        session_id: &Option<String>,
        args: &Value,
        result: Option<&Value>,
        permission: PermissionLevel,
        decision: PermissionDecision,
        receipt: Option<&WitnessReceipt>,
        success: bool,
        error: Option<&str>,
        source: &str,
    ) -> Result<(), RegistryError> {
        let entry = AuditEntry {
            id: id.to_string(),
            tool_name: tool_name.to_string(),
            session_id: session_id.clone(),
            args_json: args.to_string(),
            result_json: result.map(|v| v.to_string()),
            permission,
            permission_decision: decision,
            // Content-addressed link: receipt's args_sha256 is the same
            // bytes the chat surface (S6) and the EAP attestor will see.
            witness_receipt_id: receipt.map(|r| r.args_sha256.clone()),
            started_at_ms: receipt.map(|r| r.started_at_ms).unwrap_or(0),
            finished_at_ms: receipt.map(|r| r.finished_at_ms).unwrap_or(0),
            success,
            error: error.map(str::to_owned),
            source: source.to_string(),
        };
        self.audit.insert(&entry)?;
        Ok(())
    }
}

/// Validate `args` against `schema`. Returns a human-readable error
/// string suitable for the chat surface ("missing required `path`")
/// rather than the raw `jsonschema` Error type so callers don't have
/// to lifetime-juggle.
fn validate_schema(schema: &Value, args: &Value) -> Result<(), String> {
    let compiled = JSONSchema::options()
        .compile(schema)
        .map_err(|e| format!("invalid schema: {e}"))?;
    if let Err(errors) = compiled.validate(args) {
        // Take the first error — the model only needs one hint to retry.
        let mut iter = errors;
        if let Some(first) = iter.next() {
            return Err(format!("{first}"));
        }
        return Err("validation failed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::witness::InMemoryReceiptSink;
    use async_trait::async_trait;
    use r2d2_sqlite::SqliteConnectionManager;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn pool() -> crate::store::SqlitePool {
        let manager = SqliteConnectionManager::memory();
        r2d2::Pool::builder()
            .max_size(1)
            .build(manager)
            .expect("memory pool")
    }

    /// Configurable tool used across registry tests.
    struct MockTool {
        meta: ToolMeta,
        calls: Arc<AtomicUsize>,
        outcome: MockOutcome,
    }

    #[derive(Clone)]
    enum MockOutcome {
        Ok(Value),
        Err(String),
    }

    impl MockTool {
        fn new(name: &str, perm: PermissionLevel, outcome: MockOutcome) -> (Self, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            (
                MockTool {
                    meta: ToolMeta {
                        name: name.into(),
                        description: format!("mock {name}"),
                        params_schema: json!({
                            "type": "object",
                            "properties": { "path": { "type": "string" } },
                            "required": ["path"]
                        }),
                        default_permission: perm,
                    },
                    calls: calls.clone(),
                    outcome,
                },
                calls,
            )
        }
    }

    #[async_trait]
    impl ChatTool for MockTool {
        fn meta(&self) -> &ToolMeta {
            &self.meta
        }
        async fn execute(
            &self,
            _invocation: &ToolInvocation,
        ) -> Result<ToolOutput, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match &self.outcome {
                MockOutcome::Ok(v) => Ok(ToolOutput {
                    value: v.clone(),
                    summary: None,
                }),
                MockOutcome::Err(msg) => Err(ToolError::ExecutionFailed(msg.clone())),
            }
        }
    }

    fn rig() -> (
        ToolRegistry,
        Arc<InMemoryReceiptSink>,
        Arc<AuditLog>,
        Arc<PermissionResolver>,
    ) {
        let sink: Arc<InMemoryReceiptSink> = Arc::new(InMemoryReceiptSink::new(64));
        let witness = Arc::new(WitnessEmitter::new(sink.clone()));
        let audit = Arc::new(AuditLog::new(pool()));
        audit.ensure_schema().expect("schema");
        let resolver = Arc::new(PermissionResolver::new());
        let reg = ToolRegistry::new(resolver.clone(), witness, audit.clone());
        (reg, sink, audit, resolver)
    }

    #[test]
    fn register_rejects_duplicate_name() {
        let (reg, _sink, _audit, _res) = rig();
        let (a, _) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({"ok": true})),
        );
        let (b, _) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({"ok": true})),
        );
        reg.register(Arc::new(a)).expect("first");
        let err = reg.register(Arc::new(b)).expect_err("second must fail");
        assert!(matches!(err, RegistryError::DuplicateTool(name) if name == "desktop.read_file"));
    }

    #[tokio::test]
    async fn invoke_unknown_tool_returns_unknown_tool() {
        let (reg, _sink, _audit, _res) = rig();
        let err = reg
            .invoke("nope", json!({}), None)
            .await
            .expect_err("must fail");
        assert!(matches!(err, RegistryError::UnknownTool(s) if s == "nope"));
    }

    #[tokio::test]
    async fn invoke_with_bad_args_returns_schema_invalid_and_audits() {
        let (reg, sink, audit, _res) = rig();
        let (tool, calls) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({"ok": true})),
        );
        reg.register(Arc::new(tool)).unwrap();
        let err = reg
            .invoke("desktop.read_file", json!({}), None)
            .await
            .expect_err("must fail");
        assert!(matches!(err, RegistryError::SchemaInvalid(_)));
        // execute() must not have been called.
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // One audit row + one receipt for the failure.
        assert_eq!(audit.count().unwrap(), 1);
        let row = audit.list_recent(1).unwrap().pop().unwrap();
        assert!(!row.success);
        assert!(row.error.unwrap().contains("schema invalid"));
        assert_eq!(sink.len(), 1);
    }

    #[tokio::test]
    async fn auto_permission_runs_end_to_end_with_one_receipt_and_one_audit_row() {
        let (reg, sink, audit, _res) = rig();
        let (tool, calls) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({"data": "hello"})),
        );
        reg.register(Arc::new(tool)).unwrap();
        let out = reg
            .invoke(
                "desktop.read_file",
                json!({ "path": "/tmp/x" }),
                Some("session-1".into()),
            )
            .await
            .expect("ok");
        assert_eq!(out.value, json!({"data": "hello"}));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(sink.len(), 1);
        assert_eq!(audit.count().unwrap(), 1);
        let row = audit.list_recent(1).unwrap().pop().unwrap();
        assert!(row.success);
        assert_eq!(row.tool_name, "desktop.read_file");
        assert_eq!(row.session_id.as_deref(), Some("session-1"));
        assert_eq!(row.permission, PermissionLevel::Auto);
        assert_eq!(row.permission_decision, PermissionDecision::Allow);
        assert!(row.witness_receipt_id.is_some());
    }

    #[tokio::test]
    async fn confirm_permission_short_circuits_with_requires_confirm() {
        let (reg, sink, audit, _res) = rig();
        let (tool, calls) = MockTool::new(
            "local.run_shell",
            PermissionLevel::Confirm,
            MockOutcome::Ok(json!({"ok": true})),
        );
        reg.register(Arc::new(tool)).unwrap();
        let err = reg
            .invoke("local.run_shell", json!({ "path": "ls" }), None)
            .await
            .expect_err("must short-circuit");
        assert!(matches!(err, RegistryError::RequiresConfirm));
        // execute() must not have run.
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // No audit row: invoke_confirmed will write the canonical one.
        assert_eq!(audit.count().unwrap(), 0);
        assert_eq!(sink.len(), 0);
    }

    #[tokio::test]
    async fn invoke_confirmed_runs_skipping_the_permission_gate() {
        let (reg, sink, audit, _res) = rig();
        let (tool, calls) = MockTool::new(
            "local.run_shell",
            PermissionLevel::Confirm,
            MockOutcome::Ok(json!({"stdout": "hi"})),
        );
        reg.register(Arc::new(tool)).unwrap();
        let out = reg
            .invoke_confirmed("local.run_shell", json!({ "path": "ls" }), None)
            .await
            .expect("ok");
        assert_eq!(out.value, json!({"stdout": "hi"}));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(sink.len(), 1);
        assert_eq!(audit.count().unwrap(), 1);
        let row = audit.list_recent(1).unwrap().pop().unwrap();
        assert!(row.success);
        assert_eq!(row.permission, PermissionLevel::Confirm);
        assert_eq!(row.permission_decision, PermissionDecision::Allow);
    }

    #[tokio::test]
    async fn deny_permission_records_failure_and_returns_denied() {
        let (reg, sink, audit, resolver) = rig();
        let (tool, calls) = MockTool::new(
            "comm.dangerous",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({})),
        );
        reg.register(Arc::new(tool)).unwrap();
        // User overrides the tool's default to Deny.
        resolver.set_override("comm.dangerous", PermissionLevel::Deny);
        let err = reg
            .invoke("comm.dangerous", json!({ "path": "x" }), None)
            .await
            .expect_err("must deny");
        assert!(matches!(err, RegistryError::PermissionDenied));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(sink.len(), 1);
        let row = audit.list_recent(1).unwrap().pop().unwrap();
        assert!(!row.success);
        assert_eq!(row.permission, PermissionLevel::Deny);
        assert_eq!(row.permission_decision, PermissionDecision::Denied);
        assert_eq!(row.error.as_deref(), Some("permission denied"));
    }

    #[tokio::test]
    async fn execute_failure_still_emits_receipt_and_audit_row() {
        let (reg, sink, audit, _res) = rig();
        let (tool, calls) = MockTool::new(
            "local.run_shell",
            PermissionLevel::Auto,
            MockOutcome::Err("boom".into()),
        );
        reg.register(Arc::new(tool)).unwrap();
        let err = reg
            .invoke_confirmed("local.run_shell", json!({ "path": "ls" }), None)
            .await
            .expect_err("must fail");
        match err {
            RegistryError::Tool(ToolError::ExecutionFailed(m)) => assert_eq!(m, "boom"),
            other => panic!("unexpected: {other}"),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(sink.len(), 1);
        assert_eq!(audit.count().unwrap(), 1);
        let row = audit.list_recent(1).unwrap().pop().unwrap();
        assert!(!row.success);
        assert!(row.error.unwrap().contains("boom"));
    }

    #[tokio::test]
    async fn list_returns_metadata_for_every_registered_tool() {
        let (reg, _sink, _audit, _res) = rig();
        let (a, _) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({})),
        );
        let (b, _) = MockTool::new(
            "local.run_shell",
            PermissionLevel::Confirm,
            MockOutcome::Ok(json!({})),
        );
        reg.register(Arc::new(a)).unwrap();
        reg.register(Arc::new(b)).unwrap();
        let metas = reg.list();
        assert_eq!(metas.len(), 2);
        let names: std::collections::HashSet<_> = metas.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains("desktop.read_file"));
        assert!(names.contains("local.run_shell"));
    }

    #[tokio::test]
    async fn invoke_traced_returns_invocation_id_matching_audit_row() {
        let (reg, _sink, audit, _res) = rig();
        let (tool, _calls) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({"data": "hello"})),
        );
        reg.register(Arc::new(tool)).unwrap();
        let (invocation_id, out) = reg
            .invoke_traced(
                "desktop.read_file",
                json!({ "path": "/tmp/x" }),
                Some("session-traced".into()),
            )
            .await
            .expect("ok");
        assert_eq!(out.value, json!({"data": "hello"}));
        // The id we got back must point at the persisted audit row.
        let row = audit.get_by_id(&invocation_id).unwrap().expect("row");
        assert_eq!(row.id, invocation_id);
        assert_eq!(row.tool_name, "desktop.read_file");
        assert_eq!(row.session_id.as_deref(), Some("session-traced"));
    }

    #[tokio::test]
    async fn invoke_traced_confirmed_returns_id_and_skips_gate() {
        let (reg, _sink, audit, _res) = rig();
        let (tool, calls) = MockTool::new(
            "local.run_shell",
            PermissionLevel::Confirm,
            MockOutcome::Ok(json!({"stdout": "hi"})),
        );
        reg.register(Arc::new(tool)).unwrap();
        let (invocation_id, _out) = reg
            .invoke_traced_confirmed("local.run_shell", json!({ "path": "ls" }), None)
            .await
            .expect("ok");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let row = audit.get_by_id(&invocation_id).unwrap().expect("row");
        assert_eq!(row.permission, PermissionLevel::Confirm);
        assert_eq!(row.permission_decision, PermissionDecision::Allow);
    }

    #[tokio::test]
    async fn unregister_removes_the_tool() {
        let (reg, _sink, _audit, _res) = rig();
        let (a, _) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({})),
        );
        reg.register(Arc::new(a)).unwrap();
        assert!(reg.has("desktop.read_file"));
        let removed = reg.unregister("desktop.read_file");
        assert!(removed.is_some());
        assert!(!reg.has("desktop.read_file"));
    }

    #[tokio::test]
    async fn concurrent_invokes_record_distinct_audit_rows() {
        let (reg, sink, audit, _res) = rig();
        let (tool, calls) = MockTool::new(
            "desktop.read_file",
            PermissionLevel::Auto,
            MockOutcome::Ok(json!({"ok": true})),
        );
        let reg = Arc::new(reg);
        reg.register(Arc::new(tool)).unwrap();

        let mut handles = Vec::new();
        for i in 0..16 {
            let r = reg.clone();
            handles.push(tokio::spawn(async move {
                r.invoke(
                    "desktop.read_file",
                    json!({ "path": format!("/tmp/{i}") }),
                    Some(format!("session-{}", i % 4)),
                )
                .await
            }));
        }
        for h in handles {
            h.await.unwrap().expect("invoke ok");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 16);
        assert_eq!(audit.count().unwrap(), 16);
        assert_eq!(sink.len(), 16);
        // Every audit row should have a unique invocation id.
        let rows = audit.list_recent(64).unwrap();
        let ids: std::collections::HashSet<_> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids.len(), 16, "invocation ids must be unique");
    }
}
