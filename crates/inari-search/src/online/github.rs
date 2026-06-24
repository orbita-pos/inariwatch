//! GitHub Issues source.
//!
//! Anonymous-only. The `Authorization` header is intentionally never
//! attached — per the research push-back (Section D), shipping a baked
//! client_secret is a non-starter (GitHub revokes leaked secrets within
//! hours via secret-scanning), and OAuth would force the device flow
//! on every user. Anon = 30/min issues + 60/hr core, per-IP — plenty
//! for the click-to-search UX.
//!
//! One HTTP roundtrip per fetch:
//!
//! - `GET /search/issues?q=<query>+is:issue&sort=reactions&order=desc&per_page=10`
//!
//! The first 200 chars of `body` form the [`Hit::excerpt`] after a
//! conservative markdown strip (same routine as
//! `stackexchange::strip_to_plain`). We take up to **5** issues per
//! call; the merge layer rounds out from there.

use crate::online::stackexchange::strip_to_plain;
use crate::online::SourceFetch;
use crate::types::{Hit, HitMeta, SearchRequest, SourceTag};
use serde::Deserialize;
use url::Url;

pub const DEFAULT_BASE: &str = "https://api.github.com";
const PER_PAGE: usize = 10;
const TAKE: usize = 5;

pub struct GitHubSource {
    client: reqwest::Client,
    base: String,
}

impl GitHubSource {
    pub fn new(client: reqwest::Client, base: impl Into<String>) -> Self {
        Self {
            client,
            base: base.into(),
        }
    }

    pub async fn fetch(&self, req: &SearchRequest) -> SourceFetch {
        // GitHub's q= takes a string; the "+is:issue" qualifier filters
        // issue results out of pulls. URL-encode the user's text first,
        // then append the qualifier (which has its own encoding via
        // urlencoding for the colon).
        let q_text = urlencoding::encode(&req.error_text);
        let url = format!(
            "{}/search/issues?q={}+is%3Aissue&sort=reactions&order=desc&per_page={}",
            self.base, q_text, PER_PAGE,
        );

        let resp = match self
            .client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return SourceFetch::error(SourceTag::GitHub, format!("send: {e}")),
        };

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
            || resp.status() == reqwest::StatusCode::FORBIDDEN
        {
            // GitHub returns 403 with `X-RateLimit-Remaining: 0` for
            // anon throttle (NOT 429). We collapse both into RateLimited.
            return SourceFetch::rate_limited(SourceTag::GitHub);
        }
        if !resp.status().is_success() {
            return SourceFetch::error(
                SourceTag::GitHub,
                format!("status {}", resp.status()),
            );
        }

        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => return SourceFetch::error(SourceTag::GitHub, format!("body: {e}")),
        };
        let parsed: SearchIssuesResponse = match serde_json::from_slice(&bytes) {
            Ok(p) => p,
            Err(e) => {
                return SourceFetch::error(SourceTag::GitHub, format!("parse failed: {e}"))
            }
        };

        let hits: Vec<Hit> = parsed
            .items
            .unwrap_or_default()
            .into_iter()
            .take(TAKE)
            .filter_map(build_hit)
            .collect();

        SourceFetch::ok(SourceTag::GitHub, hits)
    }
}

fn build_hit(item: IssueItem) -> Option<Hit> {
    let url = Url::parse(&item.html_url).ok()?;
    let title = item.title.unwrap_or_default();
    let body = item.body.unwrap_or_default();
    let excerpt = strip_to_plain(&body, 200);
    let reactions = item.reactions.as_ref().map(|r| r.total_count).unwrap_or(0);
    let score = (reactions as f32 / 50.0).clamp(0.0, 1.0);
    Some(Hit {
        title,
        url,
        excerpt,
        source: SourceTag::GitHub,
        score,
        meta: HitMeta::GitHub {
            reaction_count: reactions,
            comment_count: item.comments.unwrap_or(0),
            state: item.state.unwrap_or_else(|| "open".to_string()),
        },
    })
}

#[derive(Debug, Deserialize)]
struct SearchIssuesResponse {
    items: Option<Vec<IssueItem>>,
}

#[derive(Debug, Deserialize)]
struct IssueItem {
    html_url: String,
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    comments: Option<u32>,
    reactions: Option<Reactions>,
}

#[derive(Debug, Deserialize)]
struct Reactions {
    total_count: u32,
}
