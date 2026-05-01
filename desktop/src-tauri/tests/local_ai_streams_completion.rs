//! Sesión 21 — `LocalAI::generate` parses the SSE stream from a
//! llama-server-shaped `/completion` endpoint and yields the
//! streamed tokens in order with the `finish_reason` populated on
//! the closing chunk.
//!
//! The test bypasses the registry/runtime download path by registering
//! the mock server directly as the model's external endpoint.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    response::{sse::Event, Sse},
    routing::post,
    Router,
};
use futures_util::stream::StreamExt;
use inariwatch_desktop_lib::local_ai::{
    registry::{ModelFamily, ModelSpec},
    GenerateOptions, LocalAI, ModelRegistry, RuntimeManager, SidecarPaths,
};
use inariwatch_desktop_lib::store::Store;

async fn completion_handler() -> impl axum::response::IntoResponse {
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(r#"{"content":"fn ","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"add","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"(a, b)","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"","stop":true,"stop_type":"length"}"#)),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot_completion_server() -> SocketAddr {
    let app = Router::new().route("/completion", post(completion_handler));
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

#[tokio::test]
async fn generate_streams_three_tokens_then_finishes() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).unwrap());

    let spec = ModelSpec {
        id:           "stub".into(),
        display_name: "Stub".into(),
        blake3_hex:   "0".repeat(64),
        size_bytes:   1,
        family:       ModelFamily::Tab,
    };
    let registry = ModelRegistry::new_with_paths(
        store.clone(),
        tmp.path().join("models"),
        vec![spec],
        "http://127.0.0.1:1".to_string(), // never used — we pre-register an endpoint
    )
    .unwrap();
    let runtime = RuntimeManager::new(SidecarPaths::default());

    let addr = boot_completion_server().await;
    runtime
        .register_external_endpoint("stub", format!("http://{addr}"))
        .await;

    let local = LocalAI::from_parts(registry, runtime);

    let mut stream = local
        .generate(GenerateOptions {
            model_id:   "stub".into(),
            prompt:     "fn ".into(),
            max_tokens: 32,
            stop_seqs:  vec!["\n\n".into()],
            fim_mode:   true,
        })
        .await
        .expect("stream opens");

    let mut deltas: Vec<String> = Vec::new();
    let mut finish: Option<String> = None;

    let drained = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(item) = stream.next().await {
            let tok = item.expect("token ok");
            if !tok.text.is_empty() {
                deltas.push(tok.text);
            }
            if let Some(reason) = tok.finish_reason {
                finish = Some(reason);
            }
        }
    })
    .await;

    drained.expect("stream drains within timeout");
    assert_eq!(deltas, vec!["fn ", "add", "(a, b)"]);
    assert_eq!(finish.as_deref(), Some("length"));
}
