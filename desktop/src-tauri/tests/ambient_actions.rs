//! S7 — integration test for the ambient-action dispatcher.
//!
//! Drives `notifications::handle_ambient_action` through the same
//! public surface a real Tauri menu callback would: a `ToolRegistry`
//! seeded with the `desktop_os` cluster against mock backends, plus
//! an `AuditLog` against an in-memory pool. The four `AmbientAction`
//! variants get exercised end-to-end:
//!
//! - `OpenInEditor` → `desktop.open_in_editor` audit row, success=true.
//! - `FixWithAi` / `Investigate` → no audit row, prefill captured.
//! - `Ignore` → `ambient.dismiss_alert` audit row.
//!
//! The `Denied` short-circuit is also covered — a user override that
//! flips `desktop.open_in_editor` to `Deny` must surface as
//! `AmbientError::Denied` (not as a tool error or a permission gate
//! short-circuit, both of which would render incorrectly in the
//! ambient surface UI).

use std::sync::{Arc, Mutex};

use inariwatch_desktop_lib::agent::tools::{
    register_desktop_os_tools, DesktopOsBackends, MockClipboardBackend, MockEditorBackend,
    MockNotifyBackend, MockUrlOpenerBackend, MockWindowFocusBackend,
};
use inariwatch_desktop_lib::agent::{
    AuditLog, InMemoryReceiptSink, PermissionLevel, PermissionResolver, ToolRegistry,
    WitnessEmitter,
};
use inariwatch_desktop_lib::notifications::{
    handle_ambient_action, AmbientAction, AmbientActionDeps, AmbientError, PrefillPayload,
    AMBIENT_SESSION_CONTEXT, AMBIENT_SESSION_TOAST, AMBIENT_SESSION_TRAY,
};
use r2d2_sqlite::SqliteConnectionManager;

fn pool() -> inariwatch_desktop_lib::store::SqlitePool {
    let manager = SqliteConnectionManager::memory();
    r2d2::Pool::builder()
        .max_size(1)
        .build(manager)
        .expect("memory pool")
}

fn rig() -> (Arc<ToolRegistry>, Arc<AuditLog>, Arc<PermissionResolver>) {
    let resolver = Arc::new(PermissionResolver::new());
    let sink: Arc<InMemoryReceiptSink> = Arc::new(InMemoryReceiptSink::new(64));
    let witness = Arc::new(WitnessEmitter::new(sink));
    let audit = Arc::new(AuditLog::new(pool()));
    audit.ensure_schema().expect("ensure schema");

    let registry = Arc::new(ToolRegistry::new(
        resolver.clone(),
        witness,
        audit.clone(),
    ));
    let backends = DesktopOsBackends {
        editor: Arc::new(MockEditorBackend::new()),
        url_opener: Arc::new(MockUrlOpenerBackend::new()),
        clipboard: Arc::new(MockClipboardBackend::new()),
        notify: Arc::new(MockNotifyBackend::new()),
        window_focus: Arc::new(MockWindowFocusBackend::new()),
    };
    register_desktop_os_tools(&registry, backends).expect("register");
    (registry, audit, resolver)
}

#[allow(clippy::type_complexity)]
fn capture_emit() -> (
    impl Fn(&PrefillPayload) -> Result<(), String> + Send + Sync,
    Arc<Mutex<Vec<PrefillPayload>>>,
) {
    let captured: Arc<Mutex<Vec<PrefillPayload>>> = Arc::new(Mutex::new(Vec::new()));
    let captured_clone = captured.clone();
    let emit = move |p: &PrefillPayload| -> Result<(), String> {
        captured_clone.lock().unwrap().push(p.clone());
        Ok(())
    };
    (emit, captured)
}

#[tokio::test]
async fn open_in_editor_invokes_tool_and_audits_with_ambient_session_id() {
    let (registry, audit, _res) = rig();
    let (emit, _captured) = capture_emit();
    let deps = AmbientActionDeps {
        registry: &registry,
        audit: &audit,
        emit_prefill: emit,
    };

    handle_ambient_action(
        AmbientAction::OpenInEditor {
            file: "/srv/app/server.js".into(),
            line: Some(42),
        },
        &deps,
        AMBIENT_SESSION_TOAST,
    )
    .await
    .expect("ok");

    let row = audit.list_recent(1).unwrap().pop().expect("row");
    assert_eq!(row.tool_name, "desktop.open_in_editor");
    assert_eq!(row.session_id.as_deref(), Some("ambient-toast"));
    assert!(row.args_json.contains("/srv/app/server.js"));
    assert!(row.args_json.contains("42"));
    assert!(row.success);
}

#[tokio::test]
async fn fix_with_ai_emits_prefill_payload_without_auditing() {
    let (registry, audit, _res) = rig();
    let (emit, captured) = capture_emit();
    let deps = AmbientActionDeps {
        registry: &registry,
        audit: &audit,
        emit_prefill: emit,
    };

    handle_ambient_action(
        AmbientAction::FixWithAi {
            alert_id: "a-99".into(),
            prefill: "Fix this alert please".into(),
        },
        &deps,
        AMBIENT_SESSION_TRAY,
    )
    .await
    .expect("ok");

    let payloads = captured.lock().unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(payloads[0].alert_id, "a-99");
    assert_eq!(payloads[0].text, "Fix this alert please");
    assert_eq!(audit.count().unwrap(), 0, "no audit row for prefill");
}

#[tokio::test]
async fn investigate_emits_prefill_with_distinct_text() {
    let (registry, audit, _res) = rig();
    let (emit, captured) = capture_emit();
    let deps = AmbientActionDeps {
        registry: &registry,
        audit: &audit,
        emit_prefill: emit,
    };

    handle_ambient_action(
        AmbientAction::Investigate {
            alert_id: "a-100".into(),
            prefill: "Why did this fail?".into(),
        },
        &deps,
        AMBIENT_SESSION_CONTEXT,
    )
    .await
    .expect("ok");

    let payloads = captured.lock().unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(payloads[0].text, "Why did this fail?");
}

#[tokio::test]
async fn ignore_appends_dismissal_row_without_witness_receipt() {
    let (registry, audit, _res) = rig();
    let (emit, _captured) = capture_emit();
    let deps = AmbientActionDeps {
        registry: &registry,
        audit: &audit,
        emit_prefill: emit,
    };

    handle_ambient_action(
        AmbientAction::Ignore {
            alert_id: "a-101".into(),
        },
        &deps,
        AMBIENT_SESSION_TOAST,
    )
    .await
    .expect("ok");

    let row = audit.list_recent(1).unwrap().pop().expect("row");
    assert_eq!(row.tool_name, "ambient.dismiss_alert");
    assert!(row.success);
    assert!(row.args_json.contains("a-101"));
    assert!(
        row.witness_receipt_id.is_none(),
        "dismissal is UI-only, no witness receipt"
    );
    assert_eq!(row.session_id.as_deref(), Some("ambient-toast"));
}

#[tokio::test]
async fn open_in_editor_returns_denied_when_user_overrides_to_deny() {
    let (registry, audit, resolver) = rig();
    resolver.set_override("desktop.open_in_editor", PermissionLevel::Deny);

    let (emit, _captured) = capture_emit();
    let deps = AmbientActionDeps {
        registry: &registry,
        audit: &audit,
        emit_prefill: emit,
    };

    let err = handle_ambient_action(
        AmbientAction::OpenInEditor {
            file: "/srv/x.rs".into(),
            line: None,
        },
        &deps,
        AMBIENT_SESSION_TOAST,
    )
    .await
    .expect_err("must deny");

    match err {
        AmbientError::Denied { tool } => {
            assert_eq!(tool, "desktop.open_in_editor");
        }
        other => panic!("expected Denied, got {other:?}"),
    }
}

#[tokio::test]
async fn open_in_editor_without_line_omits_line_arg() {
    let (registry, audit, _res) = rig();
    let (emit, _captured) = capture_emit();
    let deps = AmbientActionDeps {
        registry: &registry,
        audit: &audit,
        emit_prefill: emit,
    };

    handle_ambient_action(
        AmbientAction::OpenInEditor {
            file: "/srv/x.rs".into(),
            line: None,
        },
        &deps,
        AMBIENT_SESSION_TRAY,
    )
    .await
    .expect("ok");

    let row = audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.args_json.contains("\"line\""));
    assert_eq!(row.session_id.as_deref(), Some("ambient-tray"));
}
