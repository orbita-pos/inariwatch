//! Stack Exchange (Stack Overflow) source.
//!
//! Anonymous-only — NO baked key, NO `key=` query parameter. Per the
//! research push-back (Section D), per-key compounds across all users
//! of a release; per-IP keeps each user on their own 300/day cap.
//!
//! Two HTTP roundtrips per fetch:
//!
//! 1. `/2.3/search/excerpts` with the URL-encoded `error_text` →
//!    returns up to 8 question excerpts. We rank these by `votes`
//!    (the API does this when we pass `sort=votes`).
//! 2. For the **top 3** question_ids, follow with
//!    `/2.3/questions/{ids}/answers` to fetch the accepted answer
//!    body (or the highest-voted answer when none is accepted) and
//!    use the first 200 chars of that body as the [`Hit::excerpt`].
//!
//! The second roundtrip is best-effort — if it 429s or times out,
//! the excerpts from step 1 still get returned with their raw
//! API-provided excerpt text. Empty `body_markdown` falls back to the
//! excerpt too.
//!
//! ## Quota awareness
//!
//! The wrapper JSON carries `quota_remaining`. When it's < 50, we
//! raise the `quota_low` flag on the SourceFetch — the chat surface
//! can render a "Stack Overflow quota nearly exhausted" chip without a
//! second HTTP call.

use crate::online::SourceFetch;
use crate::types::{Hit, HitMeta, SearchRequest, SourceTag};
use serde::Deserialize;
use url::Url;

pub const DEFAULT_BASE: &str = "https://api.stackexchange.com";
/// Custom filter — minimum fields for `/search/excerpts`. See
/// https://api.stackexchange.com/docs/search-excerpts for the live
/// filter editor. Using the default filter would force-include 30
/// fields we don't need; this one is excerpt + question_id + title +
/// score + is_accepted + answer_count.
const EXCERPT_FILTER: &str = "!nKzQUR3Egv";
/// Custom filter for `/questions/{ids}/answers` — includes
/// body_markdown + score + is_accepted. Default would omit the body.
const ANSWER_FILTER: &str = "!9_bDDxJY5";
const SITE: &str = "stackoverflow";
/// Per-source budget: pull 8 excerpts, top-3 of those get the
/// follow-up answer body.
const EXCERPT_LIMIT: usize = 8;
const FOLLOW_UP_LIMIT: usize = 3;
/// Quota threshold under which we raise the warning flag.
const QUOTA_LOW_THRESHOLD: i64 = 50;

pub struct StackExchangeSource {
    client: reqwest::Client,
    base: String,
}

impl StackExchangeSource {
    pub fn new(client: reqwest::Client, base: impl Into<String>) -> Self {
        Self {
            client,
            base: base.into(),
        }
    }

    /// One full fetch — excerpts + best-effort body enrichment for
    /// top-3.
    pub async fn fetch(&self, req: &SearchRequest) -> SourceFetch {
        let q = urlencoding::encode(&req.error_text);
        let url = format!(
            "{}/2.3/search/excerpts?order=desc&sort=votes&q={}&site={}&filter={}&pagesize={}",
            self.base, q, SITE, EXCERPT_FILTER, EXCERPT_LIMIT,
        );

        let resp = match self.client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return SourceFetch::error(SourceTag::StackOverflow, format!("send: {e}")),
        };

        // Stack Exchange returns 200 with `error_id` set in the body
        // for soft errors (e.g. throttle). 429 is the hard rate-limit.
        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return SourceFetch::rate_limited(SourceTag::StackOverflow);
        }
        if !resp.status().is_success() {
            return SourceFetch::error(
                SourceTag::StackOverflow,
                format!("status {}", resp.status()),
            );
        }

        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => return SourceFetch::error(SourceTag::StackOverflow, format!("body: {e}")),
        };
        let parsed: ExcerptsWrapper = match serde_json::from_slice(&bytes) {
            Ok(p) => p,
            Err(e) => {
                return SourceFetch::error(
                    SourceTag::StackOverflow,
                    format!("parse failed: {e}"),
                )
            }
        };

        // Soft-error handling: SE wraps "throttle" as
        // `{ error_id: 502, error_message: "..." }`. Treat error_id
        // 502 / 503 as rate-limited.
        if let Some(eid) = parsed.error_id {
            if eid == 502 || eid == 503 || eid == 16 || eid == 17 {
                return SourceFetch::rate_limited(SourceTag::StackOverflow);
            }
            return SourceFetch::error(
                SourceTag::StackOverflow,
                format!("error_id {eid}: {}", parsed.error_message.unwrap_or_default()),
            );
        }

        let quota_low = parsed
            .quota_remaining
            .map(|q| q < QUOTA_LOW_THRESHOLD)
            .unwrap_or(false);

        let items = parsed.items.unwrap_or_default();
        if items.is_empty() {
            let mut f = SourceFetch::ok(SourceTag::StackOverflow, Vec::new());
            f.quota_low = quota_low;
            return f;
        }

        // Best-effort follow-up: enrich the top-3 question_ids with
        // their accepted-answer body. Failure of this fetch falls
        // through to the excerpts-only path.
        let top_ids: Vec<i64> = items
            .iter()
            .take(FOLLOW_UP_LIMIT)
            .map(|i| i.question_id)
            .collect();
        let bodies = self
            .fetch_answer_bodies(&top_ids)
            .await
            .unwrap_or_default();

        let hits: Vec<Hit> = items
            .into_iter()
            .filter_map(|i| build_hit(i, &bodies))
            .collect();

        let mut f = SourceFetch::ok(SourceTag::StackOverflow, hits);
        f.quota_low = quota_low;
        f
    }

    async fn fetch_answer_bodies(
        &self,
        question_ids: &[i64],
    ) -> Option<std::collections::HashMap<i64, AnswerBody>> {
        if question_ids.is_empty() {
            return None;
        }
        let ids = question_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(";");
        let url = format!(
            "{}/2.3/questions/{}/answers?order=desc&sort=votes&site={}&filter={}",
            self.base, ids, SITE, ANSWER_FILTER,
        );
        let resp = self.client.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let bytes = resp.bytes().await.ok()?;
        let parsed: AnswersWrapper = serde_json::from_slice(&bytes).ok()?;
        let items = parsed.items?;
        // Build a "best body per question_id" map: prefer accepted,
        // fall back to top-vote.
        let mut by_qid: std::collections::HashMap<i64, AnswerBody> = std::collections::HashMap::new();
        for a in items {
            let qid = a.question_id;
            let body = AnswerBody {
                body_markdown: a.body_markdown,
                is_accepted: a.is_accepted,
                score: a.score,
            };
            match by_qid.get(&qid) {
                None => {
                    by_qid.insert(qid, body);
                }
                Some(prev) => {
                    if (!prev.is_accepted && body.is_accepted)
                        || (prev.is_accepted == body.is_accepted && body.score > prev.score)
                    {
                        by_qid.insert(qid, body);
                    }
                }
            }
        }
        Some(by_qid)
    }
}

#[derive(Clone)]
struct AnswerBody {
    body_markdown: Option<String>,
    is_accepted: bool,
    score: i32,
}

fn build_hit(
    item: ExcerptItem,
    bodies: &std::collections::HashMap<i64, AnswerBody>,
) -> Option<Hit> {
    let url_str = format!(
        "https://stackoverflow.com/questions/{}",
        item.question_id
    );
    let url = Url::parse(&url_str).ok()?;
    let title = item.title.unwrap_or_default();

    // Excerpt priority: enriched body > excerpt field > title.
    let raw_excerpt: String = match bodies.get(&item.question_id) {
        Some(b) if b.body_markdown.as_deref().map(str::is_empty) == Some(false) => {
            b.body_markdown.clone().unwrap_or_default()
        }
        _ => item.excerpt.unwrap_or_else(|| title.clone()),
    };
    let excerpt = strip_to_plain(&raw_excerpt, 200);

    let votes = item.score.unwrap_or(0);
    let is_accepted = bodies
        .get(&item.question_id)
        .map(|b| b.is_accepted)
        .unwrap_or(item.is_accepted.unwrap_or(false));
    let score = (votes as f32 / 100.0).clamp(0.0, 1.0)
        + if is_accepted { 0.1 } else { 0.0 };
    let score = score.clamp(0.0, 1.0);

    Some(Hit {
        title,
        url,
        excerpt,
        source: SourceTag::StackOverflow,
        score,
        meta: HitMeta::StackOverflow {
            vote_count: votes,
            is_accepted,
            answer_count: item.answer_count.unwrap_or(0) as u32,
        },
    })
}

/// Conservative markdown → plain text. We do NOT pull a markdown
/// parser dep (research said no AGPL libs, no extra surface area). The
/// stripping rules are:
///
/// - Drop `![alt](url)` images entirely.
/// - Replace `[text](url)` with `text`.
/// - Drop `` `code` `` ticks but keep the inner text.
/// - Collapse `\n+` → ` `.
/// - Truncate to `cap` chars + "…" suffix.
pub(crate) fn strip_to_plain(input: &str, cap: usize) -> String {
    use once_cell::sync::Lazy;
    use regex::Regex;
    static IMAGE: Lazy<Regex> = Lazy::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
    static LINK: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]]+)\]\([^)]*\)").unwrap());
    static CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"`([^`]+)`").unwrap());
    static WHITESPACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

    let s = IMAGE.replace_all(input, "");
    let s = LINK.replace_all(&s, "$1");
    let s = CODE.replace_all(&s, "$1");
    let s = WHITESPACE.replace_all(&s, " ").trim().to_string();

    if s.chars().count() <= cap {
        return s;
    }
    let mut out: String = s.chars().take(cap).collect();
    out.push('…');
    out
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ExcerptsWrapper {
    items: Option<Vec<ExcerptItem>>,
    quota_remaining: Option<i64>,
    error_id: Option<i32>,
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExcerptItem {
    question_id: i64,
    title: Option<String>,
    excerpt: Option<String>,
    score: Option<i32>,
    is_accepted: Option<bool>,
    answer_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AnswersWrapper {
    items: Option<Vec<AnswerItem>>,
}

#[derive(Debug, Deserialize)]
struct AnswerItem {
    question_id: i64,
    body_markdown: Option<String>,
    is_accepted: bool,
    score: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_to_plain_drops_images_and_keeps_link_text() {
        let s = strip_to_plain(
            "![alt](https://x/y.png) text [link](https://example.com) more",
            200,
        );
        assert_eq!(s, "text link more");
    }

    #[test]
    fn strip_to_plain_drops_code_ticks_keeps_inner() {
        let s = strip_to_plain("use `foo()` to do bar", 200);
        assert_eq!(s, "use foo() to do bar");
    }

    #[test]
    fn strip_to_plain_collapses_whitespace() {
        let s = strip_to_plain("a    b\n\nc", 200);
        assert_eq!(s, "a b c");
    }

    #[test]
    fn strip_to_plain_truncates_at_cap_with_ellipsis() {
        let s = strip_to_plain(&"x".repeat(300), 50);
        assert_eq!(s.chars().count(), 51); // 50 chars + ellipsis
        assert!(s.ends_with('…'));
    }

    #[test]
    fn strip_to_plain_no_truncate_when_under_cap() {
        let s = strip_to_plain("short", 200);
        assert_eq!(s, "short");
    }
}
