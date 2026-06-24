//! `inari-search` — Inari Live Tier 0 search.
//!
//! ## What this crate does
//!
//! Given an error string from Capture (or any user-supplied text),
//! return ranked hits from the public web (Stack Overflow, GitHub
//! Issues, MDN). Results are SQLite-cached for 7 days under a
//! content-addressed key so retrying the same error is O(1) ms.
//!
//! ## What this crate does NOT do (per S13 prompt)
//!
//! - **No baked Stack Exchange key.** Anonymous-only — per-IP quotas
//!   keep each user on their own 300/day cap (vs. per-key shared
//!   across all users on a release). See `INARI_SEARCH_RESEARCH.md`
//!   §D for the rationale.
//! - **No offline tier.** No tantivy index, no devdocs/MDN bundle.
//!   That's S14.
//! - **No Wikipedia / DuckDuckGo / Brave / SearXNG.** Out of v1 scope.
//! - **No registry lookups (crates.io / npm / PyPI).** S14 will route
//!   `Family::ImportError` there; the fingerprint module already
//!   detects the family for that future hand-off.
//! - **No witness emission.** When the agent invokes
//!   `search.error_context`, the existing `ToolRegistry` already
//!   captures args + result via `WitnessEmitter`. Doubling the emit
//!   here would corrupt the receipt hashes.
//!
//! ## Public surface
//!
//! ```ignore
//! use inari_search::{Searcher, SearchRequest};
//! # async fn run() -> Result<(), inari_search::SearchError> {
//! let searcher = Searcher::new("./cache".into()).await?;
//! let resp = searcher.search(SearchRequest {
//!     error_text: "TypeError: x is undefined".into(),
//!     language: Some("javascript".into()),
//!     framework: None,
//!     max_hits: 20,
//! }).await?;
//! for hit in resp.hits {
//!     println!("{}\t{}\t{}", hit.source.label(), hit.score, hit.url);
//! }
//! # Ok(()) }
//! ```

#![warn(unreachable_pub)]

pub mod cache;
pub mod fingerprint;
pub mod online;
pub mod types;

pub use cache::Cache;
pub use fingerprint::{fingerprint as fingerprint_request, Family, Fingerprint, Language};
pub use online::Dispatcher;
pub use types::{
    CacheStatus, Hit, HitMeta, SearchError, SearchRequest, SearchResponse, SourceState,
    SourceStatus, SourceTag,
};
// Re-export `url::Url` so downstream callers (the desktop agent
// tool wrapper, integration tests) don't need a direct `url`
// dependency just to construct one.
pub use url::Url;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Top-level search facade. Owns one [`Cache`] handle, one shared
/// `reqwest::Client`, and one [`Dispatcher`]. Callers (the agent
/// `SearchErrorContextTool`) construct one of these once per process
/// and reuse it.
pub struct Searcher {
    cache: Arc<Cache>,
    dispatcher: Dispatcher,
}

/// Per-instance config — pulled out of [`Searcher::new`] so future
/// callers can tune timeouts without touching the public constructor.
#[derive(Debug, Clone)]
pub struct SearcherConfig {
    pub user_agent: String,
    pub request_timeout: Duration,
}

impl Default for SearcherConfig {
    fn default() -> Self {
        Self {
            user_agent: "inari-live/0.1 (https://inariwatch.com)".into(),
            request_timeout: Duration::from_millis(online::SOURCE_TIMEOUT_MS),
        }
    }
}

impl Searcher {
    /// Open the cache + build the HTTP client + wire the dispatcher.
    /// `cache_dir` must be a directory the process can write into;
    /// the cache file itself is `<cache_dir>/cache.db`.
    pub async fn new(cache_dir: PathBuf) -> Result<Self, SearchError> {
        Self::with_config(cache_dir, SearcherConfig::default()).await
    }

    pub async fn with_config(
        cache_dir: PathBuf,
        config: SearcherConfig,
    ) -> Result<Self, SearchError> {
        if !cache_dir.exists() {
            std::fs::create_dir_all(&cache_dir).map_err(|e| {
                SearchError::Io(format!(
                    "create cache dir {}: {e}",
                    cache_dir.display()
                ))
            })?;
        }
        let cache_path = cache_dir.join("cache.db");
        let cache = Arc::new(Cache::open(cache_path)?);

        let client = reqwest::Client::builder()
            .user_agent(config.user_agent.clone())
            .timeout(config.request_timeout)
            .build()
            .map_err(|e| SearchError::Internal(format!("reqwest build: {e}")))?;
        let dispatcher = Dispatcher::new(client);

        Ok(Self { cache, dispatcher })
    }

    /// One search end-to-end. Path:
    ///
    /// 1. Fingerprint the request (cache key + family + language).
    /// 2. Cache hit → mark `cache_status = Hit`, return.
    /// 3. Cache miss → dispatch to all 3 sources in parallel,
    ///    persist the response, return.
    ///
    /// `Err(SearchError)` is reserved for cache disk failures —
    /// network failures from individual sources fall through to a
    /// per-source `SourceState::Error` (the response is still `Ok`).
    pub async fn search(&self, req: SearchRequest) -> Result<SearchResponse, SearchError> {
        let started = Instant::now();
        let fp = fingerprint::fingerprint(&req);

        // Cache check.
        match self.cache.get(&fp.hash) {
            Ok(Some(entry)) => {
                let mut resp = entry.response;
                // Re-stamp the elapsed_ms with the cache-hit time
                // (microsecond range typically); preserves the "412ms"
                // value as a meaningful UI signal.
                resp.cache_status = CacheStatus::Hit;
                resp.elapsed_ms = started.elapsed().as_millis() as u64;
                return Ok(resp);
            }
            Ok(None) => {} // proceed to dispatch
            Err(e) => {
                // Cache disk error is logged but does NOT fail the
                // search — degrade to live dispatch.
                tracing::warn!(error = %e, "[inari-search] cache read failed; falling through to dispatch");
            }
        }

        // Cache miss → fan out.
        let resp = self.dispatcher.dispatch(&req).await;

        // Persist on success — but only if at least one source
        // actually produced a hit OR all sources reported a definitive
        // outcome (Ok / RateLimited / Timeout). Avoid caching pure
        // Error responses so a transient network blip doesn't poison
        // the cache for 7 days.
        if !resp.hits.is_empty() || resp.sources_used.iter().any(|s| !is_transient(&s.state)) {
            let lang = if matches!(fp.language, Language::Unknown) {
                None
            } else {
                Some(fp.language.as_str())
            };
            if let Err(e) = self
                .cache
                .set(&fp.hash, &fp.normalized, lang, &resp)
            {
                tracing::warn!(error = %e, "[inari-search] cache write failed");
            }
        }

        Ok(resp)
    }

    /// Test / debug helper — exposes the underlying cache for
    /// integration tests that want to assert on its state. Hidden
    /// behind `cfg(test)` plus `feature = "test-utils"` for
    /// downstream integration tests in the desktop crate.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn cache_for_tests(&self) -> Arc<Cache> {
        self.cache.clone()
    }
}

fn is_transient(state: &SourceState) -> bool {
    matches!(state, SourceState::Error { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir() -> PathBuf {
        let d = tempfile::tempdir().expect("tempdir");
        let p = d.path().to_path_buf();
        std::mem::forget(d);
        p
    }

    #[tokio::test]
    async fn searcher_constructs_and_creates_cache_file() {
        let dir = tmp_dir();
        let s = Searcher::new(dir.clone()).await.expect("ok");
        assert!(dir.join("cache.db").exists());
        // Cache starts empty.
        assert_eq!(s.cache.row_count().unwrap(), 0);
    }

    #[tokio::test]
    async fn searcher_creates_missing_dir() {
        let parent = tmp_dir();
        let nested = parent.join("nested").join("inari-search");
        let _s = Searcher::new(nested.clone()).await.expect("ok");
        assert!(nested.join("cache.db").exists());
    }
}
