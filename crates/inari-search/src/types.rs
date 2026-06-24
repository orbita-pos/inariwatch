//! Public wire types for `inari-search`.
//!
//! Shape decisions per S13 prompt:
//!
//! - [`HitMeta`] is an enum with concrete per-source variants — NO
//!   `serde_json::Value` blobs in public types. Tests assert shape, not
//!   "parses without error".
//! - [`SourceState`] carries both the success count and the failure
//!   reason so the chat surface can render a per-source status chip
//!   ("Stack Overflow ✓ 8" / "GitHub × rate-limited") without a second
//!   round-trip.
//! - [`CacheStatus`] distinguishes `Miss` from `PartialMiss` (cache
//!   served some hits, dispatcher topped up the rest) so a future
//!   eviction-tuning pass can use the rate as a signal.
//!
//! All types `serde::Deserialize` so the agent tool wrapper can stash
//! the response in `ToolOutput::value` and the frontend `SearchPanel`
//! can decode the same shape.

use serde::{Deserialize, Serialize};
use url::Url;

// ── Source identity ──────────────────────────────────────────────────────────

/// Every Hit's `source` matches one of these. Stable wire string —
/// the frontend filter chip toggles on these names. `GitHub` ships
/// as `"github"` (not the serde-derived `"git_hub"` from
/// `rename_all = "snake_case"`) because the frontend chip key is the
/// brand spelling, not the cased identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceTag {
    #[serde(rename = "stack_overflow")]
    StackOverflow,
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "mdn")]
    Mdn,
}

impl SourceTag {
    pub fn label(self) -> &'static str {
        match self {
            SourceTag::StackOverflow => "Stack Overflow",
            SourceTag::GitHub => "GitHub",
            SourceTag::Mdn => "MDN",
        }
    }
}

// ── Request ──────────────────────────────────────────────────────────────────

/// What the frontend / agent passes when triggering a search. The
/// `error_text` is the raw string captured from the user's alert; the
/// optional hints refine fingerprinting + ranking but never gate the
/// dispatch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    /// Raw error string from Capture / the alert. Length is not
    /// enforced here — the dispatcher truncates per-source as needed
    /// (SO `q=` caps at ~500 chars, GH similar). Long inputs are
    /// fingerprinted on a normalized form to keep the cache key stable.
    pub error_text: String,
    /// Best-effort language hint (`"javascript"`, `"python"`, …). The
    /// fingerprint module re-derives the language from `error_text`
    /// when this is `None` or empty.
    #[serde(default)]
    pub language: Option<String>,
    /// Optional framework hint (`"react"`, `"nextjs"`, `"django"`).
    /// Currently passed through to ranking only; future versions may
    /// boost framework-tagged SO answers.
    #[serde(default)]
    pub framework: Option<String>,
    /// Soft cap on hits returned. Default 20, hard cap 50. The
    /// dispatcher always queries each source to its per-source budget
    /// (8/5/3) and the merge rounds out to this number after dedupe.
    #[serde(default = "default_max_hits")]
    pub max_hits: usize,
}

fn default_max_hits() -> usize {
    20
}

impl SearchRequest {
    pub const HARD_CAP: usize = 50;

    /// Clamp `max_hits` to [1, HARD_CAP]. Called by the dispatcher to
    /// protect against an LLM-emitted nonsense value (e.g. 10_000) —
    /// the chat surface should never see more than 50 cards.
    pub fn effective_max_hits(&self) -> usize {
        self.max_hits.clamp(1, Self::HARD_CAP)
    }
}

// ── Response ─────────────────────────────────────────────────────────────────

/// What the dispatcher returns for one `search()` call. Every field is
/// purely descriptive — the response is rendered verbatim by the
/// frontend without a second round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    /// Ranked hits, deduplicated by URL. Ordering is the merged
    /// per-source intercalado (SO[0], GH[0], MDN[0], SO[1], ...).
    pub hits: Vec<Hit>,
    /// One entry per source the dispatcher attempted. Mirrors the chat
    /// surface's "Stack Overflow ✓ 8 / GitHub × timeout / MDN ✓ 3"
    /// status row.
    pub sources_used: Vec<SourceStatus>,
    /// Whether the response was served from cache, fetched fresh, or a
    /// mix. Drives the "cache miss" pill in the panel header.
    pub cache_status: CacheStatus,
    /// Wall-clock duration the dispatcher took to assemble the response,
    /// including the cache hit/miss path. Useful for the panel header
    /// ("Found 12 sources in 412ms · cache miss").
    pub elapsed_ms: u64,
    /// Anonymous per-IP quota signal lifted from the SO wrapper. When
    /// `true`, the chat surface can render a "Stack Overflow quota
    /// nearly exhausted" chip without another HTTP call. Mirrors the
    /// `quota_remaining < 50` guard in `online::stackexchange`.
    #[serde(default)]
    pub quota_low: bool,
}

impl SearchResponse {
    /// Empty response useful as a "fall through to UI empty state"
    /// shortcut — the dispatcher returns this when every source 0-d
    /// out and there's no cached fallback. NOT used as the cache miss
    /// negative case (the cache layer itself returns `Option<Self>`).
    pub fn empty() -> Self {
        Self {
            hits: Vec::new(),
            sources_used: Vec::new(),
            cache_status: CacheStatus::Miss,
            elapsed_ms: 0,
            quota_low: false,
        }
    }
}

/// One match the dispatcher returned. Every field is rendered
/// verbatim — no markup, no markdown.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Hit {
    /// One-line title. Already stripped of leading whitespace.
    pub title: String,
    /// Canonical link to the original page. Always https; the parsers
    /// reject anything else.
    pub url: Url,
    /// Plain-text snippet, capped at 200 chars + ellipsis. Stripped of
    /// markdown.
    pub excerpt: String,
    /// Where this hit came from.
    pub source: SourceTag,
    /// Normalized 0..1 score for cross-source ranking. Per-source
    /// scoring rules:
    /// - StackOverflow: `min(1.0, votes / 100.0)` plus a +0.1 bonus
    ///   when accepted.
    /// - GitHub: `min(1.0, reactions / 50.0)`.
    /// - MDN: `1.0 - (position / total)` (top result = 1.0).
    pub score: f32,
    /// Source-specific metadata. The frontend renders different chips
    /// per variant.
    pub meta: HitMeta,
}

/// Source-specific extras for a [`Hit`]. Distinct enum variants per
/// source — no `Value` blob, no untyped extension map. Tag values
/// match [`SourceTag`] so a parser can branch on either field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "source")]
pub enum HitMeta {
    #[serde(rename = "stack_overflow")]
    StackOverflow {
        vote_count: i32,
        is_accepted: bool,
        answer_count: u32,
    },
    #[serde(rename = "github")]
    GitHub {
        reaction_count: u32,
        comment_count: u32,
        /// `"open"` | `"closed"` per GitHub Issues API.
        state: String,
    },
    #[serde(rename = "mdn")]
    Mdn {
        /// MDN's search API doesn't reliably surface the deprecated
        /// flag — kept as `false` for v1 and revisited in S14 when we
        /// pull from the offline MDN bundle.
        is_deprecated: bool,
    },
}

impl HitMeta {
    /// Mirror of [`Hit::source`] — useful when callers have only the
    /// meta variant and need the source tag without re-walking the
    /// parent struct.
    pub fn source(&self) -> SourceTag {
        match self {
            HitMeta::StackOverflow { .. } => SourceTag::StackOverflow,
            HitMeta::GitHub { .. } => SourceTag::GitHub,
            HitMeta::Mdn { .. } => SourceTag::Mdn,
        }
    }
}

/// Per-source dispatch outcome. Mirrors the panel's per-source chip
/// row 1:1 — frontend never has to recompute success/failure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceStatus {
    pub source: SourceTag,
    pub state: SourceState,
}

/// What happened on one source's HTTP roundtrip. The `Ok(n)` case
/// carries the count BEFORE merge dedupe — the panel shows "Stack
/// Overflow ✓ 8" even when the merge later kept only 5.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceState {
    Ok { hit_count: u32 },
    RateLimited,
    Timeout,
    Error { message: String },
}

impl SourceState {
    pub fn is_ok(&self) -> bool {
        matches!(self, SourceState::Ok { .. })
    }
}

/// Whether the response came from cache, fresh fetch, or a mix.
/// Currently only `Hit` and `Miss` are emitted by the dispatcher;
/// `PartialMiss` is reserved for a future "topped-up cache" path
/// (S14+) when stale hits get refreshed in the background.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheStatus {
    Hit,
    Miss,
    PartialMiss,
}

// ── Errors ───────────────────────────────────────────────────────────────────

/// Top-level error type. The dispatcher rarely returns `Err` — when
/// every source 0-s out it returns an empty response with cache_status
/// = Miss. `SearchError` is reserved for genuine "we couldn't even
/// try" failures: cache disk error, runtime error, etc.
#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("cache: {0}")]
    Cache(String),
    #[error("io: {0}")]
    Io(String),
    #[error("internal: {0}")]
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_tag_round_trips_through_json() {
        for tag in [SourceTag::StackOverflow, SourceTag::GitHub, SourceTag::Mdn] {
            let v = serde_json::to_value(tag).unwrap();
            let back: SourceTag = serde_json::from_value(v).unwrap();
            assert_eq!(back, tag);
        }
    }

    #[test]
    fn hit_meta_variants_serialize_with_distinct_tags() {
        let so = HitMeta::StackOverflow {
            vote_count: 42,
            is_accepted: true,
            answer_count: 3,
        };
        let so_v = serde_json::to_value(&so).unwrap();
        assert_eq!(so_v["source"], json!("stack_overflow"));
        assert_eq!(so_v["vote_count"], json!(42));

        let gh = HitMeta::GitHub {
            reaction_count: 12,
            comment_count: 4,
            state: "closed".into(),
        };
        let gh_v = serde_json::to_value(&gh).unwrap();
        assert_eq!(gh_v["source"], json!("github"));
        assert_eq!(gh_v["state"], json!("closed"));

        let mdn = HitMeta::Mdn { is_deprecated: false };
        let mdn_v = serde_json::to_value(&mdn).unwrap();
        assert_eq!(mdn_v["source"], json!("mdn"));
    }

    #[test]
    fn hit_meta_source_matches_variant() {
        assert_eq!(
            HitMeta::StackOverflow {
                vote_count: 0,
                is_accepted: false,
                answer_count: 0
            }
            .source(),
            SourceTag::StackOverflow
        );
        assert_eq!(
            HitMeta::GitHub {
                reaction_count: 0,
                comment_count: 0,
                state: "open".into()
            }
            .source(),
            SourceTag::GitHub
        );
        assert_eq!(
            HitMeta::Mdn { is_deprecated: false }.source(),
            SourceTag::Mdn
        );
    }

    #[test]
    fn search_request_clamps_max_hits_to_hard_cap() {
        let req = SearchRequest {
            error_text: "x".into(),
            language: None,
            framework: None,
            max_hits: 10_000,
        };
        assert_eq!(req.effective_max_hits(), SearchRequest::HARD_CAP);
    }

    #[test]
    fn search_request_clamps_max_hits_to_min_one() {
        let req = SearchRequest {
            error_text: "x".into(),
            language: None,
            framework: None,
            max_hits: 0,
        };
        assert_eq!(req.effective_max_hits(), 1);
    }

    #[test]
    fn search_request_default_max_hits_is_twenty() {
        let req: SearchRequest = serde_json::from_value(json!({ "error_text": "x" })).unwrap();
        assert_eq!(req.max_hits, 20);
    }

    #[test]
    fn source_state_ok_serializes_with_kind_tag() {
        let v = serde_json::to_value(SourceState::Ok { hit_count: 5 }).unwrap();
        assert_eq!(v["kind"], json!("ok"));
        assert_eq!(v["hit_count"], json!(5));
    }

    #[test]
    fn source_state_rate_limited_serializes_with_kind_tag_only() {
        let v = serde_json::to_value(SourceState::RateLimited).unwrap();
        assert_eq!(v["kind"], json!("rate_limited"));
    }

    #[test]
    fn search_response_empty_is_a_miss() {
        let r = SearchResponse::empty();
        assert!(r.hits.is_empty());
        assert!(r.sources_used.is_empty());
        assert_eq!(r.cache_status, CacheStatus::Miss);
        assert_eq!(r.elapsed_ms, 0);
        assert!(!r.quota_low);
    }

    #[test]
    fn cache_status_round_trips_through_json() {
        for s in [CacheStatus::Hit, CacheStatus::Miss, CacheStatus::PartialMiss] {
            let v = serde_json::to_value(s).unwrap();
            let back: CacheStatus = serde_json::from_value(v).unwrap();
            assert_eq!(back, s);
        }
    }
}
