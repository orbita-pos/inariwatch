//! Layer 1 + Layer 2 intent classification IPC commands.
//!
//! **Layer 1** (`classify_intent_semantic`): On the first call, `get_or_init`
//! bootstraps the nearest-centroid ONNX classifier — loads the cached
//! centroids or computes them from ~90 built-in phrases via fastembed.
//! All subsequent calls hit the in-memory `OnceLock` (zero overhead).
//!
//! **Layer 2** (`classify_intent_l2`): Zero-shot Qwen classification via
//! the web `/api/ai/classify` endpoint. Requires an active desktop connection
//! (bearer token). Returns `None` when disconnected or on any error — the
//! caller always falls through to the full LLM in that case.

use std::sync::Arc;

use tauri::Manager;

use crate::ai::semantic_classifier::{get_or_init, SemanticMatch};
use crate::cloud::api::{http_client, read_dashboard_creds_arc};
use crate::store::Store;

// ── Layer 2 wire types ─────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct ClassifyResponse {
    intent:     Option<String>,
    confidence: f32,
}

// ── Commands ───────────────────────────────────────────────────────────

/// Classify `text` using the Layer-2 Qwen zero-shot oracle.
///
/// POSTs `{text}` to `<dashboard_url>/api/ai/classify` with the stored
/// bearer token. Always returns `Ok(None)` on any error — the caller
/// falls through to the full LLM in that case.
#[tauri::command]
pub async fn classify_intent_l2(
    text: String,
    store: tauri::State<'_, Arc<Store>>,
) -> Result<Option<SemanticMatch>, ()> {
    Ok(classify_intent_l2_inner(text, &store).await)
}

async fn classify_intent_l2_inner(text: String, store: &Arc<Store>) -> Option<SemanticMatch> {
    let creds = read_dashboard_creds_arc(store);
    let token = creds.token?;
    let url = format!(
        "{}/api/ai/classify",
        creds.base_url.trim_end_matches('/')
    );

    let resp = http_client()
        .post(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let body: ClassifyResponse = resp.json().await.ok()?;
    let intent = body.intent?;
    if intent.is_empty() {
        return None;
    }

    Some(SemanticMatch { intent, confidence: body.confidence })
}

/// Classify `text` using the Layer-1 nearest-centroid ONNX classifier.
///
/// Returns `null` (TypeScript) when:
///   - The centroid bootstrap hasn't completed yet (shouldn't happen — the
///     first sendMessage call always blocks until it's done via spawn_blocking).
///   - The fastembed model isn't downloaded yet (first offline launch).
///   - No intent exceeds its similarity threshold.
///
/// `app` is injected by Tauri — never supplied by the frontend.
#[tauri::command]
pub async fn classify_intent_semantic(
    text: String,
    app: tauri::AppHandle,
) -> Option<SemanticMatch> {
    let cache_path = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|p| p.join("inari-live").join("intent-centroids.json"));

    tokio::task::spawn_blocking(move || get_or_init(cache_path).classify(&text))
        .await
        .ok()
        .flatten()
}
