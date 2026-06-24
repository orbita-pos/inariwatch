//! Search tool cluster (S13) — one tool, `search.error_context`,
//! that fans out to Stack Overflow + GitHub Issues + MDN and returns
//! merged + deduped hits with cache.
//!
//! | name                    | default | wraps                                      |
//! |-------------------------|---------|--------------------------------------------|
//! | `search.error_context`  | [`Auto`] | [`inari_search::Searcher::search`]        |
//!
//! ## Why `Auto` and not `Confirm`?
//!
//! Search is read-only, free, and bounded under 1s per call (cache
//! hit < 50ms; cache miss capped by the 800ms wall budget). Pedir
//! confirm en cada search sería ruidoso para esta UX y rompe el
//! "always available, never noisy" principle from S13's prompt.
//! Users who want to lock it down can flip it to `Confirm` from
//! Settings → Permissions (S11 panel).
//!
//! ## Backend pattern (vs S5)
//!
//! Same `XBackend` seam as `comm` — async trait + feature-gated
//! mocks. The mock recorded-call shape lets `tests/agent_search_tool.rs`
//! drive the registry's full pipeline (lookup → schema validate →
//! permission gate → witness open → execute → witness close → audit
//! insert) without touching the live SO/GH/MDN endpoints.
//!
//! ## Witness emission
//!
//! Per the S13 prompt: NO witness emit from inside this module. The
//! `ToolRegistry::invoke_traced` pipeline already opens + closes a
//! `WitnessReceipt` around `tool.execute()`, hashing args + result
//! into the SHA-256 digests. Doubling the emit here would corrupt
//! the receipt args_sha256 (the registry would see one set, the
//! search call another, and the audit row would link to the wrong
//! one).
//!
//! [`Auto`]: super::super::PermissionLevel::Auto

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::super::{
    ChatTool, PermissionLevel, RegistryError, ToolError, ToolInvocation, ToolMeta, ToolOutput,
    ToolRegistry,
};

// ── Backend trait ───────────────────────────────────────────────────────────

/// Search seam. The tool layer never touches `inari_search` directly;
/// this trait keeps mocks honest and isolates the production calls in
/// one place ([`TauriSearchBackend`]).
#[async_trait]
pub trait SearchBackend: Send + Sync + 'static {
    async fn search(
        &self,
        req: inari_search::SearchRequest,
    ) -> Result<inari_search::SearchResponse, BackendError>;
}

/// Backend-side errors. Always carry a string for transport — the
/// agent's error UI shows them verbatim.
#[derive(Debug, Clone)]
pub struct BackendError(pub String);

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BackendError {}

impl From<inari_search::SearchError> for BackendError {
    fn from(e: inari_search::SearchError) -> Self {
        BackendError(format!("inari-search: {e}"))
    }
}

// ── Production backend ─────────────────────────────────────────────────────

/// Production [`SearchBackend`] — wraps an [`inari_search::Searcher`].
pub struct TauriSearchBackend {
    inner: Arc<inari_search::Searcher>,
}

impl TauriSearchBackend {
    pub fn new(inner: Arc<inari_search::Searcher>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl SearchBackend for TauriSearchBackend {
    async fn search(
        &self,
        req: inari_search::SearchRequest,
    ) -> Result<inari_search::SearchResponse, BackendError> {
        self.inner.search(req).await.map_err(BackendError::from)
    }
}

// ── Bundle ─────────────────────────────────────────────────────────────────

/// Container for the cluster's backends. One trait so far, but kept
/// in its own struct for symmetry with `DesktopOsBackends` /
/// `LocalExecBackends` / `CommBackends` — the `register_search_tools`
/// helper takes this by value.
pub struct SearchToolBackends {
    pub backend: Arc<dyn SearchBackend>,
}

impl SearchToolBackends {
    /// Production constructor — wraps the shared `Arc<Searcher>` that
    /// `lib.rs::run` builds once at boot.
    pub fn from_searcher(searcher: Arc<inari_search::Searcher>) -> Self {
        Self {
            backend: Arc::new(TauriSearchBackend::new(searcher)),
        }
    }
}

// ── Schema + meta ──────────────────────────────────────────────────────────

fn search_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["error_text"],
        "properties": {
            "error_text": { "type": "string", "minLength": 1, "maxLength": 8192 },
            "language":   { "type": "string", "maxLength": 64 },
            "framework":  { "type": "string", "maxLength": 64 },
            "max_hits":   { "type": "integer", "minimum": 1, "maximum": 50 }
        }
    })
}

fn search_error_context_meta() -> ToolMeta {
    ToolMeta {
        name: "search.error_context".into(),
        description:
            "Search the public web (Stack Overflow + GitHub Issues + MDN) for the given \
             error string and return ranked, deduped hits with excerpts. Anonymous quotas — \
             no key needed. Cached for 7 days. Use this when the user wants outside \
             references for an error before deciding whether to ask Inari to fix it."
                .into(),
        params_schema: search_schema(),
        // Auto: read-only, free, < 1s. Confirm-on-every-search is too
        // noisy for this UX. User can opt into Confirm in Settings →
        // Permissions if they want a manual gate.
        default_permission: PermissionLevel::Auto,
    }
}

/// Per-cluster catalog of `ToolMeta`. `catalog_all()` (in
/// `super::mod`) chains this after the desktop_os / local_exec / comm
/// catalogs.
pub fn catalog() -> Vec<ToolMeta> {
    vec![search_error_context_meta()]
}

// ── Tool ───────────────────────────────────────────────────────────────────

/// `search.error_context` — one tool, the cluster's whole surface.
pub struct SearchErrorContextTool {
    meta: ToolMeta,
    backend: Arc<dyn SearchBackend>,
}

impl SearchErrorContextTool {
    pub fn new(backend: Arc<dyn SearchBackend>) -> Self {
        Self {
            meta: search_error_context_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for SearchErrorContextTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        // Schema is already validated by the registry; we still
        // defensively unwrap so a future refactor that bypasses the
        // gate doesn't NPE inside the search call.
        let error_text = invocation
            .args
            .get("error_text")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing error_text".into()))?
            .to_string();
        let language = invocation
            .args
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_string);
        let framework = invocation
            .args
            .get("framework")
            .and_then(Value::as_str)
            .map(str::to_string);
        let max_hits = invocation
            .args
            .get("max_hits")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(20);

        let req = inari_search::SearchRequest {
            error_text,
            language,
            framework,
            max_hits,
        };

        let resp = self
            .backend
            .search(req)
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.0))?;

        // Render summary first so the chat surface gets a one-liner
        // even when the response carries 0 hits ("Stack Overflow ✓ 8 ·
        // GitHub × rate-limited · MDN ✓ 3" → "12 hits · cache miss").
        let summary = build_summary(&resp);

        // Wire shape mirrors the SearchResponse exactly so the
        // frontend ts-rs-style decoder can reuse the crate's types.
        // We serialize via serde_json::to_value so the wire keeps the
        // tag fields (HitMeta::source, SourceState::kind) the
        // frontend matches on.
        let value = serde_json::to_value(&resp)
            .map_err(|e| ToolError::Internal(format!("serialize response: {e}")))?;

        Ok(ToolOutput {
            value,
            summary: Some(summary),
        })
    }
}

fn build_summary(resp: &inari_search::SearchResponse) -> String {
    let cache_label = match resp.cache_status {
        inari_search::CacheStatus::Hit => "cache hit",
        inari_search::CacheStatus::Miss => "cache miss",
        inari_search::CacheStatus::PartialMiss => "partial cache",
    };
    format!(
        "{} sources in {}ms · {}",
        resp.hits.len(),
        resp.elapsed_ms,
        cache_label
    )
}

// ── Register ───────────────────────────────────────────────────────────────

/// Register the one search tool on `reg`. Errors propagate the first
/// [`RegistryError::DuplicateTool`] — same shape as
/// [`super::desktop_os::register_desktop_os_tools`].
pub fn register_search_tools(
    reg: &ToolRegistry,
    backends: SearchToolBackends,
) -> Result<(), RegistryError> {
    reg.register(Arc::new(SearchErrorContextTool::new(backends.backend)))?;
    Ok(())
}

// ── Mocks (gated) ──────────────────────────────────────────────────────────

#[cfg(any(test, feature = "agent-test-utils"))]
pub mod mocks {
    //! Test-only backend impls. Same gating policy as
    //! [`super::super::comm::mocks`] / [`super::super::local_exec::mocks`].

    use super::*;
    use std::sync::Mutex;

    /// One recorded call to the mock. The integration suite asserts
    /// on `req.error_text` to verify the args were forwarded
    /// correctly.
    #[derive(Debug, Clone)]
    pub struct SearchCall {
        pub req: inari_search::SearchRequest,
    }

    pub struct MockSearchBackend {
        inner: Mutex<MockState>,
    }

    impl Default for MockSearchBackend {
        fn default() -> Self {
            Self::new()
        }
    }

    struct MockState {
        calls: Vec<SearchCall>,
        next_response: Option<inari_search::SearchResponse>,
        next_error: Option<String>,
    }

    impl MockSearchBackend {
        pub fn new() -> Self {
            Self {
                inner: Mutex::new(MockState {
                    calls: Vec::new(),
                    next_response: None,
                    next_error: None,
                }),
            }
        }

        /// Pre-load the response the next `search()` call returns.
        /// FIFO — each call consumes one queued response. When empty,
        /// returns `SearchResponse::empty()`.
        pub fn enqueue_response(&self, resp: inari_search::SearchResponse) {
            self.inner.lock().unwrap().next_response = Some(resp);
        }

        /// Pre-load an error for the next `search()` call.
        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }

        pub fn calls(&self) -> Vec<SearchCall> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl SearchBackend for MockSearchBackend {
        async fn search(
            &self,
            req: inari_search::SearchRequest,
        ) -> Result<inari_search::SearchResponse, BackendError> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(SearchCall { req });
            if let Some(err) = s.next_error.take() {
                return Err(BackendError(err));
            }
            Ok(s.next_response.take().unwrap_or_else(inari_search::SearchResponse::empty))
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use mocks::MockSearchBackend;

    fn invocation(args: Value) -> ToolInvocation {
        ToolInvocation {
            id: "test-id".into(),
            tool_name: "search.error_context".into(),
            args,
            session_id: None,
        }
    }

    #[test]
    fn meta_advertises_auto_default() {
        let tool = SearchErrorContextTool::new(Arc::new(MockSearchBackend::new()));
        assert_eq!(tool.meta().name, "search.error_context");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Auto);
    }

    #[test]
    fn schema_requires_error_text() {
        let meta = search_error_context_meta();
        let required = &meta.params_schema["required"];
        assert_eq!(required, &json!(["error_text"]));
    }

    #[test]
    fn schema_caps_error_text_max_length() {
        let meta = search_error_context_meta();
        let max = meta.params_schema["properties"]["error_text"]["maxLength"]
            .as_u64()
            .unwrap();
        assert_eq!(max, 8192);
    }

    #[tokio::test]
    async fn execute_forwards_args_to_backend() {
        let backend = Arc::new(MockSearchBackend::new());
        let tool = SearchErrorContextTool::new(backend.clone());
        let inv = invocation(json!({
            "error_text": "TypeError: x",
            "language": "javascript",
            "framework": "react",
            "max_hits": 15
        }));
        let out = tool.execute(&inv).await.expect("ok");
        assert!(out.summary.unwrap_or_default().contains("cache miss"));
        // 0 hits when no response queued.
        assert_eq!(out.value["hits"].as_array().unwrap().len(), 0);

        let calls = backend.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].req.error_text, "TypeError: x");
        assert_eq!(calls[0].req.language.as_deref(), Some("javascript"));
        assert_eq!(calls[0].req.framework.as_deref(), Some("react"));
        assert_eq!(calls[0].req.max_hits, 15);
    }

    #[tokio::test]
    async fn execute_returns_response_value_with_full_shape() {
        use inari_search::{
            CacheStatus, Hit, HitMeta, SearchResponse, SourceState, SourceStatus, SourceTag, Url,
        };
        let backend = Arc::new(MockSearchBackend::new());
        let mut canned = SearchResponse::empty();
        canned.hits.push(Hit {
            title: "How to fix TypeError".into(),
            url: Url::parse("https://stackoverflow.com/questions/100").unwrap(),
            excerpt: "Try logging the value first.".into(),
            source: SourceTag::StackOverflow,
            score: 0.8,
            meta: HitMeta::StackOverflow {
                vote_count: 80,
                is_accepted: true,
                answer_count: 3,
            },
        });
        canned.sources_used.push(SourceStatus {
            source: SourceTag::StackOverflow,
            state: SourceState::Ok { hit_count: 1 },
        });
        canned.cache_status = CacheStatus::Hit;
        canned.elapsed_ms = 12;
        backend.enqueue_response(canned);

        let tool = SearchErrorContextTool::new(backend);
        let inv = invocation(json!({ "error_text": "TypeError" }));
        let out = tool.execute(&inv).await.expect("ok");
        let v = out.value;
        assert_eq!(v["cache_status"], json!("hit"));
        assert_eq!(v["hits"].as_array().unwrap().len(), 1);
        assert_eq!(v["hits"][0]["source"], json!("stack_overflow"));
        assert_eq!(v["hits"][0]["meta"]["source"], json!("stack_overflow"));
        assert_eq!(v["hits"][0]["meta"]["is_accepted"], json!(true));
        assert!(out.summary.unwrap().contains("cache hit"));
    }

    #[tokio::test]
    async fn execute_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockSearchBackend::new());
        backend.fail_next("upstream blew up");
        let tool = SearchErrorContextTool::new(backend);
        let err = tool
            .execute(&invocation(json!({ "error_text": "x" })))
            .await
            .expect_err("must fail");
        match err {
            ToolError::ExecutionFailed(m) => assert_eq!(m, "upstream blew up"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn execute_uses_default_max_hits_when_unset() {
        let backend = Arc::new(MockSearchBackend::new());
        let tool = SearchErrorContextTool::new(backend.clone());
        let _ = tool
            .execute(&invocation(json!({ "error_text": "x" })))
            .await
            .expect("ok");
        let calls = backend.calls();
        assert_eq!(calls[0].req.max_hits, 20);
    }

    #[test]
    fn catalog_returns_one_meta() {
        assert_eq!(catalog().len(), 1);
        assert_eq!(catalog()[0].name, "search.error_context");
    }
}
