//! Sesión 19 — `proxy::run_cloud_agentic` translates SSE events into
//! `RemediationProgress` + `RemediationCompleted` bus events.
//!
//! Spawns a tiny axum server with two endpoints:
//!   - `POST /api/cli/remediation/trigger` returns `{ session_id }`.
//!   - `GET  /api/remediation/stream/<id>` emits 3 SSE progress events
//!     followed by a terminal `completed` event.
//!
//! Asserts: the bus sees the 3 progress events with the right stage
//! tags, then a single `RemediationCompleted { success: true }`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::Path as AxumPath,
    response::{sse::Event, Sse},
    routing::{get, post},
    Json, Router,
};
use inariwatch_desktop_lib::ai::remediate::proxy::{run_cloud_agentic, CloudInput};
use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent};
use inariwatch_desktop_lib::store::queries::{insert_remediation_session, upsert_repo, NewRemediationSession, RemediationMode};
use inariwatch_desktop_lib::store::settings;
use inariwatch_desktop_lib::store::Store;
use serde_json::json;

const REPO_ID:    &str = "repo-cloud";
const SESSION_ID: &str = "sess-cloud-1";

async fn trigger_handler(_body: Json<serde_json::Value>) -> Json<serde_json::Value> {
    Json(json!({ "session_id": "server-issued-id" }))
}

async fn stream_handler(AxumPath(_id): AxumPath<String>) -> impl axum::response::IntoResponse {
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default()
            .event("progress")
            .data(r#"{"stage":"clone","message":"cloning repo"}"#)),
        Ok(Event::default()
            .event("progress")
            .data(r#"{"stage":"explore","message":"reading files"}"#)),
        Ok(Event::default()
            .event("progress")
            .data(r#"{"stage":"patch","message":"writing fix"}"#)),
        Ok(Event::default()
            .event("completed")
            .data(r#"{"pr_url":"https://example.com/pr/42","commit_sha":"abc1234"}"#)),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot_mock_cloud() -> SocketAddr {
    let app = Router::new()
        .route("/api/cli/remediation/trigger", post(trigger_handler))
        .route("/api/remediation/stream/:id", get(stream_handler));
    let l   = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app).await.unwrap();
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

fn open_store() -> Arc<Store> {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("cloud.db")).expect("open store"),
    );
    std::mem::forget(dir);
    store
}

#[tokio::test]
async fn cloud_agentic_emits_progress_then_completed() {
    let mock_addr = boot_mock_cloud().await;
    let store     = open_store();
    upsert_repo(&store, REPO_ID, "/tmp/cloud-repo", "cl", 0).unwrap();
    settings::set(&store, "cloud_api_token", "test-cloud-token").unwrap();
    settings::set(&store, "cloud_base_url", &format!("http://{mock_addr}")).unwrap();

    // Insert a placeholder pending row so the orchestrator's UPDATE
    // path has something to mutate.
    insert_remediation_session(
        &store,
        &NewRemediationSession {
            id:                SESSION_ID,
            repo_id:           REPO_ID,
            mode:              RemediationMode::Cloud,
            error_fingerprint: None,
            error_message:     Some("boom"),
            created_at_ms:     0,
        },
    )
    .unwrap();

    let daemon = Arc::new(start_daemon());
    let rx     = daemon.bus.subscribe();

    let input = CloudInput {
        session_id:        SESSION_ID.to_string(),
        repo_id:           REPO_ID.to_string(),
        error_message:     "boom".to_string(),
        stack_trace:       None,
        error_fingerprint: None,
    };
    run_cloud_agentic(&store, &daemon, input).await.expect("cloud agentic ok");

    // Drain progress + completed events — collect into vectors so we
    // can assert the count + the content independently of order with
    // respect to other bus chatter.
    let mut progress: Vec<(String, String)>     = Vec::new();
    let mut completed: Option<(bool, String)>   = None;

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline && completed.is_none() {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(DaemonEvent::RemediationProgress { stage, message, session_id })
                if session_id == SESSION_ID =>
            {
                progress.push((stage, message));
            }
            Ok(DaemonEvent::RemediationCompleted { success, summary, session_id })
                if session_id == SESSION_ID =>
            {
                completed = Some((success, summary));
            }
            Ok(_)  => {}
            Err(_) => {}
        }
    }

    assert!(
        progress.len() >= 3,
        "expected 3 progress events; got {} ({progress:?})",
        progress.len(),
    );
    let stages: Vec<&str> = progress.iter().map(|(s, _)| s.as_str()).collect();
    assert!(stages.contains(&"clone"));
    assert!(stages.contains(&"explore"));
    assert!(stages.contains(&"patch"));

    let (success, summary) = completed.expect("RemediationCompleted should arrive");
    assert!(success, "cloud completed event should mark success=true");
    assert!(
        summary.contains("https://example.com/pr/42"),
        "summary should embed the PR URL; got {summary:?}",
    );

    daemon.shutdown();
}
