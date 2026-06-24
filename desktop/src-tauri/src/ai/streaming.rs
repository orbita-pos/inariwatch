//! Wire an [`OpenAIClient`]'s [`ChatChunk`] stream onto the
//! [`crate::daemon::EventBus`].
//!
//! The dock never reads the OpenAI response directly. Instead we read
//! it here, emit a [`DaemonEvent::ChatTokenStream`] for each delta, and
//! the existing IPC events bridge (`ipc::events`) forwards everything
//! tagged `daemon:event` to the webview. Same wire as every other
//! cross-sensor signal — keeps the dock's `installChatStreamDriver`
//! single-listener.
//!
//! **Status after Phase 4.6 of the pure-slash refactor (2026-05-15):**
//! the original caller of this function — `ipc::chat::start_chat_stream`
//! — was deleted alongside the cloud free-chat path. The function
//! remains here because its tests still cover the wire shape so a
//! future caller (e.g. a structured `/explain` slash command that
//! wants streaming) can reuse it without re-deriving the SSE → bus
//! translation. Re-evaluate before adding new code paths that import
//! this module — if no live caller has materialised after a release
//! cycle, delete it then.

use std::collections::BTreeMap;

use futures_util::stream::StreamExt;

use crate::daemon::{DaemonEvent, EventBus};

use super::budget::Model;
use super::openai::{ChatChunk, OpenAIError};

/// One in-flight tool call, accumulated across SSE deltas. The
/// streamer keys these on `ToolCallDelta::index` so concurrent calls
/// in one assistant turn (rare, but the schema supports it) interleave
/// safely. `BTreeMap` over `HashMap` gives a stable emit order on the
/// closing chunk.
#[derive(Default, Clone, Debug)]
struct ToolCallAccumulator {
    /// Provider-issued tool-call id. Set on the first delta that
    /// carries it; cloned forward for every subsequent delta. The
    /// frontend uses this as the chat surface's `tool_call.id` so a
    /// later "tool result" round-trip lines up.
    id: Option<String>,
    /// Tool name (e.g. `"desktop.open_url"`). Set on the first delta
    /// that carries `function.name`.
    name: Option<String>,
    /// JSON arguments body, concatenated across deltas. The model can
    /// emit invalid JSON during accumulation (closing brace arrives
    /// mid-stream); the streamer just publishes whatever it has when
    /// the terminal `tool_calls` chunk lands and lets the registry's
    /// schema validator surface a clean error.
    arguments: String,
}

/// What we observed while draining the stream. The IPC command hands
/// this to the budget tracker so spend reflects real usage.
#[derive(Debug, Clone, Copy, Default)]
pub struct StreamSummary {
    pub prompt_tokens:     u32,
    pub completion_tokens: u32,
    pub model_used:        Option<Model>,
    /// `"stop"` / `"length"` / `"error"` / `"content_filter"` etc. —
    /// echoed from OpenAI's last chunk.
    pub finish_reason:     Option<&'static str>,
    /// True when the stream produced at least one delta. Used by tests.
    pub had_tokens:        bool,
}

/// Drain a `ChatChunk` stream, publishing one [`ChatTokenStream`] event
/// per delta. The closing event carries `finish_reason`. Errors are
/// converted into a final `finish_reason: Some("error")` event so the
/// dock surfaces them as a clean stream-end rather than a hang.
///
/// S6 — when a chunk carries `tool_call: Some(_)`, the streamer
/// accumulates per-`index` until the terminal `finish_reason ==
/// "tool_calls"` chunk arrives, then publishes one
/// [`DaemonEvent::ChatToolCall`] per assembled call (in stable
/// `index` order) BEFORE the closing `ChatTokenStream`. This keeps
/// the frontend single-listener — the same `daemon:event` channel
/// carries text chunks AND tool calls.
pub async fn stream_to_bus<S>(
    mut stream: S,
    bus:        &EventBus,
    session_id: &str,
    model:      Model,
) -> StreamSummary
where
    S: futures_util::Stream<Item = Result<ChatChunk, OpenAIError>> + Unpin,
{
    let mut summary = StreamSummary {
        model_used: Some(model),
        ..StreamSummary::default()
    };
    let mut tool_calls: BTreeMap<u32, ToolCallAccumulator> = BTreeMap::new();

    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if let Some(delta) = chunk.tool_call.as_ref() {
                    let entry = tool_calls.entry(delta.index).or_default();
                    if let Some(id) = delta.id.as_deref() {
                        if entry.id.is_none() {
                            entry.id = Some(id.to_string());
                        }
                    }
                    if let Some(name) = delta.name.as_deref() {
                        if entry.name.is_none() {
                            entry.name = Some(name.to_string());
                        }
                    }
                    entry.arguments.push_str(&delta.arguments_delta);
                }
                if !chunk.delta.is_empty() {
                    summary.had_tokens = true;
                    bus.publish(DaemonEvent::ChatTokenStream {
                        session_id:    session_id.to_string(),
                        token:         chunk.delta.clone(),
                        finish_reason: None,
                    });
                }
                if let Some(usage) = chunk.usage {
                    // Final chunk often carries usage on its own —
                    // remember it; we'll attach to summary when we
                    // exit the loop.
                    summary.prompt_tokens     = usage.prompt_tokens;
                    summary.completion_tokens = usage.completion_tokens;
                }
                if let Some(reason) = chunk.finish_reason {
                    let static_reason: &'static str = match reason.as_str() {
                        "stop"             => "stop",
                        "length"           => "length",
                        "tool_calls"       => "tool_calls",
                        "content_filter"   => "content_filter",
                        "function_call"    => "function_call",
                        _                  => "stop",
                    };
                    summary.finish_reason = Some(static_reason);
                    if static_reason == "tool_calls" {
                        publish_accumulated_tool_calls(&tool_calls, bus, session_id);
                    }
                    // If the stream is closing without any text deltas
                    // AND no tool calls were assembled, surface a brief
                    // fallback so the bubble doesn't render empty. The
                    // dock UI flips `Inari is thinking…` → "" once
                    // streaming ends; without a token the user gets
                    // zero feedback. Cases this catches: content_filter
                    // refusals, models that emit only whitespace, and
                    // edge cases where the proxy reports `stop` with
                    // no body.
                    if !summary.had_tokens
                        && !matches!(static_reason, "tool_calls" | "function_call")
                        && tool_calls.is_empty()
                    {
                        publish_empty_response_fallback(bus, session_id, static_reason);
                        summary.had_tokens = true;
                    }
                    bus.publish(DaemonEvent::ChatTokenStream {
                        session_id:    session_id.to_string(),
                        token:         String::new(),
                        finish_reason: Some(static_reason.to_string()),
                    });
                    return summary;
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, session_id = %session_id, "chat stream error");
                summary.finish_reason = Some("error");
                // Same rationale as the empty-finish case above —
                // publish the underlying error as a token so the user
                // sees what went wrong instead of a blank bubble.
                if !summary.had_tokens {
                    publish_stream_error(bus, session_id, &e.to_string());
                    summary.had_tokens = true;
                }
                bus.publish(DaemonEvent::ChatTokenStream {
                    session_id:    session_id.to_string(),
                    token:         String::new(),
                    finish_reason: Some("error".to_string()),
                });
                return summary;
            }
        }
    }

    // Stream ended without a finish_reason — synthesize a clean stop
    // so the dock doesn't hang the assistant message in the
    // `streaming: true` state.
    if summary.finish_reason.is_none() {
        // Even if the upstream forgot to send `tool_calls`, surface
        // any accumulated calls so the chat surface still gets a
        // chance to dispatch them. Order: tool_calls first, then the
        // synthesized close.
        if !tool_calls.is_empty() {
            publish_accumulated_tool_calls(&tool_calls, bus, session_id);
        }
        if !summary.had_tokens && tool_calls.is_empty() {
            publish_empty_response_fallback(bus, session_id, "stop");
            summary.had_tokens = true;
        }
        summary.finish_reason = Some("stop");
        bus.publish(DaemonEvent::ChatTokenStream {
            session_id:    session_id.to_string(),
            token:         String::new(),
            finish_reason: Some("stop".to_string()),
        });
    }

    summary
}

/// User-facing fallback for an empty assistant response. The token text
/// is short, plain prose, and gives the user a hint about what to try
/// next without pretending the model said something it didn't. Pushed
/// through the same `ChatTokenStream` event as a real token so the dock
/// renders it inside the bubble exactly like a normal reply.
fn publish_empty_response_fallback(bus: &EventBus, session_id: &str, reason: &str) {
    tracing::warn!(
        session_id = %session_id,
        reason     = %reason,
        "chat stream closed without text deltas; emitting fallback note",
    );
    let body = match reason {
        "content_filter" => {
            "_Inari Live's safety filter blocked this reply. Try rephrasing without sensitive content._"
        }
        "length" => {
            "_The model hit its token cap before saying anything. Try a more specific question._"
        }
        _ => {
            "_I didn't have anything to add for that. Try asking about your alerts, uptime, deploys, or on-call._"
        }
    };
    bus.publish(DaemonEvent::ChatTokenStream {
        session_id:    session_id.to_string(),
        token:         body.to_string(),
        finish_reason: None,
    });
}

/// User-facing rendering of a stream-level error. Keeps the underlying
/// error string visible (it already carries actionable text like
/// "Not paired with cloud…" or "API error (429)") and wraps it in a
/// `_chat error: …_` italic block so it reads as a system note in the
/// bubble rather than impersonating the assistant.
fn publish_stream_error(bus: &EventBus, session_id: &str, err: &str) {
    let truncated: String = err.chars().take(400).collect();
    let body = format!("_chat error: {truncated}_");
    bus.publish(DaemonEvent::ChatTokenStream {
        session_id:    session_id.to_string(),
        token:         body,
        finish_reason: None,
    });
}

fn publish_accumulated_tool_calls(
    accumulators: &BTreeMap<u32, ToolCallAccumulator>,
    bus:          &EventBus,
    session_id:   &str,
) {
    for (index, acc) in accumulators {
        // No name = upstream gave us a fragment without ever sending
        // the function header. Drop with a warn — we have nothing
        // actionable to dispatch and faking one would invent state.
        let Some(name) = acc.name.clone() else {
            tracing::warn!(
                session_id = %session_id,
                index = *index,
                "tool_call delta arrived without a name; dropping"
            );
            continue;
        };
        // Provider-issued id is best-effort. Synthesize one from the
        // session + index when missing so the frontend always has a
        // stable React key (and so audit-row lookups have something to
        // pair the call against if upstream never echoes the id).
        let tool_call_id = acc
            .id
            .clone()
            .unwrap_or_else(|| format!("{session_id}-tc-{index}"));
        bus.publish(DaemonEvent::ChatToolCall {
            session_id: session_id.to_string(),
            tool_call_id,
            name,
            arguments: acc.arguments.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::openai::ChatChunk;
    use futures_util::stream;

    fn ok(delta: &str) -> Result<ChatChunk, OpenAIError> {
        Ok(ChatChunk {
            delta: delta.to_string(),
            finish_reason: None,
            usage: None,
            tool_call: None,
        })
    }
    fn done() -> Result<ChatChunk, OpenAIError> {
        Ok(ChatChunk {
            delta: String::new(),
            finish_reason: Some("stop".to_string()),
            usage: None,
            tool_call: None,
        })
    }
    fn tool_call_delta(
        index: u32,
        id: Option<&str>,
        name: Option<&str>,
        args: &str,
    ) -> Result<ChatChunk, OpenAIError> {
        Ok(ChatChunk {
            delta: String::new(),
            finish_reason: None,
            usage: None,
            tool_call: Some(ai_router_rs::ToolCallDelta {
                index,
                id: id.map(str::to_string),
                name: name.map(str::to_string),
                arguments_delta: args.to_string(),
            }),
        })
    }
    fn tool_calls_done() -> Result<ChatChunk, OpenAIError> {
        Ok(ChatChunk {
            delta: String::new(),
            finish_reason: Some("tool_calls".to_string()),
            usage: None,
            tool_call: None,
        })
    }

    #[tokio::test]
    async fn emits_one_event_per_token_plus_finish() {
        let bus = EventBus::new();
        let rx  = bus.subscribe();

        let chunks = stream::iter(vec![ok("Hello"), ok(" world"), done()]);
        let summary = stream_to_bus(chunks, &bus, "sess-1", Model::Gpt54).await;

        assert!(summary.had_tokens);
        assert_eq!(summary.finish_reason, Some("stop"));

        let mut tokens: Vec<String> = Vec::new();
        let mut closes: usize       = 0;
        while let Ok(ev) = rx.try_recv() {
            if let DaemonEvent::ChatTokenStream { token, finish_reason, session_id } = ev {
                assert_eq!(session_id, "sess-1");
                if finish_reason.is_some() {
                    closes += 1;
                } else {
                    tokens.push(token);
                }
            }
        }
        assert_eq!(tokens, vec!["Hello".to_string(), " world".to_string()]);
        assert_eq!(closes, 1);
    }

    #[tokio::test]
    async fn synthesizes_stop_when_stream_ends_without_finish() {
        let bus = EventBus::new();
        let rx  = bus.subscribe();
        let chunks = stream::iter(vec![ok("hi")]);
        let summary = stream_to_bus(chunks, &bus, "sess-2", Model::Gpt4oMini).await;

        assert_eq!(summary.finish_reason, Some("stop"));
        let mut closing_seen = false;
        while let Ok(ev) = rx.try_recv() {
            if let DaemonEvent::ChatTokenStream { finish_reason, .. } = ev {
                if finish_reason.is_some() { closing_seen = true; }
            }
        }
        assert!(closing_seen);
    }

    #[tokio::test]
    async fn assembled_tool_call_is_published_on_terminal_chunk() {
        let bus = EventBus::new();
        let rx = bus.subscribe();

        let chunks = stream::iter(vec![
            tool_call_delta(0, Some("call_abc"), Some("desktop.open_url"), "{\"url\":\""),
            tool_call_delta(0, None, None, "https://example.com\"}"),
            tool_calls_done(),
        ]);
        let summary = stream_to_bus(chunks, &bus, "sess-tc", Model::Gpt4oMini).await;
        assert_eq!(summary.finish_reason, Some("tool_calls"));

        let mut tool_call_seen = None;
        let mut close_seen = false;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                DaemonEvent::ChatToolCall {
                    session_id,
                    tool_call_id,
                    name,
                    arguments,
                } => {
                    assert_eq!(session_id, "sess-tc");
                    tool_call_seen = Some((tool_call_id, name, arguments));
                }
                DaemonEvent::ChatTokenStream { finish_reason, .. }
                    if finish_reason.as_deref() == Some("tool_calls") =>
                {
                    close_seen = true;
                }
                _ => {}
            }
        }
        let (id, name, args) = tool_call_seen.expect("tool call event published");
        assert_eq!(id, "call_abc");
        assert_eq!(name, "desktop.open_url");
        assert_eq!(args, "{\"url\":\"https://example.com\"}");
        assert!(close_seen, "stream-close ChatTokenStream still arrives");
    }

    #[tokio::test]
    async fn tool_call_without_name_is_dropped_with_warning() {
        let bus = EventBus::new();
        let rx = bus.subscribe();
        // Upstream sent only an arguments fragment without a function
        // header — the streamer has nothing to dispatch and must drop
        // it rather than invent a tool name.
        let chunks = stream::iter(vec![
            tool_call_delta(0, Some("call_x"), None, "{\"a\": 1}"),
            tool_calls_done(),
        ]);
        let _ = stream_to_bus(chunks, &bus, "sess-noop", Model::Gpt4oMini).await;
        let mut saw_tool_call = false;
        while let Ok(ev) = rx.try_recv() {
            if let DaemonEvent::ChatToolCall { .. } = ev {
                saw_tool_call = true;
            }
        }
        assert!(!saw_tool_call, "no tool call event without a name");
    }

    #[tokio::test]
    async fn synthesizes_tool_call_id_when_provider_omits_it() {
        let bus = EventBus::new();
        let rx = bus.subscribe();
        let chunks = stream::iter(vec![
            tool_call_delta(2, None, Some("desktop.notify"), "{\"title\":\"x\",\"body\":\"y\"}"),
            tool_calls_done(),
        ]);
        let _ = stream_to_bus(chunks, &bus, "sess-syn", Model::Gpt4oMini).await;
        let mut id_seen = None;
        while let Ok(ev) = rx.try_recv() {
            if let DaemonEvent::ChatToolCall { tool_call_id, .. } = ev {
                id_seen = Some(tool_call_id);
            }
        }
        // Synthesized id format: `<session>-tc-<index>`.
        assert_eq!(id_seen.as_deref(), Some("sess-syn-tc-2"));
    }

    /// Regression: when the upstream closes the stream with `stop` but
    /// never emitted any content delta (model refused, returned only
    /// whitespace, or some proxy-side edge case), the dock used to flip
    /// `Inari is thinking…` to a fully empty bubble. The streamer now
    /// publishes a short fallback note as a real token before the close
    /// so the user sees something actionable.
    #[tokio::test]
    async fn empty_stop_emits_fallback_token() {
        let bus = EventBus::new();
        let rx  = bus.subscribe();
        let chunks = stream::iter(vec![done()]);
        let summary = stream_to_bus(chunks, &bus, "sess-empty", Model::Gpt4oMini).await;

        assert_eq!(summary.finish_reason, Some("stop"));
        assert!(summary.had_tokens, "fallback token marks the stream as non-empty");

        let mut tokens: Vec<String> = Vec::new();
        let mut closes: usize       = 0;
        while let Ok(ev) = rx.try_recv() {
            if let DaemonEvent::ChatTokenStream { token, finish_reason, .. } = ev {
                if finish_reason.is_some() {
                    closes += 1;
                } else {
                    tokens.push(token);
                }
            }
        }
        assert_eq!(closes, 1);
        assert_eq!(tokens.len(), 1, "exactly one fallback token");
        assert!(tokens[0].contains("alerts"), "fallback hints at supported scopes: {:?}", tokens[0]);
    }

    /// Content-filter refusals get a filter-specific note rather than
    /// the generic "ask about alerts" suggestion — guides the user to
    /// rephrase rather than to broaden their question.
    #[tokio::test]
    async fn content_filter_emits_filter_specific_fallback() {
        let bus = EventBus::new();
        let rx  = bus.subscribe();
        let chunks = stream::iter(vec![Ok(ChatChunk {
            delta: String::new(),
            finish_reason: Some("content_filter".to_string()),
            usage: None,
            tool_call: None,
        })]);
        let summary = stream_to_bus(chunks, &bus, "sess-cf", Model::Gpt4oMini).await;
        assert_eq!(summary.finish_reason, Some("content_filter"));

        let mut tokens: Vec<String> = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let DaemonEvent::ChatTokenStream { token, finish_reason, .. } = ev {
                if finish_reason.is_none() {
                    tokens.push(token);
                }
            }
        }
        assert_eq!(tokens.len(), 1);
        assert!(
            tokens[0].to_lowercase().contains("safety filter"),
            "expected filter-specific note, got {:?}",
            tokens[0],
        );
    }

    /// Stream-level errors used to be invisible — the IPC published an
    /// empty close event and the user saw a blank bubble. The error
    /// message now rides through as a token so the actual cause (no
    /// pairing, 401, rate limit, etc.) is visible.
    #[tokio::test]
    async fn stream_error_surfaces_error_message() {
        let bus = EventBus::new();
        let rx  = bus.subscribe();
        let chunks = stream::iter(vec![Err(OpenAIError::Api {
            status: 401,
            body:   "Unauthorized".to_string(),
        })]);
        let summary = stream_to_bus(chunks, &bus, "sess-err", Model::Gpt4oMini).await;
        assert_eq!(summary.finish_reason, Some("error"));

        let mut error_token: Option<String> = None;
        let mut close_reason: Option<String> = None;
        while let Ok(ev) = rx.try_recv() {
            if let DaemonEvent::ChatTokenStream { token, finish_reason, .. } = ev {
                match finish_reason {
                    Some(r) => close_reason = Some(r),
                    None    => error_token  = Some(token),
                }
            }
        }
        assert_eq!(close_reason.as_deref(), Some("error"));
        let body = error_token.expect("error message published as a token");
        assert!(body.contains("chat error"), "wraps error as a chat error note: {body:?}");
        assert!(body.contains("401"), "carries the underlying status: {body:?}");
    }

    /// When the LLM only emits a tool call (no text), the fallback
    /// suppresses itself so the tool-call card is the user's view of
    /// what happened. Without this guard the bubble would render both
    /// a tool card AND the "ask about alerts" hint, which is confusing.
    #[tokio::test]
    async fn tool_call_only_response_skips_fallback() {
        let bus = EventBus::new();
        let rx  = bus.subscribe();
        let chunks = stream::iter(vec![
            tool_call_delta(0, Some("call_z"), Some("desktop.query_alerts"), "{}"),
            tool_calls_done(),
        ]);
        let _ = stream_to_bus(chunks, &bus, "sess-tc-only", Model::Gpt4oMini).await;

        let mut text_tokens = 0;
        let mut tool_call_seen = false;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                DaemonEvent::ChatTokenStream { token, finish_reason, .. } => {
                    if finish_reason.is_none() && !token.is_empty() {
                        text_tokens += 1;
                    }
                }
                DaemonEvent::ChatToolCall { .. } => {
                    tool_call_seen = true;
                }
                _ => {}
            }
        }
        assert!(tool_call_seen, "tool call event published");
        assert_eq!(text_tokens, 0, "no fallback token when a tool call was emitted");
    }
}
