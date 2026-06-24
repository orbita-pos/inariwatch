//! Inari Live pure-slash Phase 2 — natural-language → slash command
//! suggestion IPC.
//!
//! The single AI surface in the desktop chat input. The frontend (
//! `desktop/src/lib/slash/suggest-ipc.ts`) debounces the user's typing
//! and calls `suggest_slash_commands` with the raw query + the canonical
//! `SLASH_MANIFEST` serialised on the frontend side. We POST that body
//! at `<dashboard_url>/api/ai/suggest-slash` with the stored bearer
//! token and return the AI's top-3 ranked suggestions.
//!
//! Always returns `Ok(vec![])` on ANY error path — the autocomplete UI
//! treats empty as "no command matches", which is the same UX a slow /
//! offline / unauthenticated / mis-routed request should produce. We
//! never want a transient cloud blip to surface as a red toast in the
//! input dropdown.
//!
//! Auth: bearer token resolved by `read_dashboard_creds_arc`. Skipped
//! when the token is missing (`Ok(vec![])`).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cloud::api::{http_client, read_dashboard_creds_arc};
use crate::store::Store;

// ── Wire types ────────────────────────────────────────────────────────────

/// Manifest entry forwarded from the frontend's `SLASH_MANIFEST`. Mirrors
/// the TypeScript `SlashCommand` shape but kept narrow (no `examples` /
/// `tone` — those are UI-only).
///
/// `args` is left as `serde_json::Value` to avoid duplicating the arg
/// schema in both Rust and TypeScript; the manifest passes straight
/// through to the web endpoint, which does the validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashManifestEntry {
    pub name:        String,
    pub description: String,
    #[serde(default)]
    pub args:        Vec<serde_json::Value>,
}

/// Suggestion shape returned by the web endpoint. Mirrors the response
/// type at `web/app/api/ai/suggest-slash/route.ts::SlashSuggestion`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct SlashSuggestion {
    /// Full command line, e.g. `"/projects --integration=capture"`.
    /// Always starts with `/`. Frontend treats this as opaque text and
    /// drops it into the input on Enter.
    pub command:    String,
    /// 1-line rationale for the autocomplete tooltip.
    pub rationale:  String,
    /// 0..1 confidence. Used only for ranking (frontend trusts the
    /// server's order; this field is informational).
    pub confidence: f32,
}

#[derive(Debug, Deserialize)]
struct SuggestSlashResponse {
    suggestions: Vec<SlashSuggestion>,
}

#[derive(Debug, Serialize)]
struct SuggestSlashRequest<'a> {
    query:    &'a str,
    manifest: &'a [SlashManifestEntry],
    /// Phase 5.4 — formatted scoped-memory context. The frontend calls
    /// `scopedMemory.toAutocompletePromptContext()` and forwards the
    /// result here; the web endpoint splices it under a "Recent
    /// context" section in the system prompt so the LLM can resolve
    /// references like "esa alerta" into a concrete slash dispatch.
    ///
    /// Omitted when memory is empty so the wire payload stays tight
    /// for fresh sessions (the LLM doesn't need an empty block).
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_context: Option<&'a str>,
}

// ── Command ───────────────────────────────────────────────────────────────

/// Resolve the user's natural-language query into up to 3 ranked slash
/// suggestions via `POST <dashboard_url>/api/ai/suggest-slash`. The
/// canonical manifest is passed in by the frontend so this Rust layer
/// stays decoupled from the TypeScript `SLASH_MANIFEST` source of truth.
///
/// Phase 5.4 adds an optional `memory_context` parameter — the frontend
/// formats the scoped-memory ring buffer (last 3 outputs) and forwards
/// it here. We pass it through verbatim; the web endpoint validates +
/// caps the length before splicing into the system prompt.
///
/// Always returns `Ok(vec![])` on any failure path — see module docs.
#[tauri::command]
pub async fn suggest_slash_commands(
    query:          String,
    manifest:       Vec<SlashManifestEntry>,
    memory_context: Option<String>,
    store:          tauri::State<'_, Arc<Store>>,
) -> Result<Vec<SlashSuggestion>, ()> {
    Ok(suggest_slash_commands_inner(query, manifest, memory_context, &store).await)
}

async fn suggest_slash_commands_inner(
    query:          String,
    manifest:       Vec<SlashManifestEntry>,
    memory_context: Option<String>,
    store:          &Arc<Store>,
) -> Vec<SlashSuggestion> {
    // Empty query / no manifest → nothing to do. The frontend's debouncer
    // shouldn't fire on empty input but we guard anyway.
    let trimmed = query.trim();
    if trimmed.is_empty() || manifest.is_empty() {
        return Vec::new();
    }

    let creds = read_dashboard_creds_arc(store);
    let Some(token) = creds.token else {
        // Not paired with a cloud workspace yet. The autocomplete just
        // shows no suggestions; the user can still type explicit slash
        // commands.
        return Vec::new();
    };

    let url = format!(
        "{}/api/ai/suggest-slash",
        creds.base_url.trim_end_matches('/')
    );

    // Trim memory_context (empty-after-trim collapses to None so the
    // wire payload stays small) and reject empty strings before send.
    let memory_owned = memory_context
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let memory_ref = memory_owned.as_deref();

    let body = SuggestSlashRequest {
        query:    trimmed,
        manifest: &manifest,
        memory_context: memory_ref,
    };

    let Ok(resp) = http_client()
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
    else {
        return Vec::new();
    };

    if !resp.status().is_success() {
        // 401 (revoked token) / 429 (rate limited) / 500 — all surface
        // as "no suggestions" in the UI. Logged so on-call can spot a
        // recurring failure mode in the desktop traces.
        tracing::debug!(
            status = %resp.status(),
            "suggest_slash_commands: non-success response"
        );
        return Vec::new();
    }

    let Ok(parsed) = resp.json::<SuggestSlashResponse>().await else {
        return Vec::new();
    };

    parsed.suggestions
}
