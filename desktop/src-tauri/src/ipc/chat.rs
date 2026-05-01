//! Tauri-command shells for the chat surface.
//!
//! Sesión 18 introduces a single command — `start_chat_stream` — that
//! the dock invokes when the user submits a prompt. The command:
//!   1. Resolves the active OpenAI key (BYOK → platform).
//!   2. Picks a model based on the `ai_model_routing` setting.
//!   3. Asks the [`BudgetTracker`] whether the call fits today's caps;
//!      downgrades to mini or refuses outright when the verdict says
//!      so.
//!   4. Spawns the streaming task. Tokens flow back through the
//!      daemon bus → `daemon:event` Tauri channel → the dock's
//!      `installChatStreamDriver` listener.
//!
//! The session id supplied by the caller IS the dock's
//! `assistantMsg.id` — one chat-stream session = one assistant message.
//! The bus events echo the same id so the dock can attribute deltas.

use std::sync::Arc;

use serde::Deserialize;

use crate::ai::budget::{BudgetTracker, BudgetVerdict, Model};
use crate::ai::openai::{OpenAIClient, OpenAIError};
use crate::ai::prompts::{build_ask_inari_prompt, ChatMessage, RepoContext};
use crate::ai::streaming::stream_to_bus;
use crate::daemon::DaemonHandle;
use crate::store::{settings, Store};

use super::error::IpcError;

#[derive(Debug, Deserialize)]
pub struct StartChatStreamArgs {
    pub session_id: String,
    pub prompt:     String,
    /// Optional repo id to gather memory.md / file context. Sesión 18
    /// only consumes `memory.md` lazily when the indexer is wired in
    /// Sesión 19+ — for now the field is accepted so the IPC contract
    /// is forward-compatible.
    pub repo_id:    Option<String>,
}

#[tauri::command]
pub async fn start_chat_stream(
    state:  tauri::State<'_, Arc<Store>>,
    daemon: tauri::State<'_, Arc<DaemonHandle>>,
    args:   StartChatStreamArgs,
) -> Result<(), IpcError> {
    if args.session_id.trim().is_empty() {
        return Err(IpcError::Internal {
            message: "session_id is required".to_string(),
        });
    }

    let store_arc:  Arc<Store>        = state.inner().clone();
    let daemon_arc: Arc<DaemonHandle> = daemon.inner().clone();

    // ── Build the chat messages ───────────────────────────────────────
    // Sesión 18 ships the simplest path: pure Ask Inari prompt with the
    // user's question and (optionally) the repo's memory.md preamble.
    // Future sessions extend the context bag (file tree, recent code).
    let memory_md: Option<String> = match args.repo_id.as_deref() {
        Some(_repo) => {
            // Sesión 19 wires `memory::read_active_memory_md(repo_id)`.
            // For now we omit the section.
            None
        }
        None => None,
    };
    let no_files: Vec<String> = Vec::new();
    let ctx = RepoContext {
        repo_files:   &no_files,
        memory_md:    memory_md.as_deref(),
        code_context: None,
    };
    let messages: Vec<ChatMessage> = build_ask_inari_prompt(&args.prompt, &ctx);

    // ── Pick the model ───────────────────────────────────────────────
    let routing  = settings::get(&store_arc, "ai_model_routing")
        .map_err(IpcError::from)?
        .unwrap_or_else(|| "auto".to_string());
    let intended = pick_model(&routing, &args.prompt);

    // ── Budget gate ──────────────────────────────────────────────────
    let tracker        = BudgetTracker::new(store_arc.clone());
    let prompt_tokens  = BudgetTracker::estimate_prompt_tokens(&messages);
    // Estimate 1024 completion tokens — OpenAI's default `max_tokens`
    // for chat. Safe ceiling for budgeting; actual usage flows back via
    // `usage` at end-of-stream.
    let verdict = tracker
        .check(intended, prompt_tokens, 1024)
        .map_err(|e| IpcError::Internal { message: e.to_string() })?;

    let actual_model = match verdict {
        BudgetVerdict::Ok               => intended,
        BudgetVerdict::DowngradeToMini  => Model::Gpt4oMini,
        BudgetVerdict::Blocked          => {
            // Surface a clean stream-end so the dock's spinner stops.
            daemon_arc.bus.publish(crate::daemon::DaemonEvent::ChatTokenStream {
                session_id:    args.session_id.clone(),
                token:         String::new(),
                finish_reason: Some("error".to_string()),
            });
            return Err(IpcError::Internal {
                message: "Daily AI spend cap reached. Try again tomorrow or raise the cap in Settings → AI."
                    .to_string(),
            });
        }
    };

    // ── Build the OpenAI client ──────────────────────────────────────
    let client = match OpenAIClient::from_store(&store_arc) {
        Ok(c)  => c,
        Err(e) => {
            daemon_arc.bus.publish(crate::daemon::DaemonEvent::ChatTokenStream {
                session_id:    args.session_id.clone(),
                token:         String::new(),
                finish_reason: Some("error".to_string()),
            });
            return Err(IpcError::Internal { message: format!("OpenAI: {}", e) });
        }
    };

    // ── Spawn the streamer ───────────────────────────────────────────
    let session_id = args.session_id.clone();
    tauri::async_runtime::spawn(async move {
        let stream_res = client.chat_stream(&messages, actual_model).await;
        let stream = match stream_res {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, session_id = %session_id, "chat_stream open failed");
                daemon_arc.bus.publish(crate::daemon::DaemonEvent::ChatTokenStream {
                    session_id:    session_id.clone(),
                    token:         String::new(),
                    finish_reason: Some("error".to_string()),
                });
                return;
            }
        };

        let summary = stream_to_bus(stream, &daemon_arc.bus, &session_id, actual_model).await;

        // Record actual spend. If usage wasn't reported, fall back to
        // the chars/4 estimate we already computed pre-call.
        let prompt_tok = if summary.prompt_tokens > 0 {
            summary.prompt_tokens
        } else {
            prompt_tokens
        };
        let completion_tok = if summary.completion_tokens > 0 {
            summary.completion_tokens
        } else {
            // No usage from upstream — use chars-based heuristic on
            // what we captured. For now we don't track delta lengths;
            // log it and bill 0. Sesión 19 sums delta lengths in
            // `stream_to_bus` and feeds them in.
            0
        };
        if let Err(e) = tracker.record_actual(actual_model, prompt_tok, completion_tok) {
            tracing::warn!(error = %e, "budget record_actual failed");
        }
    });

    Ok(())
}

/// Decide which model to use given the routing setting + prompt heuristic.
/// `auto` routes by length: short prompts (≤ 500 chars) → Mini, longer →
/// Gpt54. Tests cover the explicit branches.
fn pick_model(routing: &str, prompt: &str) -> Model {
    match routing {
        "always_mini" => Model::Gpt4oMini,
        "always_full" => Model::Gpt54,
        _ /* auto */ => {
            if prompt.len() <= 500 {
                Model::Gpt4oMini
            } else {
                Model::Gpt54
            }
        }
    }
}

/// Map [`OpenAIError`] to [`IpcError`]. Used by tests + future commands;
/// the streaming path handles errors via the bus instead.
impl From<OpenAIError> for IpcError {
    fn from(e: OpenAIError) -> Self {
        match e {
            OpenAIError::NoKey         => IpcError::Internal {
                message: "Set your OpenAI key in Settings → AI or wait for the platform key to sync."
                    .to_string(),
            },
            OpenAIError::Store(s)      => IpcError::from(s),
            other                      => IpcError::Internal { message: other.to_string() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_model_respects_routing() {
        assert_eq!(pick_model("always_mini", "anything"), Model::Gpt4oMini);
        assert_eq!(pick_model("always_full", "anything"), Model::Gpt54);
    }

    #[test]
    fn pick_model_auto_short_prompt_to_mini() {
        let short = "Why is uptime down?";
        assert_eq!(pick_model("auto", short), Model::Gpt4oMini);
    }

    #[test]
    fn pick_model_auto_long_prompt_to_full() {
        let long = "x".repeat(800);
        assert_eq!(pick_model("auto", &long), Model::Gpt54);
    }
}
