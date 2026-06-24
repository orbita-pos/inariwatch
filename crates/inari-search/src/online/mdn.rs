//! MDN web docs source.
//!
//! `developer.mozilla.org/api/v1/search` is the public, no-auth search
//! endpoint backing the MDN site search box. Returns ranked
//! `documents: [{title, slug, summary, ...}]`. We use the top 3 (MDN
//! is curated; deeper pages add noise, not value).
//!
//! - URL = `https://developer.mozilla.org/en-US/docs/<slug>`.
//! - Excerpt = `summary` truncated to 200 chars.
//! - `is_deprecated` is set to `false` for v1 (the search API doesn't
//!   reliably surface that flag; the offline MDN bundle in S14 will).

use crate::online::stackexchange::strip_to_plain;
use crate::online::SourceFetch;
use crate::types::{Hit, HitMeta, SearchRequest, SourceTag};
use serde::Deserialize;
use url::Url;

pub const DEFAULT_BASE: &str = "https://developer.mozilla.org";
const TAKE: usize = 3;

pub struct MdnSource {
    client: reqwest::Client,
    base: String,
}

impl MdnSource {
    pub fn new(client: reqwest::Client, base: impl Into<String>) -> Self {
        Self {
            client,
            base: base.into(),
        }
    }

    pub async fn fetch(&self, req: &SearchRequest) -> SourceFetch {
        let q = urlencoding::encode(&req.error_text);
        let url = format!("{}/api/v1/search?q={}&locale=en-US", self.base, q);

        let resp = match self.client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return SourceFetch::error(SourceTag::Mdn, format!("send: {e}")),
        };

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return SourceFetch::rate_limited(SourceTag::Mdn);
        }
        if !resp.status().is_success() {
            return SourceFetch::error(
                SourceTag::Mdn,
                format!("status {}", resp.status()),
            );
        }

        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => return SourceFetch::error(SourceTag::Mdn, format!("body: {e}")),
        };
        let parsed: MdnSearchResponse = match serde_json::from_slice(&bytes) {
            Ok(p) => p,
            Err(e) => {
                return SourceFetch::error(SourceTag::Mdn, format!("parse failed: {e}"))
            }
        };

        let docs = parsed.documents.unwrap_or_default();
        let total = docs.len();
        let hits: Vec<Hit> = docs
            .into_iter()
            .take(TAKE)
            .enumerate()
            .filter_map(|(i, d)| build_hit(&self.base, i, total.max(1), d))
            .collect();

        SourceFetch::ok(SourceTag::Mdn, hits)
    }
}

fn build_hit(base: &str, position: usize, total: usize, doc: MdnDocument) -> Option<Hit> {
    // MDN slugs are like `Web/JavaScript/Reference/Errors/Cant_define_property_object`.
    // The canonical URL is `<base>/en-US/docs/<slug>`. Reject anything
    // with whitespace or unexpected characters; MDN slugs are well-
    // formed by construction but defensive parsing protects us from
    // schema drift.
    let slug = doc.mdn_url.unwrap_or_else(|| format!("/en-US/docs/{}", doc.slug.unwrap_or_default()));
    let url_str = if slug.starts_with("http") {
        slug
    } else if slug.starts_with('/') {
        format!("{}{}", base.trim_end_matches('/'), slug)
    } else {
        format!("{}/en-US/docs/{}", base.trim_end_matches('/'), slug)
    };
    let url = Url::parse(&url_str).ok()?;
    let title = doc.title.unwrap_or_default();
    let summary = doc.summary.unwrap_or_default();
    let excerpt = strip_to_plain(&summary, 200);
    let score = 1.0 - (position as f32 / total as f32);
    Some(Hit {
        title,
        url,
        excerpt,
        source: SourceTag::Mdn,
        score,
        meta: HitMeta::Mdn { is_deprecated: false },
    })
}

#[derive(Debug, Deserialize)]
struct MdnSearchResponse {
    documents: Option<Vec<MdnDocument>>,
}

#[derive(Debug, Deserialize)]
struct MdnDocument {
    title: Option<String>,
    summary: Option<String>,
    /// MDN's modern API returns `mdn_url` like `/en-US/docs/Web/...`.
    mdn_url: Option<String>,
    /// Older shape used `slug` without the `/en-US/docs/` prefix.
    /// Either is accepted; `mdn_url` wins when both are present.
    slug: Option<String>,
}
