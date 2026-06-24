//! MDN source — `/api/v1/search` shape.

use inari_search::online::mdn::MdnSource;
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
async fn parses_documents_and_constructs_canonical_url_from_mdn_url() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            serde_json::json!({
                "documents": [
                    {
                        "title": "TypeError",
                        "summary": "The TypeError object represents an error...",
                        "mdn_url": "/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypeError"
                    },
                    {
                        "title": "Errors: Cant define property object",
                        "summary": "The JavaScript exception 'Cannot define property...'",
                        "mdn_url": "/en-US/docs/Web/JavaScript/Reference/Errors/Cant_define_property_object"
                    }
                ]
            })
            .to_string(),
        )
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = MdnSource::new(client, server.url());
    let fetch = src.fetch(&req("TypeError")).await;
    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 2 }));

    let h = &fetch.hits[0];
    assert_eq!(h.source, SourceTag::Mdn);
    assert!(h
        .url
        .as_str()
        .ends_with("/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypeError"));
    assert!(h.title.starts_with("TypeError"));
    assert!(h.excerpt.contains("represents an error"));
    match &h.meta {
        HitMeta::Mdn { is_deprecated } => assert!(!is_deprecated),
        other => panic!("unexpected meta: {other:?}"),
    }
}

#[tokio::test]
async fn caps_at_three_documents() {
    let docs: Vec<_> = (0..10)
        .map(|i| {
            serde_json::json!({
                "title": format!("doc {i}"),
                "summary": "summary",
                "mdn_url": format!("/en-US/docs/Web/X/Y{i}")
            })
        })
        .collect();
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_body(serde_json::json!({ "documents": docs }).to_string())
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = MdnSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert_eq!(fetch.hits.len(), 3);
}

#[tokio::test]
async fn falls_back_to_slug_field_when_mdn_url_missing() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_body(
            serde_json::json!({
                "documents": [
                    {
                        "title": "Old shape",
                        "summary": "x",
                        "slug": "Web/HTML/Element/foo"
                    }
                ]
            })
            .to_string(),
        )
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = MdnSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 1 }));
    assert!(fetch.hits[0]
        .url
        .as_str()
        .contains("/en-US/docs/Web/HTML/Element/foo"));
}

#[tokio::test]
async fn http_429_maps_to_rate_limited() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(429)
        .with_body("{}")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = MdnSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::RateLimited));
}

#[tokio::test]
async fn empty_documents_returns_ok_zero_hits() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_body(serde_json::json!({ "documents": [] }).to_string())
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = MdnSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::Ok { hit_count: 0 }));
}

#[tokio::test]
async fn parser_recovery_when_schema_drifts() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_body("not valid json {{{")
        .create_async()
        .await;

    let client = reqwest::Client::builder().build().unwrap();
    let src = MdnSource::new(client, server.url());
    let fetch = src.fetch(&req("any")).await;
    assert!(matches!(fetch.state, SourceState::Error { .. }));
}
