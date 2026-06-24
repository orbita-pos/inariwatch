//! Local chat inference — opt-in offline mode (Settings → AI → Local AI).
//!
//! Uses the `mistralrs` crate (EricLBuehler/mistral.rs, which wraps
//! mistralrs-core) to load a GGUF-quantized Qwen2.5-Coder-1.5B-Instruct model
//! from Hugging Face Hub and run inference fully in-process.
//!
//! ## Model
//!
//! - Repo:  `bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF`
//! - File:  `Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf`
//! - RAM:   ~1.0 GB loaded, CPU-only (no GPU required).
//! - First load downloads the file to the HuggingFace cache directory
//!   (`~/.cache/huggingface/hub/` on all OSes) and keeps it across
//!   restarts.
//! - Specifically trained on code: stack traces, error messages, and fix
//!   suggestions are noticeably better than a general-purpose model.
//!
//! ## Lifecycle
//!
//! 1. `LocalChatAI::trigger_load()` — idempotent; spawns a background
//!    task that downloads + loads the model once. The status transitions
//!    Idle → Loading → Ready (or Failed on error).
//! 2. `LocalChatAI::infer(arc_self, session_id, prompt, app)` — takes
//!    an `Arc<Self>` so it can be `.await`ed on `tauri::async_runtime::spawn`
//!    without borrowing issues. Holds the tokio `Mutex` for the duration
//!    of the stream (single-user desktop: one concurrent inference).
//!
//! ## Events emitted by `infer`
//!
//! | Event              | Payload             | When                        |
//! |--------------------|---------------------|-----------------------------|
//! | `local-ai-token`   | `LocalAiToken`      | Each generated token        |
//! | `local-ai-done`    | `String` (session_id) | Generation complete       |
//! | `local-ai-error`   | `LocalAiError`      | Any failure                 |

use std::sync::{Arc, Mutex as StdMutex};

use mistralrs::{
    ChatCompletionChunkResponse, GgufModelBuilder, Response,
    TextMessageRole, TextMessages,
};
use serde::Serialize;
use tauri::Emitter as _;
use tokio::sync::Mutex as TokioMutex;

use crate::ai::prompts::SYSTEM_OPS;

// ── Model constants ───────────────────────────────────────────────────────────

/// HuggingFace Hub repo hosting the GGUF files.
pub const LOCAL_CHAT_MODEL_REPO: &str = "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF";
/// Quantized GGUF filename (Q4_K_M ≈ 1.0 GB on disk and in RAM).
pub const LOCAL_CHAT_MODEL_FILE: &str = "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf";
/// Human-readable display label for the Settings UI and `local_ai_status`.
pub const LOCAL_CHAT_MODEL_DISPLAY: &str = "Qwen2.5-Coder-1.5B-Instruct Q4_K_M";
/// Approximate peak RAM while the model is resident (MB).
pub const LOCAL_CHAT_RAM_MB: u32 = 1_000;

// ── Load state ────────────────────────────────────────────────────────────────

/// Phase of the lazy model load.
#[derive(Debug, Clone, PartialEq)]
pub enum LoadStatus {
    Idle,
    Loading,
    Ready,
    Failed(String),
}

// ── Tauri event payloads ──────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct LocalAiToken {
    pub session_id: String,
    pub token:      String,
}

#[derive(Serialize, Clone)]
pub struct LocalAiError {
    pub session_id: String,
    pub error:      String,
}

// ── LocalChatAI ───────────────────────────────────────────────────────────────

/// Singleton handle to the local mistralrs inference engine.
///
/// Registered as `Arc<LocalChatAI>` in Tauri managed state at boot, shared
/// across all three IPC commands (`local_ai_load`, `local_ai_infer`,
/// `local_ai_status`).
pub struct LocalChatAI {
    /// The loaded mistralrs `Model`. `None` until `trigger_load` completes.
    ///
    /// Uses `tokio::sync::Mutex` (not `std::sync::Mutex`) so we can hold
    /// the guard across `.await` points inside `infer()` while streaming
    /// — tokio's guard is `Send`, which std's is not.
    model: Arc<TokioMutex<Option<mistralrs::Model>>>,
    /// Load phase — queried synchronously (no `await`) by `is_loaded` and
    /// `load_status`. Kept separate from `model` so status checks don't
    /// block behind an in-progress inference.
    status: Arc<StdMutex<LoadStatus>>,
}

impl LocalChatAI {
    pub fn new() -> Self {
        Self {
            model:  Arc::new(TokioMutex::new(None)),
            status: Arc::new(StdMutex::new(LoadStatus::Idle)),
        }
    }

    /// Returns the current load phase without blocking.
    pub fn load_status(&self) -> LoadStatus {
        self.status.lock().unwrap().clone()
    }

    /// `true` iff the model is resident in memory and ready to infer.
    pub fn is_loaded(&self) -> bool {
        matches!(*self.status.lock().unwrap(), LoadStatus::Ready)
    }

    /// Kick off the background download + load. Idempotent — returns
    /// immediately without blocking. Subsequent calls while `Loading` or
    /// `Ready` are no-ops.
    pub fn trigger_load(&self) {
        {
            let mut st = self.status.lock().unwrap();
            if matches!(*st, LoadStatus::Loading | LoadStatus::Ready) {
                return;
            }
            *st = LoadStatus::Loading;
        }

        let model_arc  = Arc::clone(&self.model);
        let status_arc = Arc::clone(&self.status);

        tauri::async_runtime::spawn(async move {
            tracing::info!(
                repo = LOCAL_CHAT_MODEL_REPO,
                file = LOCAL_CHAT_MODEL_FILE,
                "[local-chat-ai] starting download + load"
            );

            let result = GgufModelBuilder::new(
                LOCAL_CHAT_MODEL_REPO,
                vec![LOCAL_CHAT_MODEL_FILE],
            )
            // CPU-only — paged attention is only supported on CUDA/Metal
            // builds; this build has neither feature enabled.
            .with_max_num_seqs(1)
            .build()
            .await;

            match result {
                Ok(model) => {
                    *model_arc.lock().await = Some(model);
                    *status_arc.lock().unwrap() = LoadStatus::Ready;
                    tracing::info!("[local-chat-ai] model ready — {LOCAL_CHAT_MODEL_DISPLAY}");
                }
                Err(e) => {
                    let msg = e.to_string();
                    tracing::error!(error = %msg, "[local-chat-ai] load failed");
                    *status_arc.lock().unwrap() = LoadStatus::Failed(msg);
                }
            }
        });
    }

    /// Run one inference turn and stream tokens back as Tauri events.
    ///
    /// Takes `Arc<Self>` (not `&self`) so the async block that calls
    /// `.infer()` can be `'static + Send`, meeting `spawn`'s requirements.
    ///
    /// The tokio Mutex over `model` is held for the ENTIRE streaming
    /// duration — this serialises concurrent inference calls, which is the
    /// correct behaviour for a single-user desktop app.
    pub async fn infer(
        self: Arc<Self>,
        session_id: String,
        prompt:     String,
        app:        tauri::AppHandle,
    ) {
        if !self.is_loaded() {
            let _ = app.emit("local-ai-error", LocalAiError {
                session_id,
                error: "Local AI model is not ready. \
                        Enable it in Settings → AI and wait for the download to finish."
                    .into(),
            });
            return;
        }

        // Clone the Arc before the first await so `self` isn't borrowed across it.
        let model_arc = Arc::clone(&self.model);
        let model_guard = model_arc.lock().await;

        let model = match &*model_guard {
            Some(m) => m,
            None => {
                let _ = app.emit("local-ai-error", LocalAiError {
                    session_id,
                    error: "Internal: model slot empty despite Ready status".into(),
                });
                return;
            }
        };

        let messages = TextMessages::new()
            .add_message(TextMessageRole::System, SYSTEM_OPS)
            .add_message(TextMessageRole::User, prompt.as_str());

        let mut stream = match model.stream_chat_request(messages).await {
            Ok(s)  => s,
            Err(e) => {
                let _ = app.emit("local-ai-error", LocalAiError {
                    session_id,
                    error: format!("Inference error: {e}"),
                });
                return;
            }
        };

        while let Some(chunk) = stream.next().await {
            if let Response::Chunk(ChatCompletionChunkResponse { choices, .. }) = chunk {
                if let Some(choice) = choices.first() {
                    if let Some(tok) = &choice.delta.content {
                        if !tok.is_empty() {
                            let _ = app.emit("local-ai-token", LocalAiToken {
                                session_id: session_id.clone(),
                                token:      tok.clone(),
                            });
                        }
                    }
                }
            }
        }

        let _ = app.emit("local-ai-done", session_id);
        // model_guard drops here → releases the TokioMutex.
    }
}
