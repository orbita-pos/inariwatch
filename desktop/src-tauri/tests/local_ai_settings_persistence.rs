//! Sesión 21 — model registry rows + `local_ai_*` settings survive
//! a `Store` close → reopen cycle.
//!
//! Steps:
//!   1. Open a tempdir store, run a real (matching-hash) download
//!      against a mock CDN, assert one `local_models` row exists.
//!   2. Drop the store + registry, reopen the same db file, build a
//!      new registry, assert the row is still there with the same
//!      hash + size.
//!   3. Bonus: assert the migration-seeded `local_ai_enabled` setting
//!      is queryable from the new connection.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{routing::get, Router};
use inariwatch_desktop_lib::local_ai::{
    registry::{ModelFamily, ModelSpec},
    ModelRegistry,
};
use inariwatch_desktop_lib::store::{settings, Store};

async fn boot_cdn(payload: Vec<u8>) -> SocketAddr {
    let app = Router::new().route(
        "/:model_id/:hash",
        get(move |_p: axum::extract::Path<(String, String)>| {
            let body = payload.clone();
            async move {
                (
                    axum::http::StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
                    body,
                )
            }
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
async fn registry_row_and_settings_persist_across_store_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("store.db");

    // Stable, small payload — keeps the test fast and the disk
    // footprint trivial.
    let payload = b"inari-test-gguf-blob-v1".to_vec();
    let expected_hash = blake3::hash(&payload).to_hex().to_string();
    let payload_size  = payload.len() as i64;
    let addr = boot_cdn(payload).await;

    let spec = ModelSpec {
        id:           "persist-stub".into(),
        display_name: "Persist Stub".into(),
        blake3_hex:   expected_hash.clone(),
        size_bytes:   payload_size as u64,
        family:       ModelFamily::Tab,
    };

    let models_dir = tmp.path().join("models");

    // ── Phase 1 — fresh open + download ───────────────────────────
    {
        let store = Arc::new(Store::open_at(&db_path).unwrap());

        // Migration 0009 must have seeded the `local_ai_enabled` row.
        let raw = settings::get(&store, "local_ai_enabled")
            .expect("settings query ok")
            .expect("migration seeded the row");
        assert_eq!(raw, "false", "default must be opt-out");

        let registry = ModelRegistry::new_with_paths(
            store.clone(),
            models_dir.clone(),
            vec![spec.clone()],
            format!("http://{addr}"),
        )
        .unwrap();

        let path = tokio::time::timeout(
            Duration::from_secs(5),
            registry.ensure_local("persist-stub"),
        )
        .await
        .expect("download must not hang")
        .expect("download succeeds");

        assert!(path.exists(), "verified file exists on disk");
        let cached = registry.list_cached().expect("list ok");
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].model_id, "persist-stub");
        assert_eq!(cached[0].content_hash, expected_hash);
        assert_eq!(cached[0].size_bytes, payload_size);
        assert!(cached[0].downloaded_at > 0);

        // Update a settings row to verify the round-trip too.
        settings::set(&store, "local_ai_enabled", "true").unwrap();
    }

    // ── Phase 2 — reopen + assert persistence ─────────────────────
    {
        let store = Arc::new(Store::open_at(&db_path).unwrap());

        let raw = settings::get(&store, "local_ai_enabled")
            .expect("settings query ok")
            .expect("setting still there");
        assert_eq!(raw, "true", "settings must survive reopen");

        let registry = ModelRegistry::new_with_paths(
            store.clone(),
            models_dir.clone(),
            vec![spec.clone()],
            format!("http://{addr}"),
        )
        .unwrap();

        let cached = registry.list_cached().expect("list ok");
        assert_eq!(cached.len(), 1, "row survives reopen");
        assert_eq!(cached[0].model_id, "persist-stub");
        assert_eq!(cached[0].content_hash, expected_hash);
        assert_eq!(cached[0].size_bytes, payload_size);

        // is_cached should agree (file path on disk matches the row).
        assert!(registry.is_cached("persist-stub"));
    }
}
