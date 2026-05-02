//! v0.3 Phase A — integration tests for the read-only cloud-dashboard
//! widget fetchers (`crate::cloud::widgets`).
//!
//! Each test stands up a `mockito::Server` fixture, persists its URL +
//! a fake token in the SQL settings store, and asserts that the
//! corresponding `widgets::get_*` function:
//!   - issues a GET against the right path with `Authorization: Bearer <token>`,
//!   - decodes the JSON payload into the typed struct,
//!   - normalizes 401 / non-200 / network errors to the `Result<_, String>`
//!     the IPC layer surfaces.
//!
//! No Tauri AppHandle is constructed: the public widget fns accept
//! `Option<&AppHandle>` and skip the 401 event-emit when `None`.
//!
//! Aligns with the rest of the v0.2 desktop integration suite — same
//! `fresh_store()` pattern as `legacy_settings_migration.rs` etc.

use inariwatch_desktop_lib::cloud::widgets;
use inariwatch_desktop_lib::store::{settings, Store};

fn fresh_store() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db = tmp.path().join("inari-live").join("store.db");
    let store = Store::open_at(&db).expect("open store");
    (tmp, store)
}

fn wire_creds(store: &Store, base_url: &str) {
    settings::set(store, "dashboard_url", base_url).expect("dashboard_url");
    settings::set(store, "dashboard_token", "test-token").expect("dashboard_token");
}

#[tokio::test]
async fn get_status_summary_decodes_payload() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/status-summary")
        .match_header("authorization", "Bearer test-token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{
                "state":"degraded",
                "alertsCritical24h":1,
                "alertsWarning24h":3,
                "monitorsDown":0,
                "monitorsTotal":2,
                "projectCount":4,
                "lastAlertAt":"2026-05-02T00:00:00Z"
            }"#,
        )
        .create_async()
        .await;

    let summary = widgets::get_status_summary(&store, None)
        .await
        .expect("status summary");
    assert_eq!(summary.state, "degraded");
    assert_eq!(summary.alerts_critical_24h, 1);
    assert_eq!(summary.alerts_warning_24h, 3);
    assert_eq!(summary.monitors_total, 2);
    assert_eq!(summary.project_count, 4);
    assert_eq!(summary.last_alert_at.as_deref(), Some("2026-05-02T00:00:00Z"));
}

#[tokio::test]
async fn get_uptime_decodes_payload_with_optional_response_time() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/uptime")
        .with_status(200)
        .with_body(
            r#"{
                "monitors":[
                    {"id":"m1","name":"api","url":"https://x","isDown":false,"consecutiveFailures":0,"lastCheckedAt":null,"lastResponseTimeMs":120}
                ],
                "downCount":0,
                "total":1,
                "avgResponseMs":120
            }"#,
        )
        .create_async()
        .await;

    let s = widgets::get_uptime(&store, None).await.expect("uptime");
    assert_eq!(s.total, 1);
    assert_eq!(s.down_count, 0);
    assert_eq!(s.avg_response_ms, Some(120));
    assert_eq!(s.monitors.len(), 1);
    assert_eq!(s.monitors[0].id, "m1");
    assert_eq!(s.monitors[0].last_response_time_ms, Some(120));
}

#[tokio::test]
async fn get_deploys_passes_limit_query_param() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/deploys?limit=4")
        .with_status(200)
        .with_body(r#"{"deploys":[],"failedCount":0}"#)
        .create_async()
        .await;

    let s = widgets::get_deploys(&store, None, 4).await.expect("deploys");
    assert_eq!(s.failed_count, 0);
    assert_eq!(s.deploys.len(), 0);
}

#[tokio::test]
async fn get_oncall_decodes_schedules_with_overrides() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/oncall")
        .with_status(200)
        .with_body(
            r#"{
                "schedules":[
                    {
                        "projectId":"p1","projectName":"app","scheduleName":"weekday",
                        "timezone":"UTC",
                        "primary":{"userId":"u1","name":"Ana","email":"ana@example.com"},
                        "secondary":null,
                        "hasActiveOverride":true
                    }
                ],
                "totalAssignments":1
            }"#,
        )
        .create_async()
        .await;

    let s = widgets::get_oncall(&store, None).await.expect("oncall");
    assert_eq!(s.schedules.len(), 1);
    assert_eq!(s.total_assignments, 1);
    assert!(s.schedules[0].has_active_override);
    assert_eq!(s.schedules[0].primary.as_ref().unwrap().user_id, "u1");
    assert!(s.schedules[0].secondary.is_none());
}

#[tokio::test]
async fn get_community_trending_passes_limit() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/community/trending?limit=2")
        .with_status(200)
        .with_body(
            r#"[
                {
                    "id":"f1","patternId":"p1","patternTitle":"X is null",
                    "fixApproach":"add guard","fixDescription":"…",
                    "successCount":10,"failureCount":2,
                    "successRate":83,"totalApplications":12
                }
            ]"#,
        )
        .create_async()
        .await;

    let s = widgets::get_community_trending(&store, None, 2).await.expect("trending");
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].success_rate, 83);
    assert_eq!(s[0].total_applications, 12);
}

#[tokio::test]
async fn get_status_summary_unauthorized_surfaces_error() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/status-summary")
        .with_status(401)
        .create_async()
        .await;

    let err = widgets::get_status_summary(&store, None)
        .await
        .expect_err("should reject");
    assert_eq!(err, "unauthorized");
}

#[tokio::test]
async fn get_status_summary_server_500_surfaces_http_error() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/status-summary")
        .with_status(500)
        .create_async()
        .await;

    let err = widgets::get_status_summary(&store, None)
        .await
        .expect_err("should reject");
    assert!(err.starts_with("HTTP 500"), "got `{}`", err);
}

#[tokio::test]
async fn skips_request_when_not_connected() {
    let (_tmp, store) = fresh_store();
    // No `dashboard_token` set.
    settings::set(&store, "dashboard_url", "https://app.inariwatch.com").expect("url");

    let err = widgets::get_status_summary(&store, None)
        .await
        .expect_err("should reject");
    assert_eq!(err, "not_connected");
}

#[tokio::test]
async fn get_alerts_decodes_array_payload() {
    let (_tmp, store) = fresh_store();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&store, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/alerts")
        .with_status(200)
        .with_body(
            r#"[
                {
                    "id":"a1","title":"oops","body":null,"severity":"critical",
                    "aiReasoning":null,"sourceIntegrations":["sentry"],
                    "projectName":"app","fingerprint":null,
                    "isRead":false,"isResolved":false,
                    "createdAt":"2026-05-02T00:00:00Z"
                }
            ]"#,
        )
        .create_async()
        .await;

    let alerts = widgets::get_alerts(&store, None, 20).await.expect("alerts");
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].id, "a1");
    assert_eq!(alerts[0].severity, "critical");
    assert_eq!(alerts[0].source_integrations, vec!["sentry".to_string()]);
}
