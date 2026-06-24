//! Single-turn AI loop for an inbound messenger DM.
//!
//! Given a paired identity + the inbound text, ask the LLM, dispatch
//! any returned tool call through `ToolRegistry::invoke_traced`
//! (two-phase, ambient pattern), and reply via `Channel::send`.
//!
//! ## AiDispatch trait
//!
//! Decouples the loop from the concrete `ai-router-rs::dispatch`. The
//! production wiring (S8 boot in `lib.rs::install_messenger_gateway`)
//! plugs in an adapter over `ai_router_rs::dispatch`; tests use
//! [`mocks::MockAi`] to script responses.
//!
//! ## Two-phase invoke (CRITICAL)
//!
//! Bot-initiated tool calls are ambient (the user didn't click anything
//! on the desktop — the bot decided). Per the
//! `feedback_ambient_two_phase_invoke` rule:
//!
//! 1. Always call `invoke_traced` FIRST. If the user pre-emptively set
//!    the tool to Deny, the registry returns `PermissionDenied` and
//!    we reply with a friendly "Open Settings" message.
//! 2. Only if the registry returns `RequiresConfirm` do we surface a
//!    channel-native confirm and (eventually) call
//!    `invoke_traced_confirmed`.
//!
//! Calling `_confirmed` directly bypasses Deny too — that's a critical
//! bug we explicitly guard against.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::agent::{RegistryError, ToolMeta, ToolRegistry};

use super::attribution::ChannelAttribution;
use super::channel::{Channel, ChannelError, MessageButton, OutboundMessage};
use super::events::MessengerEvent;

// ── AI dispatch trait + mock ────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("ai dispatch: {0}")]
    Dispatch(String),
    #[error("ai response could not be parsed: {0}")]
    Parse(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolCall {
    pub tool_name: String,
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiResponse {
    pub text: String,
    /// Optional. Tool call the LLM emitted.
    pub tool_call: Option<AiToolCall>,
}

#[async_trait]
pub trait AiDispatch: Send + Sync {
    /// Single round-trip. Implementations build a system prompt
    /// internally; callers pass:
    /// - `paired_display_name` — surfaced in the system prompt so the
    ///   model addresses the user by name.
    /// - `user_text` — verbatim user message.
    /// - `catalog` — registered tools, used as the function-calling
    ///   tool list.
    async fn ask(
        &self,
        paired_display_name: &str,
        user_text: &str,
        catalog: &[ToolMeta],
    ) -> Result<AiResponse, AiError>;
}

// ── Outcome ─────────────────────────────────────────────────────────────────

/// What the loop decided to send back. Pure data — the gateway is the
/// thing that actually `Channel::send`s. Returning the structured
/// outcome lets tests assert on the decision without driving a real
/// channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopOutcome {
    /// Plain text reply, no tool involvement.
    TextReply { text: String },
    /// Tool ran successfully. Reply text is short — channels render the
    /// witness chip via the dock mirror, not via inline text.
    ToolDone {
        tool_name: String,
        invocation_id: String,
        reply_text: String,
    },
    /// Tool requires user confirmation; we replied with channel-native
    /// confirm buttons. Caller awaits the next inbound message to
    /// resume the flow.
    ToolPendingConfirm {
        tool_call_id: String,
        tool_name: String,
        args: Value,
        reply_text: String,
    },
    /// Tool denied by user override. Reply tells user where to flip it.
    ToolDenied {
        tool_name: String,
        reply_text: String,
    },
    /// Tool execution failed (post-permission gate). Reply surfaces
    /// the error.
    ToolFailed {
        tool_name: String,
        reply_text: String,
        error: String,
    },
}

// ── Loop entry ──────────────────────────────────────────────────────────────

/// Run one round-trip for an inbound DM. Side-effects:
///
/// - Dispatches outbound through `channel.send`.
/// - Emits `MessengerEvent::*` to `bus` so the dock mirrors the turn.
///
/// Returns a structured [`LoopOutcome`] for tests + the gateway's
/// per-entity mutex bookkeeping.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    channel: &dyn Channel,
    registry: &ToolRegistry,
    ai: &dyn AiDispatch,
    bus: &broadcast::Sender<MessengerEvent>,
    attribution: &ChannelAttribution,
    user_text: &str,
    session_id: &str,
    to_identifier: &str,
) -> Result<LoopOutcome, ChannelError> {
    let _ = bus.send(MessengerEvent::InboundReceived {
        attribution: attribution.clone(),
        text: user_text.to_string(),
        timestamp: chrono::Utc::now(),
    });

    let catalog = registry.list();
    let response = match ai.ask(&attribution.display_name, user_text, &catalog).await {
        Ok(r) => r,
        Err(err) => {
            // AI unreachable — reply with a transparent error so the
            // user can retry.
            let text = format!(
                "I couldn't reach the model just now: {err}. Please try again in a few seconds."
            );
            channel
                .send(
                    to_identifier,
                    &OutboundMessage {
                        text: text.clone(),
                        buttons: Vec::new(),
                        thread_id: None,
                    },
                    session_id,
                )
                .await?;
            let _ = bus.send(MessengerEvent::TurnComplete {
                attribution: attribution.clone(),
                session_id: session_id.to_string(),
            });
            return Ok(LoopOutcome::TextReply { text });
        }
    };

    // Surface assistant text first regardless of whether a tool call
    // follows (Anthropic / OpenAI both allow text + tool_use in the
    // same turn — keep the text as the leading reply).
    let mut leading_text = response.text.trim().to_string();
    if leading_text.is_empty() && response.tool_call.is_some() {
        // No leading text — synth a one-liner so the user isn't left
        // wondering. Keeps the round-trip narrative coherent.
        leading_text = "Working on it…".to_string();
    }

    if let Some(tc) = response.tool_call {
        let tool_call_id = uuid::Uuid::new_v4().simple().to_string();
        let _ = bus.send(MessengerEvent::ToolCallStarted {
            attribution: attribution.clone(),
            tool_call_id: tool_call_id.clone(),
            tool_name: tc.tool_name.clone(),
            session_id: session_id.to_string(),
        });

        match registry
            .invoke_traced(&tc.tool_name, tc.args.clone(), Some(session_id.to_string()))
            .await
        {
            Ok((invocation_id, output)) => {
                let summary = output
                    .summary
                    .clone()
                    .unwrap_or_else(|| format!("`{}` ran", tc.tool_name));
                let reply = if leading_text.is_empty() {
                    summary.clone()
                } else {
                    format!("{leading_text}\n\n{summary}")
                };
                channel
                    .send(
                        to_identifier,
                        &OutboundMessage {
                            text: reply.clone(),
                            buttons: Vec::new(),
                            thread_id: None,
                        },
                        session_id,
                    )
                    .await?;
                let _ = bus.send(MessengerEvent::ToolCallFinished {
                    attribution: attribution.clone(),
                    tool_call_id,
                    invocation_id: invocation_id.clone(),
                    tool_name: tc.tool_name.clone(),
                    success: true,
                    session_id: session_id.to_string(),
                });
                let _ = bus.send(MessengerEvent::TurnComplete {
                    attribution: attribution.clone(),
                    session_id: session_id.to_string(),
                });
                return Ok(LoopOutcome::ToolDone {
                    tool_name: tc.tool_name,
                    invocation_id,
                    reply_text: reply,
                });
            }
            Err(RegistryError::RequiresConfirm) => {
                let prompt_text = if leading_text.is_empty() {
                    format!(
                        "I'd like to run `{}`. Reply with `confirm` to approve or `cancel` to skip.",
                        tc.tool_name
                    )
                } else {
                    format!(
                        "{leading_text}\n\nI'd like to run `{}`. Reply with `confirm` to approve or `cancel` to skip.",
                        tc.tool_name
                    )
                };
                let buttons = vec![
                    MessageButton {
                        label: "Confirm".to_string(),
                        callback: format!("/confirm {tool_call_id}"),
                    },
                    MessageButton {
                        label: "Cancel".to_string(),
                        callback: format!("/cancel {tool_call_id}"),
                    },
                ];
                channel
                    .send(
                        to_identifier,
                        &OutboundMessage {
                            text: prompt_text.clone(),
                            buttons,
                            thread_id: None,
                        },
                        session_id,
                    )
                    .await?;
                let _ = bus.send(MessengerEvent::ToolCallRequiresConfirm {
                    attribution: attribution.clone(),
                    tool_call_id: tool_call_id.clone(),
                    tool_name: tc.tool_name.clone(),
                    session_id: session_id.to_string(),
                });
                // Note: we do NOT emit TurnComplete here — the round-trip
                // is genuinely paused waiting on the user's next message.
                return Ok(LoopOutcome::ToolPendingConfirm {
                    tool_call_id,
                    tool_name: tc.tool_name,
                    args: tc.args,
                    reply_text: prompt_text,
                });
            }
            Err(RegistryError::PermissionDenied) => {
                let reply = format!(
                    "I can't run `{}` — you've disabled it in Settings → Permissions. \
                     Open Inari Live → Settings → Permissions to flip it back to Confirm/Auto.",
                    tc.tool_name
                );
                channel
                    .send(
                        to_identifier,
                        &OutboundMessage {
                            text: reply.clone(),
                            buttons: Vec::new(),
                            thread_id: None,
                        },
                        session_id,
                    )
                    .await?;
                let _ = bus.send(MessengerEvent::ToolCallDenied {
                    attribution: attribution.clone(),
                    tool_call_id,
                    tool_name: tc.tool_name.clone(),
                    session_id: session_id.to_string(),
                });
                let _ = bus.send(MessengerEvent::TurnComplete {
                    attribution: attribution.clone(),
                    session_id: session_id.to_string(),
                });
                return Ok(LoopOutcome::ToolDenied {
                    tool_name: tc.tool_name,
                    reply_text: reply,
                });
            }
            Err(other) => {
                let err_msg = other.to_string();
                let reply = format!(
                    "I tried to run `{}` but it failed: {err_msg}",
                    tc.tool_name
                );
                channel
                    .send(
                        to_identifier,
                        &OutboundMessage {
                            text: reply.clone(),
                            buttons: Vec::new(),
                            thread_id: None,
                        },
                        session_id,
                    )
                    .await?;
                let _ = bus.send(MessengerEvent::ToolCallFinished {
                    attribution: attribution.clone(),
                    tool_call_id,
                    invocation_id: String::new(),
                    tool_name: tc.tool_name.clone(),
                    success: false,
                    session_id: session_id.to_string(),
                });
                let _ = bus.send(MessengerEvent::TurnComplete {
                    attribution: attribution.clone(),
                    session_id: session_id.to_string(),
                });
                return Ok(LoopOutcome::ToolFailed {
                    tool_name: tc.tool_name,
                    reply_text: reply,
                    error: err_msg,
                });
            }
        }
    }

    // No tool call — plain text reply.
    let text = if leading_text.is_empty() {
        "I'm here. What would you like me to do?".to_string()
    } else {
        leading_text
    };
    channel
        .send(
            to_identifier,
            &OutboundMessage {
                text: text.clone(),
                buttons: Vec::new(),
                thread_id: None,
            },
            session_id,
        )
        .await?;
    let _ = bus.send(MessengerEvent::AssistantReplied {
        attribution: attribution.clone(),
        text: text.clone(),
        session_id: session_id.to_string(),
    });
    let _ = bus.send(MessengerEvent::TurnComplete {
        attribution: attribution.clone(),
        session_id: session_id.to_string(),
    });
    Ok(LoopOutcome::TextReply { text })
}

/// Resume a tool call after the user typed `confirm`. Skips the
/// permission gate (the channel-native confirm IS the gate) and goes
/// straight to `invoke_traced_confirmed`.
#[allow(clippy::too_many_arguments)]
pub async fn run_confirmation(
    channel: &dyn Channel,
    registry: &ToolRegistry,
    bus: &broadcast::Sender<MessengerEvent>,
    attribution: &ChannelAttribution,
    pending_tool_name: &str,
    pending_args: Value,
    pending_tool_call_id: &str,
    session_id: &str,
    to_identifier: &str,
) -> Result<LoopOutcome, ChannelError> {
    match registry
        .invoke_traced_confirmed(
            pending_tool_name,
            pending_args,
            Some(session_id.to_string()),
        )
        .await
    {
        Ok((invocation_id, output)) => {
            let summary = output
                .summary
                .clone()
                .unwrap_or_else(|| format!("`{pending_tool_name}` ran"));
            channel
                .send(
                    to_identifier,
                    &OutboundMessage {
                        text: summary.clone(),
                        buttons: Vec::new(),
                        thread_id: None,
                    },
                    session_id,
                )
                .await?;
            let _ = bus.send(MessengerEvent::ToolCallFinished {
                attribution: attribution.clone(),
                tool_call_id: pending_tool_call_id.to_string(),
                invocation_id: invocation_id.clone(),
                tool_name: pending_tool_name.to_string(),
                success: true,
                session_id: session_id.to_string(),
            });
            let _ = bus.send(MessengerEvent::TurnComplete {
                attribution: attribution.clone(),
                session_id: session_id.to_string(),
            });
            Ok(LoopOutcome::ToolDone {
                tool_name: pending_tool_name.to_string(),
                invocation_id,
                reply_text: summary,
            })
        }
        Err(err) => {
            let err_msg = err.to_string();
            let reply = format!(
                "Confirmed but `{pending_tool_name}` still failed: {err_msg}"
            );
            channel
                .send(
                    to_identifier,
                    &OutboundMessage {
                        text: reply.clone(),
                        buttons: Vec::new(),
                        thread_id: None,
                    },
                    session_id,
                )
                .await?;
            let _ = bus.send(MessengerEvent::ToolCallFinished {
                attribution: attribution.clone(),
                tool_call_id: pending_tool_call_id.to_string(),
                invocation_id: String::new(),
                tool_name: pending_tool_name.to_string(),
                success: false,
                session_id: session_id.to_string(),
            });
            let _ = bus.send(MessengerEvent::TurnComplete {
                attribution: attribution.clone(),
                session_id: session_id.to_string(),
            });
            Ok(LoopOutcome::ToolFailed {
                tool_name: pending_tool_name.to_string(),
                reply_text: reply,
                error: err_msg,
            })
        }
    }
}

// ── Mocks ───────────────────────────────────────────────────────────────────

#[cfg(any(test, feature = "agent-test-utils"))]
pub mod mocks {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Scripted AI dispatcher. Pop one [`AiResponse`] per `ask()` call.
    /// When the queue empties, returns an error so a runaway test
    /// doesn't silently hang on a missing canned response.
    pub struct MockAi {
        queue: Mutex<Vec<AiResponse>>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl MockAi {
        pub fn new() -> Self {
            Self {
                queue: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
            }
        }

        pub fn enqueue(&self, response: AiResponse) {
            self.queue.lock().unwrap().push(response);
        }

        pub fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Default for MockAi {
        fn default() -> Self {
            Self::new()
        }
    }

    #[async_trait]
    impl AiDispatch for MockAi {
        async fn ask(
            &self,
            paired_display_name: &str,
            user_text: &str,
            _catalog: &[ToolMeta],
        ) -> Result<AiResponse, AiError> {
            self.calls
                .lock()
                .unwrap()
                .push((paired_display_name.to_string(), user_text.to_string()));
            let mut q = self.queue.lock().unwrap();
            // Pop from the front so .enqueue order matches dispatch order.
            if q.is_empty() {
                return Err(AiError::Dispatch("no canned response".into()));
            }
            Ok(q.remove(0))
        }
    }

    /// Channel mock that records sends and yields no inbound by
    /// default. Use `with_inbound()` to inject a stream for gateway tests.
    pub struct MockChannel {
        kind: super::super::channel::ChannelKind,
        dm_policy: super::super::channel::DmPolicy,
        sends: Arc<Mutex<Vec<(String, OutboundMessage, String)>>>,
        next_message_id: Mutex<u64>,
    }

    impl MockChannel {
        pub fn new(
            kind: super::super::channel::ChannelKind,
            dm_policy: super::super::channel::DmPolicy,
        ) -> Self {
            Self {
                kind,
                dm_policy,
                sends: Arc::new(Mutex::new(Vec::new())),
                next_message_id: Mutex::new(0),
            }
        }

        pub fn sends(&self) -> Vec<(String, OutboundMessage, String)> {
            self.sends.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Channel for MockChannel {
        fn kind(&self) -> super::super::channel::ChannelKind {
            self.kind
        }
        fn dm_policy(&self) -> super::super::channel::DmPolicy {
            self.dm_policy
        }
        async fn subscribe(
            &self,
        ) -> futures_util::stream::BoxStream<
            'static,
            super::super::channel::InboundMessage,
        > {
            futures_util::stream::empty().boxed()
        }
        async fn send(
            &self,
            to_identifier: &str,
            msg: &OutboundMessage,
            session_id: &str,
        ) -> Result<super::super::channel::MessageId, ChannelError> {
            let mut id_guard = self.next_message_id.lock().unwrap();
            *id_guard += 1;
            let id = *id_guard;
            self.sends.lock().unwrap().push((
                to_identifier.to_string(),
                msg.clone(),
                session_id.to_string(),
            ));
            Ok(super::super::channel::MessageId {
                channel: self.kind,
                raw: format!("mock-{id}"),
            })
        }
    }

    use futures_util::stream::StreamExt;
}
