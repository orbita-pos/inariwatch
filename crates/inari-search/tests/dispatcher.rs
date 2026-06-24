//! Dispatcher fan-out — wall-budget enforcement + per-source independence.
//!
//! These tests construct three mockito servers (one per source), wire
//! the dispatcher with a custom `reqwest::Client` short timeout, and
//! verify:
//!
//! 1. Three sources fetched in parallel, all 200 → merged response
//!    carries hits from all 3.
//! 2. One source sleeps past `SOURCE_TIMEOUT_MS` → that source reports
//!    `Timeout`, the other two return their hits.
//! 3. Total wall-time stays within the wall-budget when one source
//!    takes 2s — the join doesn't wait for it.
//! 4. One source 429s → that source reports `RateLimited`, others ok.

use inari_search::online::{
    github::GitHubSource, mdn::MdnSource, stackexchange::StackExchangeSource, Dispatcher,
};
use inari_search::types::{SearchRequest, SourceState, SourceTag};
use std::time::{Duration, Instant};

fn req(text: &str) -> SearchRequest {
    SearchRequest {
        error_text: text.into(),
        language: None,
        framework: None,
        max_hits: 20,
    }
}

fn so_payload() -> String {
    serde_json::json!({
        "items": [
            { "question_id": 1, "title": "SO 1", "excerpt": "x", "score": 5,
              "is_accepted": false, "answer_count": 1 }
        ],
        "quota_remaining": 9000
    })
    .to_string()
}

fn gh_payload() -> String {
    serde_json::json!({
        "items": [
            { "html_url": "https://github.com/o/r/issues/1", "title": "GH 1",
              "body": "x", "state": "open", "comments": 0,
              "reactions": { "total_count": 5 } }
        ]
    })
    .to_string()
}

fn mdn_payload() -> String {
    serde_json::json!({
        "documents": [
            { "title": "MDN 1", "summary": "x",
              "mdn_url": "/en-US/docs/Web/X" }
        ]
    })
    .to_string()
}

async fn dispatcher_with_three_servers() -> (
    Dispatcher,
    mockito::ServerGuard,
    mockito::ServerGuard,
    mockito::ServerGuard,
) {
    let so_server = mockito::Server::new_async().await;
    let gh_server = mockito::Server::new_async().await;
    let mdn_server = mockito::Server::new_async().await;
    let client = reqwest::Client::builder()
        .user_agent("inari-search-test/0.1")
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let dispatcher = Dispatcher {
        stackexchange: StackExchangeSource::new(client.clone(), so_server.url()),
        github: GitHubSource::new(client.clone(), gh_server.url()),
        mdn: MdnSource::new(client, mdn_server.url()),
    };
    (dispatcher, so_server, gh_server, mdn_server)
}

#[tokio::test]
async fn happy_path_fans_out_to_three_sources_and_merges() {
    let (dispatcher, mut so, mut gh, mut mdn) = dispatcher_with_three_servers().await;
    so.mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(200)
        .with_body(so_payload())
        .create_async()
        .await;
    so.mock("GET", mockito::Matcher::Regex(".*/questions/.*/answers.*".into()))
        .with_status(200)
        .with_body(serde_json::json!({"items":[]}).to_string())
        .create_async()
        .await;
    gh.mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(200)
        .with_body(gh_payload())
        .create_async()
        .await;
    mdn.mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_body(mdn_payload())
        .create_async()
        .await;

    let resp = dispatcher.dispatch(&req("err")).await;
    assert_eq!(resp.hits.len(), 3, "one hit per source");
    assert_eq!(resp.sources_used.len(), 3);
    let sources: Vec<SourceTag> = resp.sources_used.iter().map(|s| s.source).collect();
    assert!(sources.contains(&SourceTag::StackOverflow));
    assert!(sources.contains(&SourceTag::GitHub));
    assert!(sources.contains(&SourceTag::Mdn));
    for s in &resp.sources_used {
        assert!(matches!(s.state, SourceState::Ok { hit_count: 1 }), "got {:?}", s.state);
    }
}

#[tokio::test]
async fn slow_source_times_out_and_others_still_return() {
    let (dispatcher, mut so, mut gh, mut mdn) = dispatcher_with_three_servers().await;
    // SO sleeps for 2s — past SOURCE_TIMEOUT_MS (700ms).
    so.mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_chunked_body(|w| {
            std::thread::sleep(Duration::from_secs(2));
            let _ = w.write_all(so_payload().as_bytes());
            Ok(())
        })
        .with_status(200)
        .create_async()
        .await;
    gh.mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(200)
        .with_body(gh_payload())
        .create_async()
        .await;
    mdn.mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_body(mdn_payload())
        .create_async()
        .await;

    let start = Instant::now();
    let resp = dispatcher.dispatch(&req("err")).await;
    let elapsed = start.elapsed();

    // Wall budget assertion: must come back well before the slow
    // source's 2s sleep finishes. SOURCE_TIMEOUT_MS is 700ms; allow
    // generous slack for join + cleanup.
    assert!(
        elapsed < Duration::from_millis(1500),
        "dispatch took {elapsed:?} — expected near 700ms, got beyond 1500ms"
    );

    // Two sources returned hits.
    assert!(resp.hits.len() >= 2, "expected ≥2 hits, got {}", resp.hits.len());

    // SO reported timeout.
    let so_status = resp
        .sources_used
        .iter()
        .find(|s| s.source == SourceTag::StackOverflow)
        .expect("SO status row");
    assert!(
        matches!(so_status.state, SourceState::Timeout),
        "SO state should be Timeout, got {:?}",
        so_status.state
    );

    // Other two are Ok.
    for s in &resp.sources_used {
        if s.source != SourceTag::StackOverflow {
            assert!(matches!(s.state, SourceState::Ok { .. }));
        }
    }
}

#[tokio::test]
async fn rate_limited_source_does_not_block_others() {
    let (dispatcher, mut so, mut gh, mut mdn) = dispatcher_with_three_servers().await;
    so.mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(429)
        .with_body("{}")
        .create_async()
        .await;
    gh.mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(200)
        .with_body(gh_payload())
        .create_async()
        .await;
    mdn.mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(200)
        .with_body(mdn_payload())
        .create_async()
        .await;

    let resp = dispatcher.dispatch(&req("err")).await;
    assert_eq!(resp.hits.len(), 2);
    let so_status = resp
        .sources_used
        .iter()
        .find(|s| s.source == SourceTag::StackOverflow)
        .unwrap();
    assert!(matches!(so_status.state, SourceState::RateLimited));
}

#[tokio::test]
async fn all_sources_failing_returns_empty_response_not_error() {
    let (dispatcher, mut so, mut gh, mut mdn) = dispatcher_with_three_servers().await;
    so.mock("GET", mockito::Matcher::Regex(".*/search/excerpts.*".into()))
        .with_status(429)
        .with_body("{}")
        .create_async()
        .await;
    gh.mock("GET", mockito::Matcher::Regex(".*/search/issues.*".into()))
        .with_status(429)
        .with_body("{}")
        .create_async()
        .await;
    mdn.mock("GET", mockito::Matcher::Regex(".*/api/v1/search.*".into()))
        .with_status(429)
        .with_body("{}")
        .create_async()
        .await;

    let resp = dispatcher.dispatch(&req("err")).await;
    assert!(resp.hits.is_empty());
    assert_eq!(resp.sources_used.len(), 3);
    for s in &resp.sources_used {
        assert!(matches!(s.state, SourceState::RateLimited));
    }
}
