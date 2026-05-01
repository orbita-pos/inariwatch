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
//! The function below is the only public surface; callers (the
//! `start_chat_stream` IPC command) hand it a stream + the session id
//! the user dispatched it with, and get back a [`StreamSummary`] for
//! budget bookkeeping.

use futures_util::stream::StreamExt;

use crate::daemon::{DaemonEvent, EventBus};

use super::budget::Model;
use super::openai::{ChatChunk, OpenAIError};

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

    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
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
        summary.finish_reason = Some("stop");
        bus.publish(DaemonEvent::ChatTokenStream {
            session_id:    session_id.to_string(),
            token:         String::new(),
            finish_reason: Some("stop".to_string()),
        });
    }

    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::openai::ChatChunk;
    use futures_util::stream;

    fn ok(delta: &str) -> Result<ChatChunk, OpenAIError> {
        Ok(ChatChunk { delta: delta.to_string(), finish_reason: None, usage: None })
    }
    fn done() -> Result<ChatChunk, OpenAIError> {
        Ok(ChatChunk { delta: String::new(), finish_reason: Some("stop".to_string()), usage: None })
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
}
