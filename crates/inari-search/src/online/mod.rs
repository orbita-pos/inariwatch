//! Online dispatcher — fan out the same query to Stack Overflow,
//! GitHub Issues, and MDN in parallel and assemble the merged
//! response.
//!
//! Two contracts to keep in mind when reading this file:
//!
//! 1. **800 ms total wall-budget.** Per-source timeouts are 700 ms; the
//!    `tokio::join!` waits up to 800 ms on the slowest. A source
//!    that times out reports `SourceState::Timeout` and the dispatcher
//!    moves on without it. NO retries.
//! 2. **Empty hits != error.** When every source 0-s out and the cache
//!    has no fallback, the dispatcher returns
//!    `Ok(SearchResponse::empty())` with `cache_status: Miss`. The UI
//!    renders an empty-state card. `Err(SearchError)` is reserved for
//!    "we couldn't even try" failures (cache disk error, runtime
//!    error). The user-facing distinction matters: an empty result is
//!    legitimate (rare error string) but should be visible; a hard
//!    error needs a different UI affordance.

use crate::types::{
    CacheStatus, Hit, SearchRequest, SearchResponse, SourceState, SourceStatus, SourceTag,
};
use std::time::{Duration, Instant};

pub mod github;
pub mod mdn;
pub mod stackexchange;

/// Total wall-budget for one dispatch (cache miss path). Per-source
/// timeouts are tighter (`SOURCE_TIMEOUT_MS`) so the join completes
/// before this hard ceiling.
pub const DISPATCH_WALL_BUDGET_MS: u64 = 800;
/// Per-source request timeout. Leaves ~100 ms slack for the join +
/// merge + serialization.
pub const SOURCE_TIMEOUT_MS: u64 = 700;

/// Per-source HTTP roundtrip output. Concrete sources return one of
/// these so the dispatcher merges them uniformly.
pub struct SourceFetch {
    pub source: SourceTag,
    pub state: SourceState,
    pub hits: Vec<Hit>,
    /// Only set for [`SourceTag::StackOverflow`] — propagated to the
    /// response wrapper so the UI can show "quota nearly exhausted".
    pub quota_low: bool,
}

impl SourceFetch {
    pub fn ok(source: SourceTag, hits: Vec<Hit>) -> Self {
        let n = hits.len() as u32;
        Self {
            source,
            state: SourceState::Ok { hit_count: n },
            hits,
            quota_low: false,
        }
    }

    pub fn rate_limited(source: SourceTag) -> Self {
        Self {
            source,
            state: SourceState::RateLimited,
            hits: Vec::new(),
            quota_low: false,
        }
    }

    pub fn timeout(source: SourceTag) -> Self {
        Self {
            source,
            state: SourceState::Timeout,
            hits: Vec::new(),
            quota_low: false,
        }
    }

    pub fn error(source: SourceTag, message: impl Into<String>) -> Self {
        Self {
            source,
            state: SourceState::Error {
                message: message.into(),
            },
            hits: Vec::new(),
            quota_low: false,
        }
    }
}

/// One dispatcher — owns the HTTP client + the per-source endpoints.
/// Sources are constructed once at startup; each call to [`Self::dispatch`]
/// reuses the same `reqwest::Client` (connection pool stays warm).
pub struct Dispatcher {
    pub stackexchange: stackexchange::StackExchangeSource,
    pub github: github::GitHubSource,
    pub mdn: mdn::MdnSource,
}

impl Dispatcher {
    /// Construct sources pointing at the production endpoints. Used by
    /// `Searcher::new`. Tests construct sources individually with
    /// mockito-overridden bases.
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            stackexchange: stackexchange::StackExchangeSource::new(
                client.clone(),
                stackexchange::DEFAULT_BASE,
            ),
            github: github::GitHubSource::new(client.clone(), github::DEFAULT_BASE),
            mdn: mdn::MdnSource::new(client, mdn::DEFAULT_BASE),
        }
    }

    /// Fan out the request to every source, wait up to the wall
    /// budget, and merge the results. NEVER errors — see the
    /// "Empty hits != error" rule on the module doc.
    pub async fn dispatch(&self, req: &SearchRequest) -> SearchResponse {
        let start = Instant::now();
        let max_hits = req.effective_max_hits();

        let so_fut = run_with_timeout(SourceTag::StackOverflow, self.stackexchange.fetch(req));
        let gh_fut = run_with_timeout(SourceTag::GitHub, self.github.fetch(req));
        let mdn_fut = run_with_timeout(SourceTag::Mdn, self.mdn.fetch(req));

        // The wall budget is enforced by the per-source timeouts +
        // the join: the join completes when ALL three settle, but
        // each one is bounded above by SOURCE_TIMEOUT_MS via
        // `run_with_timeout`. So the wall is bounded by
        // SOURCE_TIMEOUT_MS plus serialization/merge overhead.
        let (so, gh, mdn) = tokio::join!(so_fut, gh_fut, mdn_fut);

        let elapsed_ms = start.elapsed().as_millis() as u64;
        merge(vec![so, gh, mdn], max_hits, CacheStatus::Miss, elapsed_ms)
    }
}

async fn run_with_timeout<F>(source: SourceTag, fut: F) -> SourceFetch
where
    F: std::future::Future<Output = SourceFetch>,
{
    match tokio::time::timeout(Duration::from_millis(SOURCE_TIMEOUT_MS), fut).await {
        Ok(fetch) => fetch,
        Err(_) => SourceFetch::timeout(source),
    }
}

/// Merge per-source fetches into one response. Algorithm:
///
/// 1. Build a per-source bucket of already-sorted hits (each source
///    returns its hits sorted internally).
/// 2. Round-robin pop from each bucket: SO[0], GH[0], MDN[0], SO[1],
///    GH[1], ..., dedupe-by-URL across rounds.
/// 3. Stop at `max_hits` hits OR all buckets empty.
///
/// Per-source `SourceStatus` rows carry the PRE-merge counts so the UI
/// shows "Stack Overflow ✓ 8" even when the merge later kept fewer
/// than 8 from that source. Status order matches the input order.
pub fn merge(
    fetches: Vec<SourceFetch>,
    max_hits: usize,
    cache_status: CacheStatus,
    elapsed_ms: u64,
) -> SearchResponse {
    let mut sources_used: Vec<SourceStatus> = Vec::with_capacity(fetches.len());
    let mut buckets: Vec<Vec<Hit>> = Vec::with_capacity(fetches.len());
    let mut quota_low = false;

    for f in fetches {
        sources_used.push(SourceStatus {
            source: f.source,
            state: f.state,
        });
        if f.quota_low {
            quota_low = true;
        }
        buckets.push(f.hits);
    }

    let mut out: Vec<Hit> = Vec::with_capacity(max_hits);
    let mut seen_urls = std::collections::HashSet::<String>::new();
    let mut all_empty;
    loop {
        all_empty = true;
        for bucket in buckets.iter_mut() {
            if out.len() >= max_hits {
                break;
            }
            if bucket.is_empty() {
                continue;
            }
            all_empty = false;
            let hit = bucket.remove(0);
            let key = hit.url.as_str().to_string();
            if seen_urls.insert(key) {
                out.push(hit);
            }
        }
        if out.len() >= max_hits || all_empty {
            break;
        }
    }

    SearchResponse {
        hits: out,
        sources_used,
        cache_status,
        elapsed_ms,
        quota_low,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::HitMeta;
    use url::Url;

    fn hit(source: SourceTag, url: &str, score: f32) -> Hit {
        let meta = match source {
            SourceTag::StackOverflow => HitMeta::StackOverflow {
                vote_count: 0,
                is_accepted: false,
                answer_count: 0,
            },
            SourceTag::GitHub => HitMeta::GitHub {
                reaction_count: 0,
                comment_count: 0,
                state: "open".into(),
            },
            SourceTag::Mdn => HitMeta::Mdn { is_deprecated: false },
        };
        Hit {
            title: url.to_string(),
            url: Url::parse(url).unwrap(),
            excerpt: "".into(),
            source,
            score,
            meta,
        }
    }

    #[test]
    fn merge_intercalates_sources_round_robin() {
        let so = SourceFetch::ok(
            SourceTag::StackOverflow,
            vec![
                hit(SourceTag::StackOverflow, "https://so/1", 0.9),
                hit(SourceTag::StackOverflow, "https://so/2", 0.8),
            ],
        );
        let gh = SourceFetch::ok(
            SourceTag::GitHub,
            vec![hit(SourceTag::GitHub, "https://gh/1", 0.7)],
        );
        let mdn = SourceFetch::ok(
            SourceTag::Mdn,
            vec![hit(SourceTag::Mdn, "https://mdn/1", 0.5)],
        );

        let resp = merge(vec![so, gh, mdn], 10, CacheStatus::Miss, 100);
        let urls: Vec<&str> = resp.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(urls, vec!["https://so/1", "https://gh/1", "https://mdn/1", "https://so/2"]);
    }

    #[test]
    fn merge_dedupes_by_url() {
        let so = SourceFetch::ok(
            SourceTag::StackOverflow,
            vec![hit(SourceTag::StackOverflow, "https://example.com/x", 0.9)],
        );
        let gh = SourceFetch::ok(
            SourceTag::GitHub,
            vec![hit(SourceTag::GitHub, "https://example.com/x", 0.7)],
        );
        let resp = merge(vec![so, gh], 10, CacheStatus::Miss, 0);
        assert_eq!(resp.hits.len(), 1);
        // First-seen wins (SO).
        assert_eq!(resp.hits[0].source, SourceTag::StackOverflow);
    }

    #[test]
    fn merge_caps_at_max_hits() {
        let many = (0..30)
            .map(|i| hit(SourceTag::StackOverflow, &format!("https://so/{i}"), 0.5))
            .collect();
        let so = SourceFetch::ok(SourceTag::StackOverflow, many);
        let resp = merge(vec![so], 10, CacheStatus::Miss, 0);
        assert_eq!(resp.hits.len(), 10);
    }

    #[test]
    fn merge_carries_per_source_status_rows() {
        let so = SourceFetch::rate_limited(SourceTag::StackOverflow);
        let gh = SourceFetch::ok(
            SourceTag::GitHub,
            vec![hit(SourceTag::GitHub, "https://gh/1", 0.7)],
        );
        let mdn = SourceFetch::timeout(SourceTag::Mdn);
        let resp = merge(vec![so, gh, mdn], 10, CacheStatus::Miss, 0);
        assert_eq!(resp.sources_used.len(), 3);
        assert!(matches!(resp.sources_used[0].state, SourceState::RateLimited));
        assert!(matches!(resp.sources_used[1].state, SourceState::Ok { hit_count: 1 }));
        assert!(matches!(resp.sources_used[2].state, SourceState::Timeout));
    }

    #[test]
    fn merge_propagates_quota_low_flag() {
        let mut so = SourceFetch::ok(SourceTag::StackOverflow, vec![]);
        so.quota_low = true;
        let resp = merge(vec![so], 10, CacheStatus::Miss, 0);
        assert!(resp.quota_low);
    }

    #[test]
    fn merge_empty_response_is_a_miss_not_an_error() {
        let so = SourceFetch::error(SourceTag::StackOverflow, "boom");
        let gh = SourceFetch::error(SourceTag::GitHub, "boom");
        let mdn = SourceFetch::error(SourceTag::Mdn, "boom");
        let resp = merge(vec![so, gh, mdn], 10, CacheStatus::Miss, 50);
        assert!(resp.hits.is_empty());
        assert_eq!(resp.cache_status, CacheStatus::Miss);
        assert_eq!(resp.sources_used.len(), 3);
    }
}
