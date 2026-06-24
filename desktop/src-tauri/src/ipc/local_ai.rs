//! IPC surface for the opt-in local LLM (Settings → AI → Local AI).
//!
//! Three commands:
//!   * `local_ai_load`   — trigger background model download + load (idempotent).
//!   * `local_ai_infer`  — stream one turn; tokens arrive as `local-ai-token`
//!                          Tauri events; `local-ai-done` / `local-ai-error` close it.
//!   * `local_ai_status` — return current load phase as a string.
//!
//! The commands are always compiled. When the `local-ai` Cargo feature is
//! disabled (e.g. `cargo test --lib --no-default-features`) every command
//! returns an error string instead of touching mistralrs, letting the test
//! suite run on Windows without the native DLL start-up issue.

use serde::Serialize;

// ── status DTO (always compiled) ─────────────────────────────────────────────

/// Wire shape returned by `local_ai_status` and `local_ai_load`.
#[derive(Serialize)]
pub struct LocalAiStatusDto {
    /// `"idle"` | `"loading"` | `"ready"` | `"failed"`.
    pub status: String,
    /// Human-readable model label (always set, even when not loaded).
    pub model:  String,
    /// Approximate peak RAM in MB when resident (0 when not loaded).
    pub ram_mb: u32,
    /// Non-empty only when `status == "failed"`.
    pub error:  String,
}

// ── real implementation (requires `local-ai` feature) ────────────────────────

#[cfg(feature = "local-ai")]
use {
    std::sync::Arc,
    crate::local_ai::chat_infer::{
        LoadStatus, LocalChatAI,
        LOCAL_CHAT_MODEL_DISPLAY, LOCAL_CHAT_RAM_MB,
    },
};

#[cfg(feature = "local-ai")]
fn status_dto(ai: &LocalChatAI) -> LocalAiStatusDto {
    let (status_str, error_str) = match ai.load_status() {
        LoadStatus::Idle      => ("idle".into(),    String::new()),
        LoadStatus::Loading   => ("loading".into(), String::new()),
        LoadStatus::Ready     => ("ready".into(),   String::new()),
        LoadStatus::Failed(e) => ("failed".into(),  e),
    };
    LocalAiStatusDto {
        status: status_str,
        model:  LOCAL_CHAT_MODEL_DISPLAY.into(),
        ram_mb: LOCAL_CHAT_RAM_MB,
        error:  error_str,
    }
}

/// Trigger background download + load. Idempotent — safe to call multiple
/// times; subsequent calls while Loading or Ready are no-ops.
#[tauri::command]
#[cfg(feature = "local-ai")]
pub fn local_ai_load(
    state: tauri::State<'_, Arc<LocalChatAI>>,
) -> Result<LocalAiStatusDto, String> {
    state.trigger_load();
    Ok(status_dto(state.inner()))
}

#[tauri::command]
#[cfg(not(feature = "local-ai"))]
pub fn local_ai_load() -> Result<LocalAiStatusDto, String> {
    Err("Local AI not compiled — enable the `local-ai` Cargo feature".into())
}

/// Run one inference turn. Tokens stream back as Tauri events:
///   * `local-ai-token`  — `{ session_id, token }` on each generated token
///   * `local-ai-done`   — `session_id` when complete
///   * `local-ai-error`  — `{ session_id, error }` on failure
///
/// Returns immediately — inference runs on a background task.
#[tauri::command]
#[cfg(feature = "local-ai")]
pub fn local_ai_infer(
    state:      tauri::State<'_, Arc<LocalChatAI>>,
    app:        tauri::AppHandle,
    session_id: String,
    prompt:     String,
) -> Result<(), String> {
    let handle = Arc::clone(&state);
    tauri::async_runtime::spawn(async move {
        LocalChatAI::infer(handle, session_id, prompt, app).await;
    });
    Ok(())
}

#[tauri::command]
#[cfg(not(feature = "local-ai"))]
pub fn local_ai_infer(
    session_id: String,
    prompt:     String,
    app:        tauri::AppHandle,
) -> Result<(), String> {
    let _ = (session_id, prompt, app);
    Err("Local AI not compiled — enable the `local-ai` Cargo feature".into())
}

/// Return the current load phase without blocking.
#[tauri::command]
#[cfg(feature = "local-ai")]
pub fn local_ai_status(
    state: tauri::State<'_, Arc<LocalChatAI>>,
) -> Result<LocalAiStatusDto, String> {
    Ok(status_dto(state.inner()))
}

#[tauri::command]
#[cfg(not(feature = "local-ai"))]
pub fn local_ai_status() -> Result<LocalAiStatusDto, String> {
    Ok(LocalAiStatusDto {
        status: "idle".into(),
        model:  "not compiled".into(),
        ram_mb: 0,
        error:  String::new(),
    })
}
