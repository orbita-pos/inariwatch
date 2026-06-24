//! Integration tests for the Desktop OS tool cluster (S3).
//!
//! Drives the full registry pipeline (lookup → schema validate →
//! permission → witness open → execute → witness close → audit
//! insert) for each of the six tools through `Mock*Backend`s. We do
//! NOT spin up a Tauri runtime — the backend trait seam is the whole
//! reason these tests can run headless on CI.
//!
//! What we lock here:
//!
//! 1. `register_desktop_os_tools` registers exactly seven tools without
//!    name collisions.
//! 2. Per-tool end-to-end through `invoke_confirmed`: success path
//!    audits one row + emits one receipt with `success = true`.
//! 3. `desktop.open_url`'s `^https?://` pattern in the JSON Schema
//!    rejects `file:` / `javascript:` / `data:` payloads at the
//!    registry level — execute() is never reached, an audit row
//!    records the schema failure.
//! 4. The clipboard tools share one backend so write → read round
//!    trips through one buffer.

use std::sync::Arc;

use inariwatch_desktop_lib::agent::tools::{
    register_desktop_os_tools, ClipboardBackend, DesktopOsBackends, EditorBackend, FinderBackend,
    MockClipboardBackend, MockEditorBackend, MockFinderBackend, MockNotifyBackend,
    MockUrlOpenerBackend, MockWindowFocusBackend, NotifyBackend, UrlOpenerBackend,
    WindowFocusBackend,
};
use inariwatch_desktop_lib::agent::{
    AuditLog, InMemoryReceiptSink, PermissionDecision, PermissionLevel, PermissionResolver,
    RegistryError, ToolRegistry, WitnessEmitter,
};
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::json;

struct Rig {
    reg: ToolRegistry,
    sink: Arc<InMemoryReceiptSink>,
    audit: Arc<AuditLog>,
    editor: Arc<MockEditorBackend>,
    url_opener: Arc<MockUrlOpenerBackend>,
    finder: Arc<MockFinderBackend>,
    clipboard: Arc<MockClipboardBackend>,
    notify: Arc<MockNotifyBackend>,
    window_focus: Arc<MockWindowFocusBackend>,
}

fn rig() -> Rig {
    let manager = SqliteConnectionManager::memory();
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(manager)
        .expect("memory pool");
    let audit = Arc::new(AuditLog::new(pool));
    audit.ensure_schema().expect("ensure schema");
    let sink = Arc::new(InMemoryReceiptSink::new(64));
    let witness = Arc::new(WitnessEmitter::new(sink.clone()));
    let resolver = Arc::new(PermissionResolver::new());
    let reg = ToolRegistry::new(resolver, witness, audit.clone());

    let editor = Arc::new(MockEditorBackend::new());
    let url_opener = Arc::new(MockUrlOpenerBackend::new());
    let finder = Arc::new(MockFinderBackend::new());
    let clipboard = Arc::new(MockClipboardBackend::new());
    let notify = Arc::new(MockNotifyBackend::new());
    let window_focus = Arc::new(MockWindowFocusBackend::new());

    // Field types on `DesktopOsBackends` are `Arc<dyn …Backend>`, so
    // each `Arc<MockX>` coerces in place via unsized-coercion. Same
    // Arc on the clipboard bundle slot so the read + write tools
    // share one buffer — that is the whole reason the round-trip
    // test works.
    let editor_dyn: Arc<dyn EditorBackend> = editor.clone();
    let url_opener_dyn: Arc<dyn UrlOpenerBackend> = url_opener.clone();
    let finder_dyn: Arc<dyn FinderBackend> = finder.clone();
    let clipboard_dyn: Arc<dyn ClipboardBackend> = clipboard.clone();
    let notify_dyn: Arc<dyn NotifyBackend> = notify.clone();
    let window_focus_dyn: Arc<dyn WindowFocusBackend> = window_focus.clone();
    let backends = DesktopOsBackends {
        editor: editor_dyn,
        url_opener: url_opener_dyn,
        finder: finder_dyn,
        clipboard: clipboard_dyn,
        notify: notify_dyn,
        window_focus: window_focus_dyn,
    };
    register_desktop_os_tools(&reg, backends).expect("register");

    Rig {
        reg,
        sink,
        audit,
        editor,
        url_opener,
        finder,
        clipboard,
        notify,
        window_focus,
    }
}

#[test]
fn register_desktop_os_tools_registers_seven_without_collision() {
    let r = rig();
    let metas = r.reg.list();
    assert_eq!(metas.len(), 7, "expected seven tools, got {}", metas.len());
    let names: std::collections::HashSet<_> = metas.iter().map(|m| m.name.as_str()).collect();
    for expected in [
        "desktop.open_in_editor",
        "desktop.open_url",
        "desktop.open_finder",
        "desktop.read_clipboard",
        "desktop.write_clipboard",
        "desktop.notify",
        "desktop.focus_window",
    ] {
        assert!(names.contains(expected), "missing tool {expected}");
    }
}

#[test]
fn register_desktop_os_tools_advertises_expected_default_permissions() {
    let r = rig();
    let by_name: std::collections::HashMap<_, _> = r
        .reg
        .list()
        .into_iter()
        .map(|m| (m.name.clone(), m.default_permission))
        .collect();
    assert_eq!(
        by_name["desktop.open_in_editor"],
        PermissionLevel::Confirm
    );
    assert_eq!(by_name["desktop.open_url"], PermissionLevel::Confirm);
    assert_eq!(by_name["desktop.open_finder"], PermissionLevel::Confirm);
    assert_eq!(by_name["desktop.read_clipboard"], PermissionLevel::Auto);
    assert_eq!(
        by_name["desktop.write_clipboard"],
        PermissionLevel::Confirm
    );
    assert_eq!(by_name["desktop.notify"], PermissionLevel::Auto);
    assert_eq!(by_name["desktop.focus_window"], PermissionLevel::Confirm);
}

#[tokio::test]
async fn open_in_editor_invoke_confirmed_audits_success_row_and_receipt() {
    let r = rig();
    let out = r
        .reg
        .invoke_confirmed(
            "desktop.open_in_editor",
            json!({ "path": "/tmp/x.rs", "line": 7 }),
            Some("session-edit".into()),
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));
    assert_eq!(r.editor.calls(), vec![("/tmp/x.rs".into(), Some(7))]);

    assert_eq!(r.sink.len(), 1);
    let row = r
        .audit
        .list_recent(10)
        .expect("list")
        .pop()
        .expect("audit row");
    assert!(row.success);
    assert_eq!(row.tool_name, "desktop.open_in_editor");
    assert_eq!(row.permission, PermissionLevel::Confirm);
    assert_eq!(row.permission_decision, PermissionDecision::Allow);
    assert!(row.witness_receipt_id.is_some());
}

#[tokio::test]
async fn open_finder_invoke_confirmed_audits_success_row_and_receipt() {
    let r = rig();
    let out = r
        .reg
        .invoke_confirmed(
            "desktop.open_finder",
            json!({ "path": "./exports" }),
            Some("session-finder".into()),
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));
    assert_eq!(r.finder.calls(), vec!["./exports".to_string()]);

    let row = r
        .audit
        .list_recent(10)
        .expect("list")
        .pop()
        .expect("audit row");
    assert!(row.success);
    assert_eq!(row.tool_name, "desktop.open_finder");
    assert_eq!(row.permission, PermissionLevel::Confirm);
    assert_eq!(row.permission_decision, PermissionDecision::Allow);
}

#[tokio::test]
async fn open_url_invoke_confirmed_audits_success_row_and_receipt() {
    let r = rig();
    r.reg
        .invoke_confirmed(
            "desktop.open_url",
            json!({ "url": "https://app.inariwatch.com" }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(
        r.url_opener.calls(),
        vec!["https://app.inariwatch.com".to_string()]
    );
    assert_eq!(r.sink.len(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "desktop.open_url");
}

/// The schema's `^https?://` pattern lives on `params_schema` — the
/// registry's `validate_schema()` rejects non-http payloads BEFORE
/// `execute()` runs, audits a `success = false` row, and never calls
/// the backend.
#[tokio::test]
async fn open_url_schema_rejects_non_http_at_registry_level() {
    for hostile in [
        json!({ "url": "file:///etc/passwd" }),
        json!({ "url": "javascript:alert(1)" }),
        json!({ "url": "data:text/html,<h1>x" }),
        json!({ "url": "ftp://example.com/" }),
    ] {
        let r = rig();
        let err = r
            .reg
            .invoke_confirmed("desktop.open_url", hostile.clone(), None)
            .await
            .expect_err("must reject");
        match err {
            RegistryError::SchemaInvalid(_) => {}
            other => panic!("expected SchemaInvalid for {hostile}, got {other:?}"),
        }
        // Backend was not reached.
        assert!(r.url_opener.calls().is_empty(), "backend must not run");
        // One failure row + one receipt for the failure.
        assert_eq!(r.sink.len(), 1);
        let row = r.audit.list_recent(1).unwrap().pop().unwrap();
        assert!(!row.success);
        assert!(row.error.unwrap().contains("schema invalid"));
    }
}

#[tokio::test]
async fn read_clipboard_invoke_audits_success_with_backend_text() {
    let r = rig();
    r.clipboard.write_text("hello").expect("seed");
    let out = r
        .reg
        .invoke_confirmed("desktop.read_clipboard", json!({}), None)
        .await
        .expect("ok");
    assert_eq!(out.value["text"], json!("hello"));
    assert_eq!(r.sink.len(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "desktop.read_clipboard");
}

#[tokio::test]
async fn write_then_read_clipboard_round_trips_through_one_backend() {
    let r = rig();
    r.reg
        .invoke_confirmed(
            "desktop.write_clipboard",
            json!({ "text": "hello" }),
            None,
        )
        .await
        .expect("write ok");
    let out = r
        .reg
        .invoke_confirmed("desktop.read_clipboard", json!({}), None)
        .await
        .expect("read ok");
    assert_eq!(out.value["text"], json!("hello"));
    assert_eq!(r.clipboard.snapshot(), "hello");

    // Two invokes → two audit rows + two receipts.
    assert_eq!(r.sink.len(), 2);
    assert_eq!(r.audit.count().unwrap(), 2);
}

#[tokio::test]
async fn notify_invoke_confirmed_forwards_title_and_body() {
    let r = rig();
    r.reg
        .invoke_confirmed(
            "desktop.notify",
            json!({ "title": "Build", "body": "green" }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(
        r.notify.calls(),
        vec![("Build".to_string(), "green".to_string())]
    );
    assert_eq!(r.sink.len(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
}

#[tokio::test]
async fn focus_window_invoke_confirmed_forwards_name() {
    let r = rig();
    r.reg
        .invoke_confirmed(
            "desktop.focus_window",
            json!({ "name": "Code" }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(r.window_focus.calls(), vec!["Code".to_string()]);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "desktop.focus_window");
    assert_eq!(row.permission, PermissionLevel::Confirm);
}

/// Backend errors must surface as `ToolError::ExecutionFailed` with
/// the original message preserved, AND the audit row + receipt must
/// land marked `success = false` with the message in `error`.
#[tokio::test]
async fn backend_failure_audits_failure_row_with_preserved_message() {
    let r = rig();
    r.editor.fail_next("editor not found");
    let err = r
        .reg
        .invoke_confirmed(
            "desktop.open_in_editor",
            json!({ "path": "/tmp/x.rs" }),
            None,
        )
        .await
        .expect_err("must fail");
    match err {
        RegistryError::Tool(inner) => {
            assert!(format!("{inner}").contains("editor not found"));
        }
        other => panic!("expected Tool error, got {other:?}"),
    }
    assert_eq!(r.sink.len(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
    assert!(row.error.unwrap().contains("editor not found"));
}
