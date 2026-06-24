//! Integration tests for the Stack Exchange source. Mockito hosts the
//! `/2.3/search/excerpts` and `/2.3/questions/{ids}/answers` endpoints
//! so the parser + ranking + quota detection paths run end-to-end
//! without touching the live SE API.

use inari_search::online::{stackexchange::StackExchangeSource, SourceFetch};
use inari_search::types::{HitMeta, SearchRequest, SourceState, SourceTag};

fn req(text: &str) -> SearchRequest {
    SearchRequest {
        error_text: text.into(),
        language: None,
        framework: None,
        max_hits: 20,
    }
}

fn excerpts_payload(items: serde_json::Value, quota_remaining: i64) -> String {
    serde_json::json!({
        "items": items,
        "quota_remaining": quota_remaining,
        "has_more": false,
    })
    .to_string()
}

fn answers_payload(items: serde_json::Value) -> String {
    serde_json::json!({ "items": items, "has_more": false }).to_string()
}

#[tokio::test]
async fn parses_excerpts_and_enriches_top_3_with_answer_bodies() {
    let mut server = mockito::Server::new_async().await;

    let _excerpts = server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(excerpts_payload(
            serde_json::json!([
                {
                    "question_id": 100,
                    "title": "Cannot read property of undefined",
                    "excerpt": "Try logging the value first.",
                    "score": 50,
                    "is_accepted": true,
                    "answer_count": 3
                },
                {
                    "question_id": 200,
                    "title": "Second hit",
                    "excerpt": "Other approach.",
                    "score": 10,
                    "is_accepted": false,
                    "answer_count": 1
                }
            ]),
            5000,
        ))
        .expect_at_least(1)
        .create_async()
        .await;

    let _answers = server
        .mock("GET", mockito::Matcher::Regex(".*/questions/.*/answers.*".into()))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(answers_payload(serde_json::json!([
            {
                "question_id": 100,
                "body_markdown": "**Use `Object.hasOwn`** to guard against undefined.",
                "is_accepted": true,
                "score": 42
            },
            {
                "question_id": 200,
                "body_markdown": "Alternative: use optional chaining.",
                "is_accepted": false,
                "score": 7
            }
        ])))
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch = src.fetch(&req("Cannot read property of undefined")).await;

    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 2 }));
    assert_eq!(fetch.hits.len(), 2);
    assert!(!fetch.quota_low, "quota 5000 is well above 50");

    let first = &fetch.hits[0];
    assert_eq!(first.source, SourceTag::StackOverflow);
    assert!(first.url.as_str().contains("100"));
    // Excerpt enriched from body_markdown, plain-text stripped.
    assert!(first.excerpt.contains("Object.hasOwn"));
    match &first.meta {
        HitMeta::StackOverflow {
            vote_count,
            is_accepted,
            answer_count,
        } => {
            assert_eq!(*vote_count, 50);
            assert!(*is_accepted);
            assert_eq!(*answer_count, 3);
        }
        other => panic!("unexpected meta: {other:?}"),
    }
    // Score: 50 votes / 100 = 0.5, +0.1 accepted bonus = 0.6.
    assert!((first.score - 0.6).abs() < 0.001, "score {} != 0.6", first.score);
}

#[tokio::test]
async fn quota_low_flag_when_quota_remaining_below_threshold() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_body(excerpts_payload(serde_json::json!([]), 30))
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;

    assert!(fetch.quota_low, "quota 30 should trip the low flag");
}

#[tokio::test]
async fn quota_low_not_set_when_quota_remaining_is_high() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_body(excerpts_payload(serde_json::json!([]), 290))
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(!fetch.quota_low);
}

#[tokio::test]
async fn http_429_maps_to_rate_limited_state() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(429)
        .with_body("{}")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch: SourceFetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::RateLimited));
    assert_eq!(fetch.hits.len(), 0);
}

#[tokio::test]
async fn error_id_502_in_body_maps_to_rate_limited() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_body(serde_json::json!({
            "error_id": 502,
            "error_message": "throttle"
        }).to_string())
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::RateLimited));
}

#[tokio::test]
async fn parser_recovery_when_schema_drifts() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_body("not valid json {{{")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::Error { .. }));
}

#[tokio::test]
async fn empty_items_returns_ok_zero_hits() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_body(excerpts_payload(serde_json::json!([]), 9000))
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch = src.fetch(&req("super-rare-error-string")).await;
    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 0 }));
    assert!(fetch.hits.is_empty());
}

#[tokio::test]
async fn answer_body_failure_falls_through_to_excerpt_field() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_body(excerpts_payload(
            serde_json::json!([
                {
                    "question_id": 7,
                    "title": "Title 7",
                    "excerpt": "Fallback excerpt.",
                    "score": 1,
                    "is_accepted": false,
                    "answer_count": 0
                }
            ]),
            5000,
        ))
        .create_async()
        .await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/questions/.*/answers.*".into()))
        .with_status(500)
        .with_body("{}")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = StackExchangeSource::new(client, server.url());
    let fetch = src.fetch(&req("query")).await;
    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 1 }));
    let h = &fetch.hits[0];
    assert!(
        h.excerpt.contains("Fallback excerpt"),
        "expected excerpt fallback, got: {}",
        h.excerpt
    );
}
