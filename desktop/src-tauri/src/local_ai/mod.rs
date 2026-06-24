//! Local AI facade — single entry point for downstream sessions.
//!
//! S22 (LSP completions) and S25 (Fast Apply) call
//! [`LocalAI::generate`] and never touch the runtime / registry
//! directly. Adding a new model means: adding a row to the catalogue
//! ([`registry::catalogue`]) + ensuring the runtime can locate the
//! sidecar binary on the target platform.
//!
//! See `INARI_LIVE_V0_2_HANDOFF.md` § S21 for the full design + the
//! cascade [`LocalAI::generate`] follows when a model is not yet
//! cached.
//!
//! ## Streaming
//!
//! [`LocalAI::generate`] returns `Pin<Box<dyn Stream<Item = Result<Token>>>>`
//! — the same shape `OpenAIClient::chat_stream` returns from
//! `crate::ai::openai`. Callers can `.next().await` tokens as they
//! arrive. The stream ends when the sidecar emits a chunk with a
//! non-`None` `finish_reason` or the underlying connection closes.
//!
//! ## fim_mode
//!
//! S21 plumbs the `fim_mode` flag through but does NOT wrap the
//! prompt with Qwen's `<｜fim_prefix｜>` / `<｜fim_suffix｜>` /
//! `<｜fim_middle｜>` markers. That wrapping is S23's job (the LSP
//! completion handler builds the FIM prompt with the right context
//! window). For now, `fim_mode = true` only matters in two places:
//! (1) it lets the registry pick a model registered as
//! [`registry::ModelFamily::Tab`] when the caller hasn't pinned a
//! `model_id`, and (2) it documents intent for the audit log. The
//! actual FIM-token wrap lands in S23's `fim.rs`.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::store::Store;

#[cfg(feature = "local-ai")]
pub mod chat_infer;
pub mod hardware;
pub mod registry;
pub mod runtime;

pub use hardware::{HardwareSnapshot, HardwareTier};
pub use registry::{ModelFamily, ModelRegistry, ModelSpec, RegistryError};
pub use runtime::{ModelEndpoint, RuntimeError, RuntimeManager, SidecarPaths};

/// Top-level facade. Cloneable, holds Arcs internally.
#[derive(Clone)]
pub struct LocalAI {
    registry: ModelRegistry,
    runtime:  RuntimeManager,
    http:     reqwest::Client,
}

#[derive(Debug, Error)]
pub enum LocalAiError {
    #[error("registry: {0}")]
    Registry(#[from] RegistryError),
    #[error("runtime: {0}")]
    Runtime(#[from] RuntimeError),
    #[error("network: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid streaming chunk: {0}")]
    BadChunk(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// One streamed completion chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    /// Delta text. Empty on the closing chunk that only carries
    /// `finish_reason`.
    pub text:          String,
    /// `Some("stop" | "length" | …)` on the chunk that ends the
    /// stream. The wire encoding mirrors llama-server's
    /// `/v1/completions` SSE response (which mirrors OpenAI's).
    pub finish_reason: Option<String>,
}

/// Knobs accepted by [`LocalAI::generate`]. Kept as a struct (rather
/// than positional args) so future sessions can extend without
/// breaking call-sites.
#[derive(Debug, Clone)]
pub struct GenerateOptions {
    pub model_id:    String,
    pub prompt:      String,
    pub max_tokens:  u32,
    pub stop_seqs:   Vec<String>,
    /// FIM mode flag. S21 plumbs it through; S23 wraps the prompt
    /// with `<｜fim_prefix｜> … <｜fim_suffix｜> … <｜fim_middle｜>`
    /// markers when this is `true`. See module docs.
    pub fim_mode:    bool,
    /// Sampling temperature. `None` lets llama-server use its default
    /// (`0.8` at the time of writing). S24's n=3 ranking pipeline sets
    /// this to `Some(0.7)` so the parallel calls return varied
    /// candidates the ranker can choose between.
    pub temperature: Option<f32>,
}

impl LocalAI {
    /// Construct a facade against a real store + sidecar paths. The
    /// `paths` argument tells [`RuntimeManager`] where to look for
    /// the bundled `llama-server` binary.
    pub fn new(store: Arc<Store>, paths: SidecarPaths) -> Result<Self, LocalAiError> {
        let registry = ModelRegistry::new(store)?;
        let runtime  = RuntimeManager::new(paths);
        let http = reqwest::Client::builder()
            // Streaming completions can take 30+ seconds on a large
            // prompt + small model. We rely on the per-chunk read
            // timeout reqwest applies in streaming mode rather than
            // a global one.
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self { registry, runtime, http })
    }

    /// Test/explicit constructor — caller wires the components by
    /// hand. Used by the integration tests in
    /// `tests/local_ai_*.rs` to swap the registry's CDN base URL
    /// and the runtime's external endpoints.
    pub fn from_parts(
        registry: ModelRegistry,
        runtime:  RuntimeManager,
    ) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("reqwest client builds");
        Self { registry, runtime, http }
    }

    /// Underlying handles. Tests use these to drive the components
    /// directly without going through the facade.
    pub fn registry(&self) -> &ModelRegistry { &self.registry }
    pub fn runtime(&self)  -> &RuntimeManager { &self.runtime }

    /// Streaming completion. Resolves the cached GGUF (downloading
    /// if absent), spawns the sidecar (or reuses an existing one),
    /// then opens an SSE stream against `/completion` and yields
    /// [`Token`]s as they arrive.
    pub async fn generate(
        &self,
        opts: GenerateOptions,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Token, LocalAiError>> + Send>>, LocalAiError> {
        let model_id = opts.model_id.clone();

        // Step 1 — endpoint. If a test (or future remote-llama-server)
        // already pinned an external endpoint for this model, use it.
        // Otherwise verify-or-download + spawn a sidecar.
        let endpoint = if self.runtime.is_loaded(&model_id).await {
            self.runtime.endpoint_for(&model_id).await?
        } else {
            // Verify the model is on disk first — surfaces a clean
            // RegistryError if the catalogue lookup fails or the
            // download/verify trips. This is what makes "lazy
            // download" work end-to-end inside generate().
            let gguf = self.registry.ensure_local(&model_id).await?;
            self.runtime.spawn_sidecar(&model_id, &gguf, Duration::from_secs(30)).await?
        };

        // Step 2 — fire the SSE request. llama-server's
        // `/completion` endpoint accepts a JSON body and replies
        // with `data: { ... }\n\n` framed events when `stream:true`.
        let mut body = serde_json::json!({
            "prompt":      opts.prompt,
            "n_predict":   opts.max_tokens,
            "stop":        opts.stop_seqs,
            "stream":      true,
            // Hint llama-server which mode we're in; it currently
            // ignores this field, but logging it keeps the audit
            // trail honest for S23/S25.
            "fim_mode":    opts.fim_mode,
        });
        if let Some(t) = opts.temperature {
            // llama-server reads `temperature` directly. When `None`
            // we omit the field so the server applies its built-in
            // default rather than a coerced one.
            body["temperature"] = serde_json::json!(t);
        }
        let url = format!("{}/completion", endpoint.base_url.trim_end_matches('/'));
        let resp = self.http.post(&url).json(&body).send().await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            return Err(LocalAiError::BadChunk(format!("llama-server returned HTTP {status}")));
        }

        let bytes = resp.bytes_stream();
        let stream = sse_tokens(bytes);
        Ok(Box::pin(stream))
    }
}

// ─────────────────────────────────────────────────────────────────────
// SSE parsing — same shape as `ai::openai::sse_chunks` but lighter:
// llama-server's `/completion` SSE only carries `content` + `stop` +
// optional `stop_type`. No usage frame, no tool calls.
// ─────────────────────────────────────────────────────────────────────

fn sse_tokens(
    bytes: impl Stream<Item = reqwest::Result<bytes::Bytes>> + Send + 'static,
) -> impl Stream<Item = Result<Token, LocalAiError>> + Send + 'static {
    use futures_util::stream::{self, StreamExt};

    let buf:   Vec<u8> = Vec::new();
    let state = (buf, false /* done */);

    stream::unfold(
        (Box::pin(bytes), state),
        |(mut bytes, (mut buf, mut done))| async move {
            loop {
                if done { return None; }
                if let Some((frame, rest)) = next_frame(&buf) {
                    buf = rest;
                    match parse_frame(&frame) {
                        Ok(Some(tok)) => {
                            if tok.finish_reason.is_some() { done = true; }
                            return Some((Ok(tok), (bytes, (buf, done))));
                        }
                        Ok(None) => continue, // ping comment
                        Err(e)   => return Some((Err(e), (bytes, (buf, true)))),
                    }
                }
                match bytes.next().await {
                    Some(Ok(packet)) => buf.extend_from_slice(&packet),
                    Some(Err(e))     => return Some((Err(LocalAiError::Http(e)), (bytes, (buf, true)))),
                    None             => {
                        // Drain any partial frame at end-of-stream.
                        if !buf.is_empty() {
                            if let Ok(Some(tok)) = parse_frame(&buf) {
                                return Some((Ok(tok), (bytes, (Vec::new(), true))));
                            }
                        }
                        return None;
                    }
                }
            }
        },
    )
}

fn next_frame(buf: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    for i in 1..buf.len() {
        if buf[i] == b'\n' && buf[i - 1] == b'\n' {
            let frame = buf[..i - 1].to_vec();
            let rest  = buf[i + 1..].to_vec();
            return Some((frame, rest));
        }
    }
    None
}

fn parse_frame(frame: &[u8]) -> Result<Option<Token>, LocalAiError> {
    let text = std::str::from_utf8(frame)
        .map_err(|e| LocalAiError::BadChunk(e.to_string()))?
        .trim();
    if text.is_empty() || text.starts_with(':') {
        return Ok(None); // ping
    }
    // Each frame is a series of `field: value` lines; we only care
    // about `data:`. Skip everything else.
    let mut payload: Option<&str> = None;
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("data:") {
            payload = Some(rest.trim());
            break;
        }
    }
    let Some(payload) = payload else { return Ok(None); };
    if payload == "[DONE]" {
        return Ok(Some(Token { text: String::new(), finish_reason: Some("stop".into()) }));
    }
    let json: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| LocalAiError::BadChunk(e.to_string()))?;
    let delta = json.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let stop  = json.get("stop").and_then(|v| v.as_bool()).unwrap_or(false);
    let finish = if stop {
        Some(
            json.get("stop_type")
                .and_then(|v| v.as_str())
                .unwrap_or("stop")
                .to_string(),
        )
    } else { None };
    Ok(Some(Token { text: delta, finish_reason: finish }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frame_extracts_content() {
        let frame = b"data: {\"content\":\"hello\",\"stop\":false}";
        let tok = parse_frame(frame).unwrap().unwrap();
        assert_eq!(tok.text, "hello");
        assert!(tok.finish_reason.is_none());
    }

    #[test]
    fn parse_frame_marks_stop() {
        let frame = b"data: {\"content\":\"\",\"stop\":true,\"stop_type\":\"length\"}";
        let tok = parse_frame(frame).unwrap().unwrap();
        assert_eq!(tok.text, "");
        assert_eq!(tok.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn parse_frame_handles_done_sentinel() {
        let tok = parse_frame(b"data: [DONE]").unwrap().unwrap();
        assert_eq!(tok.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parse_frame_skips_pings() {
        assert!(parse_frame(b": ping").unwrap().is_none());
        assert!(parse_frame(b"").unwrap().is_none());
    }

    #[test]
    fn next_frame_splits_on_double_lf() {
        let buf = b"data: a\n\ndata: b\n\n".to_vec();
        let (first, rest) = next_frame(&buf).unwrap();
        assert_eq!(&first, b"data: a");
        let (second, rest2) = next_frame(&rest).unwrap();
        assert_eq!(&second, b"data: b");
        assert!(rest2.is_empty());
    }
}
