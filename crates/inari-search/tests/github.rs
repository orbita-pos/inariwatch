//! GitHub Issues source — anonymous fetch through mockito.

use inari_search::online::github::GitHubSource;
use inari_search::types::{HitMeta, SearchRequest, SourceState, SourceTag};

fn req(text: &str) -> SearchRequest {
    SearchRequest {
        error_text: text.into(),
        language: None,
        framework: None,
        max_hits: 20,
    }
}

#[tokio::test]
async fn parses_issues_with_reactions_and_state() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .match_header("accept", "application/vnd.github+json")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            serde_json::json!({
                "items": [
                    {
                        "html_url": "https://github.com/owner/repo/issues/1",
                        "title": "Cannot read property of undefined",
                        "body": "Reproduces in v2.4 [link](https://example.com).",
                        "state": "closed",
                        "comments": 4,
                        "reactions": { "total_count": 12 }
                    },
                    {
                        "html_url": "https://github.com/owner/repo/issues/2",
                        "title": "Same TypeError",
                        "body": "Different stack frame.",
                        "state": "open",
                        "comments": 1,
                        "reactions": { "total_count": 0 }
                    }
                ]
            })
            .to_string(),
        )
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = GitHubSource::new(client, server.url());
    let fetch = src.fetch(&req("Cannot read property of undefined")).await;

    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 2 }));
    let h = &fetch.hits[0];
    assert_eq!(h.source, SourceTag::GitHub);
    assert_eq!(h.url.as_str(), "https://github.com/owner/repo/issues/1");
    // Markdown link → bare text.
    assert!(h.excerpt.contains("Reproduces in v2.4 link"));
    assert!(!h.excerpt.contains("[link]"));
    match &h.meta {
        HitMeta::GitHub {
            reaction_count,
            comment_count,
            state,
        } => {
            assert_eq!(*reaction_count, 12);
            assert_eq!(*comment_count, 4);
            assert_eq!(state, "closed");
        }
        other => panic!("unexpected meta: {other:?}"),
    }
    // 12 reactions / 50 = 0.24.
    assert!((h.score - 0.24).abs() < 0.001, "score {} != 0.24", h.score);
}

#[tokio::test]
async fn caps_results_at_take_limit() {
    let many: Vec<_> = (0..10)
        .map(|i| {
            serde_json::json!({
                "html_url": format!("https://github.com/owner/repo/issues/{i}"),
                "title": format!("issue {i}"),
                "body": "x",
                "state": "open",
                "comments": 0,
                "reactions": { "total_count": 0 }
            })
        })
        .collect();

    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(200)
        .with_body(serde_json::json!({ "items": many }).to_string())
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = GitHubSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    // Source caps to TAKE = 5.
    assert_eq!(fetch.hits.len(), 5);
}

#[tokio::test]
async fn http_403_anon_throttle_maps_to_rate_limited() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(403)
        .with_body("{}")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = GitHubSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::RateLimited));
}

#[tokio::test]
async fn http_429_maps_to_rate_limited() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(429)
        .with_body("{}")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = GitHubSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::RateLimited));
}

#[tokio::test]
async fn parser_recovery_when_schema_drifts() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(200)
        .with_body("not valid json {{{")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = GitHubSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::Error { .. }));
}

#[tokio::test]
async fn missing_reactions_block_defaults_to_zero() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(200)
        .with_body(
            serde_json::json!({
                "items": [
                    {
                        "html_url": "https://github.com/owner/repo/issues/9",
                        "title": "no reactions block",
                        "body": "x",
                        "state": "open",
                        "comments": 0
                    }
                ]
            })
            .to_string(),
        )
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = GitHubSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 1 }));
    match &fetch.hits[0].meta {
        HitMeta::GitHub { reaction_count, .. } => assert_eq!(*reaction_count, 0),
        other => panic!("unexpected meta: {other:?}"),
    }
}

#[tokio::test]
async fn no_authorization_header_is_attached() {
    // Verify by asserting that the mockito server matches a request
    // WITHOUT an Authorization header. mockito's `match_header` with
    // `mockito::Matcher::Missing` enforces the negative case.
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .match_header("authorization", mockito::Matcher::Missing)
        .with_status(200)
        .with_body(serde_json::json!({ "items": [] }).to_string())
        .expect(1)
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = GitHubSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 0 }));
}
