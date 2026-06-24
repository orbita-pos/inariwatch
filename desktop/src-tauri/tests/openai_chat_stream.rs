//! Sesión 18 — `OpenAIClient::chat_stream` parses SSE chunks correctly.
//!
//! Spawns a local axum server that emits a canned SSE response with 5
//! deltas + a `finish_reason: "stop"` closing chunk + `data: [DONE]`.
//! Asserts the client yields the deltas in order and surfaces
//! `finish_reason: Some("stop")` on the closing chunk.

use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    response::{sse::Event, Sse},
    routing::post,
    Router,
};
use futures_util::stream::StreamExt;
use inariwatch_desktop_lib::ai::budget::Model;
use inariwatch_desktop_lib::ai::openai::OpenAIClient;
use inariwatch_desktop_lib::ai::prompts::ChatMessage;

async fn handler() -> impl axum::response::IntoResponse {
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"Hello"}}]}"#)),
        Ok(Event::default().data(r#"{"choices":[{"delta":{"content":" "}}]}"#)),
        Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"streaming"}}]}"#)),
        Ok(Event::default().data(r#"{"choices":[{"delta":{"content":" "}}]}"#)),
        Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"world"}}]}"#)),
        Ok(Event::default().data(r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}"#)),
        Ok(Event::default().data("[DONE]")),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot() -> SocketAddr {
    let app = Router::new().route("/v1/chat/completions", post(handler));
    let l   = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

#[tokio::test]
async fn chat_stream_emits_chunks_in_order() {
    let addr   = boot().await;
    let client = OpenAIClient::with_key("sk-test-key").with_base_url(format!("http://{addr}"));
    let msgs   = vec![ChatMessage::user("hi")];

    let mut stream = client.chat_stream(&msgs, Model::Gpt4oMini).await.expect("stream opens");

    let mut deltas: Vec<String> = Vec::new();
    let mut finish: Option<String> = None;
    let mut usage_seen = false;

    while let Some(item) = stream.next().await {
        let chunk = item.expect("chunk ok");
        if !chunk.delta.is_empty() {
            deltas.push(chunk.delta);
        }
        if let Some(reason) = chunk.finish_reason {
            finish = Some(reason);
        }
        if chunk.usage.is_some() {
            usage_seen = true;
        }
    }

    assert_eq!(deltas, vec!["Hello", " ", "streaming", " ", "world"]);
    assert_eq!(finish.as_deref(), Some("stop"));
    assert!(usage_seen, "usage block should arrive on final chunk");
}
