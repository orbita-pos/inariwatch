//! Messenger-module unit tests.
//!
//! Coverage target (per S8 prompt):
//!
//! - `Gateway::dispatch` routes inbound to the correct adapter (this
//!   is implicit — the gateway dispatches against the channel passed
//!   in; we cover by asserting the right `Channel::send` was called).
//! - `ai_loop::run_turn` with text-only LLM response: replies via
//!   channel.
//! - `ai_loop::run_turn` with tool_call (Auto): executes, single audit
//!   row, single witness receipt for round-trip.
//! - `ai_loop::run_turn` with tool_call (RequiresConfirm): sends
//!   inline buttons, pauses, completes on next inbound `/confirm`.
//! - `ai_loop::run_turn` with Denied tool: replies error, no execution.
//! - Unpaired DM rejected with friendly message.
//! - `/pair CODE` triggers SAS challenge, bot reply asserted.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use r2d2_sqlite::SqliteConnectionManager;
use serde_json::json;
use uuid::Uuid;

use crate::agent::tools::SlackBackend;
use crate::agent::{
    AuditLog, ChatTool, InMemoryReceiptSink, PermissionLevel, PermissionResolver, ToolError,
    ToolInvocation, ToolMeta, ToolOutput, ToolRegistry, WitnessEmitter,
};
use crate::messenger::ai_loop::mocks::{MockAi, MockChannel};
use crate::messenger::ai_loop::{run_turn, AiResponse, AiToolCall, LoopOutcome};
use crate::messenger::attribution::{redact_identifier, ChannelAttribution};
use crate::messenger::channel::{ChannelKind, DmPolicy, InboundMessage};
use crate::messenger::events::MessengerEvent;
use crate::messenger::gateway::Gateway;
use crate::messenger::slack::SlackChannel;
use crate::messenger::telegram::inbound::TelegramMirrorPayload;
use crate::messenger::telegram::TelegramChannel;
use crate::pairing::{
    EntityKind, PairingInitiator, PairingService, PairingStore, TestClock,
};
use crate::store::SqlitePool;
use tokio::sync::broadcast;

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

// ── ai_loop / run_turn ─────────────────────────────────────────────────────

#[tokio::test]
async fn run_turn_replies_with_text_when_ai_emits_no_tool_call() {
    let (reg, _res, _audit) = registry_with(Arc::new(EchoTool::new(
        "comm.echo",
        PermissionLevel::Auto,
    )));
    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: "Hi there!".to_string(),
        tool_call: None,
    });

    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, mut bus_rx) = broadcast::channel(16);
    let attribution = ChannelAttribution {
        channel: ChannelKind::WhatsApp,
        paired_id: Uuid::nil(),
        redacted_identifier: "+1 ••••5678".to_string(),
        display_name: "Test".to_string(),
    };

    let outcome = run_turn(
        channel.as_ref(),
        &reg,
        ai.as_ref(),
        &bus_tx,
        &attribution,
        "ping",
        "messenger:wa:test",
        "+15555555678",
    )
    .await
    .expect("ok");

    match outcome {
        LoopOutcome::TextReply { text } => assert_eq!(text, "Hi there!"),
        other => panic!("expected TextReply, got {other:?}"),
    }
    let sends = channel.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].1.text, "Hi there!");
    assert!(sends[0].1.buttons.is_empty());

    // Bus emitted at least InboundReceived + AssistantReplied + TurnComplete.
    let mut kinds = Vec::new();
    while let Ok(ev) = bus_rx.try_recv() {
        kinds.push(match ev {
            MessengerEvent::InboundReceived { .. } => "inbound",
            MessengerEvent::AssistantReplied { .. } => "reply",
            MessengerEvent::TurnComplete { .. } => "turn_done",
            _ => "other",
        });
    }
    assert!(kinds.contains(&"inbound"));
    assert!(kinds.contains(&"reply"));
    assert!(kinds.contains(&"turn_done"));
}

#[tokio::test]
async fn run_turn_executes_auto_tool_and_emits_invocation_id() {
    let (reg, _res, audit) = registry_with(Arc::new(EchoTool::new(
        "comm.auto_tool",
        PermissionLevel::Auto,
    )));
    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: "Looking it up".to_string(),
        tool_call: Some(AiToolCall {
            tool_name: "comm.auto_tool".to_string(),
            args: json!({"x": 1}),
        }),
    });
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, _bus_rx) = broadcast::channel(16);
    let attribution = ChannelAttribution {
        channel: ChannelKind::WhatsApp,
        paired_id: Uuid::nil(),
        redacted_identifier: "+1 ••••5678".to_string(),
        display_name: "Test".to_string(),
    };

    let outcome = run_turn(
        channel.as_ref(),
        &reg,
        ai.as_ref(),
        &bus_tx,
        &attribution,
        "look it up",
        "messenger:wa:test",
        "+15555555678",
    )
    .await
    .unwrap();

    match outcome {
        LoopOutcome::ToolDone {
            tool_name,
            invocation_id,
            ..
        } => {
            assert_eq!(tool_name, "comm.auto_tool");
            // The invocation_id should match a row in the audit log.
            assert_eq!(audit.count().unwrap(), 1);
            let row = audit.get_by_id(&invocation_id).unwrap().expect("row");
            assert_eq!(row.tool_name, "comm.auto_tool");
            assert!(row.success);
        }
        other => panic!("expected ToolDone, got {other:?}"),
    }
    // Single send: the consolidated reply.
    assert_eq!(channel.sends().len(), 1);
}

#[tokio::test]
async fn run_turn_with_confirm_tool_replies_with_buttons_and_no_audit_yet() {
    let (reg, _res, audit) = registry_with(Arc::new(EchoTool::new(
        "comm.confirm_tool",
        PermissionLevel::Confirm,
    )));
    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: String::new(),
        tool_call: Some(AiToolCall {
            tool_name: "comm.confirm_tool".to_string(),
            args: json!({"y": 2}),
        }),
    });
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, _bus_rx) = broadcast::channel(16);
    let attribution = ChannelAttribution {
        channel: ChannelKind::WhatsApp,
        paired_id: Uuid::nil(),
        redacted_identifier: "+1 ••••5678".to_string(),
        display_name: "Test".to_string(),
    };

    let outcome = run_turn(
        channel.as_ref(),
        &reg,
        ai.as_ref(),
        &bus_tx,
        &attribution,
        "confirm please",
        "messenger:wa:test",
        "+15555555678",
    )
    .await
    .unwrap();

    match outcome {
        LoopOutcome::ToolPendingConfirm {
            tool_call_id,
            tool_name,
            ..
        } => {
            assert!(!tool_call_id.is_empty());
            assert_eq!(tool_name, "comm.confirm_tool");
        }
        other => panic!("expected ToolPendingConfirm, got {other:?}"),
    }

    // Reply contains channel-native buttons.
    let sends = channel.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].1.buttons.len(), 2);
    assert_eq!(sends[0].1.buttons[0].label, "Confirm");
    assert_eq!(sends[0].1.buttons[1].label, "Cancel");

    // No audit row yet — the Confirm short-circuit doesn't audit.
    assert_eq!(audit.count().unwrap(), 0);
}

#[tokio::test]
async fn run_turn_with_denied_tool_replies_with_error_and_audits_denial() {
    let (reg, resolver, audit) = registry_with(Arc::new(EchoTool::new(
        "comm.deny_me",
        PermissionLevel::Auto,
    )));
    resolver.set_override("comm.deny_me", PermissionLevel::Deny);

    let ai = Arc::new(MockAi::new());
    ai.enqueue(AiResponse {
        text: "I will try".to_string(),
        tool_call: Some(AiToolCall {
            tool_name: "comm.deny_me".to_string(),
            args: json!({}),
        }),
    });
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, _bus_rx) = broadcast::channel(16);
    let attribution = ChannelAttribution {
        channel: ChannelKind::WhatsApp,
        paired_id: Uuid::nil(),
        redacted_identifier: "+1 ••••5678".to_string(),
        display_name: "Test".to_string(),
    };

    let outcome = run_turn(
        channel.as_ref(),
        &reg,
        ai.as_ref(),
        &bus_tx,
        &attribution,
        "do the bad thing",
        "messenger:wa:test",
        "+15555555678",
    )
    .await
    .unwrap();

    match outcome {
        LoopOutcome::ToolDenied { tool_name, .. } => {
            assert_eq!(tool_name, "comm.deny_me");
        }
        other => panic!("expected ToolDenied, got {other:?}"),
    }

    // Audit log has one row for the denial. The Deny path audits.
    assert_eq!(audit.count().unwrap(), 1);
    let row = audit.list_recent(1).unwrap().pop().unwrap();
    assert!(!row.success);

    // Reply mentions Settings → Permissions.
    let sends = channel.sends();
    assert!(sends[0].1.text.contains("Permissions"));
}

// ── Gateway: pairing rejection flow ────────────────────────────────────────

#[tokio::test]
async fn gateway_rejects_unpaired_inbound_with_friendly_message() {
    let (svc, _clock) = pairing_service();
    let (reg, _res, _audit) = registry_with(Arc::new(EchoTool::new(
        "comm.x",
        PermissionLevel::Auto,
    )));
    let ai = Arc::new(MockAi::new());
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, _) = broadcast::channel(16);
    let gateway = Gateway::new(svc, reg, ai, bus_tx, Uuid::new_v4());

    let inbound = InboundMessage {
        channel: ChannelKind::WhatsApp,
        from_identifier: "+5215551234567".to_string(),
        display_name: "Stranger".to_string(),
        text: "what's up".to_string(),
        thread_id: None,
        reply_to: None,
        timestamp: Utc::now(),
    };
    gateway
        .dispatch(channel.clone() as Arc<dyn crate::messenger::channel::Channel>, inbound)
        .await
        .unwrap();

    let sends = channel.sends();
    assert_eq!(sends.len(), 1, "gateway must reply once");
    assert!(
        sends[0].1.text.contains("pair") || sends[0].1.text.contains("Pair"),
        "reply must explain pairing — got: {}",
        sends[0].1.text
    );
}

#[tokio::test]
async fn gateway_pair_command_triggers_sas_challenge_and_replies_with_digits() {
    let (svc, _clock) = pairing_service();
    let workspace_id = Uuid::new_v4();
    // Pre-generate a code in the same workspace.
    let pending = svc
        .generate(EntityKind::Phone, workspace_id, &PairingInitiator::user())
        .await
        .unwrap();

    let (reg, _res, _audit) = registry_with(Arc::new(EchoTool::new(
        "comm.x",
        PermissionLevel::Auto,
    )));
    let ai = Arc::new(MockAi::new());
    let channel = Arc::new(MockChannel::new(ChannelKind::WhatsApp, DmPolicy::Pairing));
    let (bus_tx, mut bus_rx) = broadcast::channel(16);
    let gateway = Gateway::new(svc.clone(), reg, ai, bus_tx, workspace_id);

    let inbound = InboundMessage {
        channel: ChannelKind::WhatsApp,
        from_identifier: "+5215551234567".to_string(),
        display_name: "Stranger".to_string(),
        text: format!("/pair {}", pending.code),
        thread_id: None,
        reply_to: None,
        timestamp: Utc::now(),
    };
    gateway
        .dispatch(channel.clone() as Arc<dyn crate::messenger::channel::Channel>, inbound)
        .await
        .unwrap();

    let sends = channel.sends();
    assert_eq!(sends.len(), 1);
    // Reply must contain 6 contiguous digits (the SAS).
    let reply = &sends[0].1.text;
    let sas_present = reply
        .split(|c: char| !c.is_ascii_digit())
        .any(|tok| tok.len() == 6);
    assert!(sas_present, "reply must contain 6 contiguous digits — got: {reply}");

    // SasPending event must have fired on the bus.
    let mut found_sas = false;
    while let Ok(ev) = bus_rx.try_recv() {
        if matches!(ev, MessengerEvent::SasPending { .. }) {
            found_sas = true;
        }
    }
    assert!(found_sas, "bus must emit SasPending");
}

// ── Adapter sanity checks ──────────────────────────────────────────────────

#[tokio::test]
async fn telegram_adapter_advertises_open_dm_policy() {
    let ch = TelegramChannel::for_test(crate::messenger::telegram::inbound::test_stream(vec![]));
    use crate::messenger::channel::Channel;
    assert_eq!(ch.kind(), ChannelKind::Telegram);
    assert_eq!(ch.dm_policy(), DmPolicy::Open);
}

#[tokio::test]
async fn slack_adapter_advertises_open_dm_policy() {
    let ch = SlackChannel::for_test(crate::messenger::slack::inbound::test_stream(vec![]));
    use crate::messenger::channel::Channel;
    assert_eq!(ch.kind(), ChannelKind::Slack);
    assert_eq!(ch.dm_policy(), DmPolicy::Open);
}

// ── Mirror payload deserialisation ─────────────────────────────────────────

#[test]
fn telegram_mirror_payload_round_trips_with_optional_ts() {
    let raw = r#"{"from_identifier":"@alerts","display_name":"Alerts","text":"hi"}"#;
    let parsed: TelegramMirrorPayload = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.from_identifier, "@alerts");
    assert_eq!(parsed.display_name, "Alerts");
    assert_eq!(parsed.text, "hi");
    assert!(parsed.ts_ms.is_none());
}

// ── Attribution redaction sanity ───────────────────────────────────────────

#[test]
fn attribution_redacts_phone_for_whatsapp() {
    let r = redact_identifier(ChannelKind::WhatsApp, "+5215551234567");
    assert_eq!(r, "+52 ••••4567");
}

// Silence "unused import" warnings for items only used by tests under
// the `agent-test-utils` feature combination.
#[allow(dead_code)]
fn _silence_unused() {
    let _: Option<Arc<dyn SlackBackend>> = None;
}
