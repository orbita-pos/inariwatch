//! Integration suite for the comm tool cluster (S5).
//!
//! Drives the **full registry pipeline** (lookup → schema validate →
//! permission gate → witness open → execute → witness close → audit
//! insert) for every shape the spec calls out. Backends are mocks
//! from `agent::tools::comm::mocks` (feature-gated behind
//! `agent-test-utils`).
//!
//! What we lock here:
//!
//! 1. `register_comm_tools` registers exactly three tools with no
//!    name collisions, including no overlap with the S3 / S4 clusters.
//! 2. End-to-end happy path through every tool — exactly one audit row +
//!    one receipt with `success = true` per call.
//! 3. Schema rejects (one per shape, exactly the cases the spec
//!    enumerates):
//!      - `send_whatsapp` `to: "1234"` (no `+`) → SchemaInvalid.
//!      - `send_whatsapp` `to: "+1abc"` → SchemaInvalid.
//!      - `send_whatsapp` `message: ""` → SchemaInvalid.
//!      - `send_telegram` no `chat_id` → SchemaInvalid.
//!      - `send_telegram` `parse_mode: "Markdown"` (legacy) → SchemaInvalid.
//!      - `send_slack` no `text` and no `blocks` → SchemaInvalid (anyOf).
//!      - `send_slack` `channel: "alerts"` (bare name) → SchemaInvalid.
//! 4. Backend errors:
//!      - WhatsApp sidecar offline → ExecutionFailed, audit row
//!        `success=false`, receipt with `error` populated.
//!      - Telegram 401 → ExecutionFailed("desktop auth required: …").
//!      - Slack 429 → ExecutionFailed with the upstream message.

#![cfg(feature = "agent-test-utils")]

use std::sync::Arc;

use inariwatch_desktop_lib::agent::tools::comm::mocks::{
    mock_backends, MockSlackBackend, MockTelegramBackend, MockWhatsAppBackend,
};
use inariwatch_desktop_lib::agent::tools::{
    register_comm_tools, register_desktop_os_tools, register_local_exec_tools, DesktopOsBackends,
    MockClipboardBackend, MockEditorBackend, MockNotifyBackend, MockUrlOpenerBackend,
    MockWindowFocusBackend,
};
use inariwatch_desktop_lib::agent::{
    AuditLog, InMemoryReceiptSink, PermissionLevel, PermissionResolver, RegistryError, ToolError,
    ToolRegistry, WitnessEmitter,
};
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::json;

struct Rig {
    reg: ToolRegistry,
    sink: Arc<InMemoryReceiptSink>,
    audit: Arc<AuditLog>,
    whatsapp: Arc<MockWhatsAppBackend>,
    telegram: Arc<MockTelegramBackend>,
    slack: Arc<MockSlackBackend>,
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

    let (bundle, whatsapp, telegram, slack) = mock_backends();
    register_comm_tools(&reg, bundle).expect("register comm");

    Rig {
        reg,
        sink,
        audit,
        whatsapp,
        telegram,
        slack,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. register_comm_tools registers three distinct tools, no collisions with
//    desktop_os (S3) / local_exec (S4) clusters.
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn register_comm_tools_registers_three_tools_with_expected_metas() {
    let r = rig();
    let metas = r.reg.list();
    assert_eq!(metas.len(), 3);
    let by_name: std::collections::HashMap<_, _> = metas
        .into_iter()
        .map(|m| (m.name.clone(), m.default_permission))
        .collect();
    assert_eq!(by_name["comm.send_whatsapp"], PermissionLevel::Confirm);
    assert_eq!(by_name["comm.send_telegram"], PermissionLevel::Confirm);
    assert_eq!(by_name["comm.send_slack"], PermissionLevel::Confirm);
}

#[tokio::test]
async fn comm_tools_do_not_collide_with_desktop_os_or_local_exec_clusters() {
    // Build a registry holding all three clusters' tools — if any
    // name overlaps, `register` returns DuplicateTool and the test
    // fails. The use of MockX backends here is incidental: we just
    // need *something* that satisfies the trait.
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .build(SqliteConnectionManager::memory())
        .expect("memory pool");
    let audit = Arc::new(AuditLog::new(pool));
    audit.ensure_schema().expect("ensure schema");
    let sink = Arc::new(InMemoryReceiptSink::new(64));
    let witness = Arc::new(WitnessEmitter::new(sink));
    let resolver = Arc::new(PermissionResolver::new());
    let reg = ToolRegistry::new(resolver, witness, audit);

    // S3 — desktop_os.
    let desktop_bundle = DesktopOsBackends {
        editor: Arc::new(MockEditorBackend::new()),
        url_opener: Arc::new(MockUrlOpenerBackend::new()),
        clipboard: Arc::new(MockClipboardBackend::new()),
        notify: Arc::new(MockNotifyBackend::new()),
        window_focus: Arc::new(MockWindowFocusBackend::new()),
    };
    register_desktop_os_tools(&reg, desktop_bundle).expect("register desktop_os");

    // S4 — local_exec. Reuse the cluster's own mock_backends helper
    // so we don't import its internals here.
    let (local_bundle, _shell, _fs, _git) =
        inariwatch_desktop_lib::agent::tools::local_exec::mocks::mock_backends(
            std::path::PathBuf::from("/ws/repo"),
        );
    register_local_exec_tools(&reg, local_bundle).expect("register local_exec");

    // S5 — comm.
    let (comm_bundle, _w, _t, _s) = mock_backends();
    register_comm_tools(&reg, comm_bundle).expect("register comm");

    // 6 (S3) + 6 (S4) + 3 (S5) = 15.
    assert_eq!(reg.list().len(), 15, "all three clusters should coexist");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. End-to-end happy path per tool — registry runs to completion, exactly
//    one audit row + one receipt with success=true per invocation.
// ─────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn send_whatsapp_e2e_records_one_audit_row_and_receipt_on_success() {
    let r = rig();
    let out = r
        .reg
        .invoke_confirmed(
            "comm.send_whatsapp",
            json!({ "to": "+5215551234567", "message": "hi from agent" }),
            Some("session-1".into()),
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));
    assert_eq!(out.value["to"], json!("+5215551234567"));

    let calls = r.whatsapp.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].to, "+5215551234567");
    assert_eq!(calls[0].message, "hi from agent");

    assert_eq!(r.sink.len(), 1);
    assert_eq!(r.audit.count().unwrap(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "comm.send_whatsapp");
    assert!(row.witness_receipt_id.is_some());
}

#[tokio::test]
async fn send_telegram_e2e_records_one_audit_row_and_receipt_on_success() {
    let r = rig();
    let out = r
        .reg
        .invoke_confirmed(
            "comm.send_telegram",
            json!({
                "chat_id": "@inari-alerts",
                "text": "build green",
                "parse_mode": "MarkdownV2"
            }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));

    let calls = r.telegram.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].text, "build green");
    assert_eq!(calls[0].parse_mode.as_deref(), Some("MarkdownV2"));

    assert_eq!(r.sink.len(), 1);
    assert_eq!(r.audit.count().unwrap(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "comm.send_telegram");
}

#[tokio::test]
async fn send_slack_e2e_records_one_audit_row_and_receipt_on_success() {
    let r = rig();
    let blocks = json!([{ "type": "section", "text": { "type": "mrkdwn", "text": "deploy" } }]);
    let out = r
        .reg
        .invoke_confirmed(
            "comm.send_slack",
            json!({ "channel": "#alerts", "text": "deploy green", "blocks": blocks }),
            None,
        )
        .await
        .expect("ok");
    assert_eq!(out.value["ok"], json!(true));

    let calls = r.slack.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].channel, "#alerts");
    assert_eq!(calls[0].text.as_deref(), Some("deploy green"));
    assert_eq!(calls[0].blocks, Some(blocks));

    assert_eq!(r.sink.len(), 1);
    assert_eq!(r.audit.count().unwrap(), 1);
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(row.success);
    assert_eq!(row.tool_name, "comm.send_slack");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Schema rejects — one per spec'd shape. Backend must NOT have run.
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn send_whatsapp_rejects_to_without_leading_plus() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_whatsapp",
            json!({ "to": "1234", "message": "hi" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(
        matches!(err, RegistryError::SchemaInvalid(_)),
        "unexpected: {err:?}"
    );
    assert!(r.whatsapp.calls().is_empty());
}

#[tokio::test]
async fn send_whatsapp_rejects_to_with_non_digit_after_plus() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_whatsapp",
            json!({ "to": "+1abc", "message": "hi" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
    assert!(r.whatsapp.calls().is_empty());
}

#[tokio::test]
async fn send_whatsapp_rejects_empty_message() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_whatsapp",
            json!({ "to": "+15551234567", "message": "" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
    assert!(r.whatsapp.calls().is_empty());
}

#[tokio::test]
async fn send_telegram_rejects_missing_chat_id() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_telegram",
            json!({ "text": "hi" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(matches!(err, RegistryError::SchemaInvalid(_)));
    assert!(r.telegram.calls().is_empty());
}

#[tokio::test]
async fn send_telegram_rejects_legacy_markdown_parse_mode() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_telegram",
            json!({ "chat_id": "@x", "text": "hi", "parse_mode": "Markdown" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(
        matches!(err, RegistryError::SchemaInvalid(_)),
        "unexpected: {err:?}"
    );
    assert!(r.telegram.calls().is_empty());
}

#[tokio::test]
async fn send_slack_rejects_anyof_neither_text_nor_blocks() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_slack",
            json!({ "channel": "#alerts" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(
        matches!(err, RegistryError::SchemaInvalid(_)),
        "anyOf(text, blocks) should reject when neither is present; got: {err:?}"
    );
    assert!(r.slack.calls().is_empty());
}

#[tokio::test]
async fn send_slack_rejects_bare_channel_name_without_prefix() {
    let r = rig();
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_slack",
            json!({ "channel": "alerts", "text": "hi" }),
            None,
        )
        .await
        .expect_err("must reject");
    assert!(
        matches!(err, RegistryError::SchemaInvalid(_)),
        "channel pattern should reject bare names; got: {err:?}"
    );
    assert!(r.slack.calls().is_empty());
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Backend errors → ExecutionFailed, audit row success=false, receipt
//    has the error message preserved.
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn whatsapp_sidecar_offline_audits_failure_row_and_receipt() {
    let r = rig();
    r.whatsapp.fail_next("sidecar not running");
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_whatsapp",
            json!({ "to": "+15551234567", "message": "x" }),
            None,
        )
        .await
        .expect_err("must fail");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert_eq!(m, "sidecar not running");
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
    assert!(row.error.unwrap().contains("sidecar not running"));
    // Witness receipt should still have been emitted.
    assert_eq!(r.sink.len(), 1);
}

#[tokio::test]
async fn telegram_unauthorized_surfaces_clean_message() {
    let r = rig();
    // What the production TauriTelegramBackend would emit on 401.
    r.telegram.fail_next("desktop auth required: run /login first");
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_telegram",
            json!({ "chat_id": "@x", "text": "hi" }),
            None,
        )
        .await
        .expect_err("must fail");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("desktop auth required"),
                "expected the auth-required message; got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
}

#[tokio::test]
async fn slack_rate_limit_preserves_upstream_message() {
    let r = rig();
    r.slack
        .fail_next("desktop_slack_send: HTTP 429: rate limited");
    let err = r
        .reg
        .invoke_confirmed(
            "comm.send_slack",
            json!({ "channel": "C1", "text": "hi" }),
            None,
        )
        .await
        .expect_err("must fail");
    match err {
        RegistryError::Tool(ToolError::ExecutionFailed(m)) => {
            assert!(
                m.contains("HTTP 429"),
                "rate-limit message should surface upstream status; got: {m}"
            );
        }
        other => panic!("expected Tool(ExecutionFailed), got {other:?}"),
    }
    let row = r.audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
    assert!(row.error.unwrap().contains("HTTP 429"));
}
