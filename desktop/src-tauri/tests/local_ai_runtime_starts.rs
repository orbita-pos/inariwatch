//! Sesión 21 — `RuntimeManager` correctly tracks an externally-pinned
//! endpoint and reports `/health` against it.
//!
//! No real `llama-server` subprocess is spawned: the test brings up a
//! minimal axum server that returns 200 on `/health`, then asks the
//! runtime to treat that URL as the endpoint for a fictional model.
//! This is the same pattern S22+ tests will use to stub the LSP
//! completion handler.

use std::net::SocketAddr;
use std::time::Duration;

use axum::{routing::get, Router};
use inariwatch_desktop_lib::local_ai::{RuntimeManager, SidecarPaths};

async fn boot_health_server(status: u16) -> SocketAddr {
    let app = Router::new().route(
        "/health",
        get(move || async move {
            axum::http::StatusCode::from_u16(status).unwrap()
        }),
    );
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

#[tokio::test]
async fn external_endpoint_registered_and_pings_healthy() {
    let addr = boot_health_server(200).await;
    let runtime = RuntimeManager::new(SidecarPaths::default());

    runtime
        .register_external_endpoint("test-model", format!("http://{addr}"))
        .await;

    assert!(runtime.is_loaded("test-model").await, "model should report loaded");
    let endpoint = runtime
        .endpoint_for("test-model")
        .await
        .expect("endpoint resolved");
    assert!(endpoint.base_url.starts_with("http://127.0.0.1:"));

    let healthy = runtime.ping_health("test-model").await.expect("ping ok");
    assert!(healthy, "mock /health should return 200");
}

#[tokio::test]
async fn ping_unhealthy_when_server_returns_500() {
    let addr = boot_health_server(500).await;
    let runtime = RuntimeManager::new(SidecarPaths::default());
    runtime
        .register_external_endpoint("broken-model", format!("http://{addr}"))
        .await;

    let healthy = runtime.ping_health("broken-model").await.expect("ping returns Ok");
    assert!(!healthy, "5xx must surface as not-healthy");
}

#[tokio::test]
async fn endpoint_for_unknown_model_errors() {
    let runtime = RuntimeManager::new(SidecarPaths::default());
    let err = runtime
        .endpoint_for("never-registered")
        .await
        .expect_err("must error on unknown id");
    let msg = format!("{err}");
    assert!(
        msg.contains("never-registered"),
        "error must name the model id, got: {msg}"
    );
}
