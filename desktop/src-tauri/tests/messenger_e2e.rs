//! S8 — messenger gateway end-to-end with a mock LLM + mock channel.
//!
//! Drives the full inbound→AI→tool→outbound pipeline without real
//! Baileys / OpenAI involvement so the contract is provable in CI.
//! Required-features: `agent-test-utils`.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::json;
use tokio::sync::broadcast;
use uuid::Uuid;

use inariwatch_desktop_lib::agent::{
    AuditLog, ChatTool, InMemoryReceiptSink, PermissionLevel, PermissionResolver, ToolError,
    ToolInvocation, ToolMeta, ToolOutput, ToolRegistry, WitnessEmitter,
};
use inariwatch_desktop_lib::messenger::ai_loop::mocks::{MockAi, MockChannel};
use inariwatch_desktop_lib::messenger::ai_loop::{AiResponse, AiToolCall};
use inariwatch_desktop_lib::messenger::channel::{ChannelKind, DmPolicy, InboundMessage};
use inariwatch_desktop_lib::messenger::events::MessengerEvent;
use inariwatch_desktop_lib::messenger::gateway::Gateway;
use inariwatch_desktop_lib::pairing::{
    EntityKind, PairingInitiator, PairingService, PairingStore, TestClock,
};
use inariwatch_desktop_lib::store::SqlitePool;

// ── Rig ─────────────────────────────────────────────────────────────────────

struct EchoTool {
    meta: ToolMeta,
}

impl EchoTool {
    fn new(name: &str, perm: PermissionLevel) -> Self {
        Self {
            meta: ToolMeta {
                name: name.into(),
                description: "echo".into(),
                params_schema: json!({"type": "object"}),
                default_permission: perm,
            },
        }
    }
}

#[async_trait]
impl ChatTool for EchoTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput {
            value: invocation.args.clone(),
            summary: Some(format!("ran `{}`", invocation.tool_name)),
        })
    }
}

fn pool() -> SqlitePool {
    let manager = SqliteConnectionManager::memory();
    r2d2::Pool::builder().max_size(1).build(manager).unwrap()
}

fn registry_with(tool: Arc<dyn ChatTool>) -> (Arc<ToolRegistry>, Arc<PermissionResolver>, Arc<AuditLog>) {
    let resolver = Arc::new(PermissionResolver::new());
    let sink: Arc<InMemoryReceiptSink> = Arc::new(InMemoryReceiptSink::new(64));
    let witness = Arc::new(WitnessEmitter::new(sink));
    let audit = Arc::new(AuditLog::new(pool()));
    audit.ensure_schema().unwrap();
    let reg = Arc::new(ToolRegistry::new(resolver.clone(), witness, audit.clone()));
    reg.register(tool).unwrap();
    (reg, resolver, audit)
}

fn pairing_service() -> (Arc<PairingService>, Arc<TestClock>) {
    let clock = Arc::new(TestClock::new(1_700_000_000_000));
    let store = PairingStore::with_clock(pool(), clock.clone());
    store.ensure_schema().unwrap();
    (Arc::new(PairingService::new(store)), clock)
}

async fn pair_phone(
    svc: &PairingService,
    workspace_id: Uuid,
    phone: &str,
) {
    let pending = svc
        .generate(EntityKind::Phone, workspace_id, &PairingInitiator::user())
        .await
        .unwrap();
    let challenge = svc.redeem(pending.code.as_str(), phone, "Test").await.unwrap();
    svc.confirm_sas(challenge.challenge_id, true)
        .await
        .unwrap()
        .unwrap();
}

fn collect_events(rx: &mut broadcast::Receiver<MessengerEvent>) -> Vec<MessengerEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn paired_user_text_only_round_trip_replies_via_channel() {
    let (svc, _clock) = pairing_service();
    let workspace_id = Uuid::new_v4();
    let phone = "+5215551234567";
    pair_phone(&svc, workspace_id, phone).await;

    let (reg, _res, _audit) = registry_with(Arc::new(EchoTool::new(
        "comm.x",
        PermissionLevel::Auto,
    )));
    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: "Hello!".to_string(),
        tool_call: None,
    });
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, mut bus_rx) = broadcast::channel(32);
    let gateway = Gateway::new(svc, reg, ai, bus_tx, workspace_id);

    let inbound = InboundMessage {
        channel: ChannelKind::WhatsApp,
        from_identifier: phone.to_string(),
        display_name: "User".to_string(),
        text: "ping".to_string(),
        thread_id: None,
        reply_to: None,
        timestamp: Utc::now(),
    };
    gateway
        .dispatch(channel.clone() as Arc<dyn inariwatch_desktop_lib::messenger::channel::Channel>, inbound)
        .await
        .unwrap();

    let sends = channel.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].1.text, "Hello!");

    let events = collect_events(&mut bus_rx);
    assert!(events
        .iter()
        .any(|e| matches!(e, MessengerEvent::AssistantReplied { .. })));
}

#[tokio::test]
async fn paired_user_auto_tool_call_executes_and_emits_invocation_id() {
    let (svc, _clock) = pairing_service();
    let workspace_id = Uuid::new_v4();
    let phone = "+5215551234567";
    pair_phone(&svc, workspace_id, phone).await;

    let (reg, _res, audit) = registry_with(Arc::new(EchoTool::new(
        "comm.auto",
        PermissionLevel::Auto,
    )));
    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: "Looking it up".to_string(),
        tool_call: Some(AiToolCall {
            tool_name: "comm.auto".to_string(),
            args: json!({"x": 1}),
        }),
    });
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, mut bus_rx) = broadcast::channel(32);
    let gateway = Gateway::new(svc, reg, ai, bus_tx, workspace_id);

    let inbound = InboundMessage {
        channel: ChannelKind::WhatsApp,
        from_identifier: phone.to_string(),
        display_name: "User".to_string(),
        text: "look it up".to_string(),
        thread_id: None,
        reply_to: None,
        timestamp: Utc::now(),
    };
    gateway
        .dispatch(channel.clone() as Arc<dyn inariwatch_desktop_lib::messenger::channel::Channel>, inbound)
        .await
        .unwrap();

    assert_eq!(audit.count().unwrap(), 1, "exactly one audit row per turn");
    let row = audit.list_recent(1).unwrap().pop().unwrap();
    assert_eq!(row.tool_name, "comm.auto");
    assert!(row.success);
    assert_eq!(
        row.session_id.as_deref().unwrap_or(""),
        format!("messenger:wa:{}", row.session_id.as_ref().unwrap().split(':').next_back().unwrap())
            .as_str(),
        "session_id must use messenger:wa:<entity> convention"
    );

    let events = collect_events(&mut bus_rx);
    assert!(events
        .iter()
        .any(|e| matches!(e, MessengerEvent::ToolCallFinished { success: true, .. })));
}

#[tokio::test]
async fn paired_user_confirm_tool_pauses_and_resumes_on_confirm() {
    let (svc, _clock) = pairing_service();
    let workspace_id = Uuid::new_v4();
    let phone = "+5215551234567";
    pair_phone(&svc, workspace_id, phone).await;

    let (reg, _res, audit) = registry_with(Arc::new(EchoTool::new(
        "comm.confirm_me",
        PermissionLevel::Confirm,
    )));
    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: "Need approval".to_string(),
        tool_call: Some(AiToolCall {
            tool_name: "comm.confirm_me".to_string(),
            args: json!({"y": 2}),
        }),
    });
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, _bus_rx) = broadcast::channel(32);
    let gateway = Gateway::new(svc, reg, ai, bus_tx, workspace_id);

    // First inbound triggers the LLM round-trip → tool requires confirm.
    let first = InboundMessage {
        channel: ChannelKind::WhatsApp,
        from_identifier: phone.to_string(),
        display_name: "User".to_string(),
        text: "do the thing".to_string(),
        thread_id: None,
        reply_to: None,
        timestamp: Utc::now(),
    };
    gateway
        .dispatch(
            channel.clone() as Arc<dyn inariwatch_desktop_lib::messenger::channel::Channel>,
            first,
        )
        .await
        .unwrap();

    // No audit row yet — the Confirm short-circuit doesn't audit.
    assert_eq!(audit.count().unwrap(), 0);
    let sends_after_first = channel.sends();
    assert_eq!(sends_after_first.len(), 1);
    let first_reply = &sends_after_first[0].1;
    assert_eq!(first_reply.buttons.len(), 2);
    let confirm_callback = first_reply.buttons[0].callback.clone();
    assert!(
        confirm_callback.starts_with("/confirm "),
        "first button must be the confirm callback"
    );

    // Second inbound replies with the confirm callback verbatim.
    let second = InboundMessage {
        channel: ChannelKind::WhatsApp,
        from_identifier: phone.to_string(),
        display_name: "User".to_string(),
        text: confirm_callback,
        thread_id: None,
        reply_to: None,
        timestamp: Utc::now(),
    };
    gateway
        .dispatch(
            channel.clone() as Arc<dyn inariwatch_desktop_lib::messenger::channel::Channel>,
            second,
        )
        .await
        .unwrap();

    // Now the audit row exists — the confirmation path went through
    // `invoke_traced_confirmed`.
    assert_eq!(audit.count().unwrap(), 1);
    let row = audit.list_recent(1).unwrap().pop().unwrap();
    assert_eq!(row.tool_name, "comm.confirm_me");
    assert!(row.success);

    // Two outbound sends: the confirm prompt + the ran-result reply.
    let sends_after_confirm = channel.sends();
    assert_eq!(sends_after_confirm.len(), 2);
}

#[tokio::test]
async fn paired_user_denied_tool_replies_friendly_no_execution() {
    let (svc, _clock) = pairing_service();
    let workspace_id = Uuid::new_v4();
    let phone = "+5215551234567";
    pair_phone(&svc, workspace_id, phone).await;

    let (reg, resolver, audit) = registry_with(Arc::new(EchoTool::new(
        "comm.banned",
        PermissionLevel::Auto,
    )));
    resolver.set_override("comm.banned", PermissionLevel::Deny);

    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: "I will try".to_string(),
        tool_call: Some(AiToolCall {
            tool_name: "comm.banned".to_string(),
            args: json!({}),
        }),
    });
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, _bus_rx) = broadcast::channel(32);
    let gateway = Gateway::new(svc, reg, ai, bus_tx, workspace_id);

    let inbound = InboundMessage {
        channel: ChannelKind::WhatsApp,
        from_identifier: phone.to_string(),
        display_name: "User".to_string(),
        text: "do the bad thing".to_string(),
        thread_id: None,
        reply_to: None,
        timestamp: Utc::now(),
    };
    gateway
        .dispatch(
            channel.clone() as Arc<dyn inariwatch_desktop_lib::messenger::channel::Channel>,
            inbound,
        )
        .await
        .unwrap();

    let sends = channel.sends();
    assert_eq!(sends.len(), 1);
    let reply = &sends[0].1.text;
    assert!(reply.contains("Permissions"), "reply must point to Settings → Permissions");

    // Audit row exists with `success=false`.
    assert_eq!(audit.count().unwrap(), 1);
    let row = audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);
}
