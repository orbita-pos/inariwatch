//! Sesión 21 — `ModelRegistry::ensure_local` rejects any download
//! whose BLAKE3 hash doesn't match the catalogue spec, leaves no
//! file on disk, and writes no `local_models` row.
//!
//! A mock CDN returns 16 bytes of payload for a request the
//! catalogue claims should be a *different* 32-byte payload. The
//! test asserts:
//!   1. `ensure_local` returns `RegistryError::HashMismatch`,
//!   2. the cached path doesn't exist,
//!   3. `local_models` is empty.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{routing::get, Router};
use inariwatch_desktop_lib::local_ai::{
    registry::{ModelFamily, ModelSpec, RegistryError},
    ModelRegistry,
};
use inariwatch_desktop_lib::store::Store;

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
async fn hash_mismatch_rejects_download_and_cleans_up() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).unwrap());

    let payload = b"not the expected bytes".to_vec();
    let addr = boot_cdn(payload).await;

    // The expected BLAKE3 below is for a *different* payload — here
    // we hash `Hello, world!` (15 bytes) instead of "not the
    // expected bytes" (22 bytes). Any constant value that differs
    // from the actual served bytes works; a known-good fixture
    // makes the assertion easier to debug if it regresses.
    let expected_hash = blake3::hash(b"Hello, world!").to_hex().to_string();

    let spec = ModelSpec {
        id:           "fake-model".into(),
        display_name: "Fake".into(),
        blake3_hex:   expected_hash.clone(),
        size_bytes:   22,
        family:       ModelFamily::Tab,
    };

    let models_dir = tmp.path().join("models");
    let registry = ModelRegistry::new_with_paths(
        store.clone(),
        models_dir.clone(),
        vec![spec.clone()],
        format!("http://{addr}"),
    )
    .unwrap();

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        registry.ensure_local("fake-model"),
    )
    .await
    .expect("ensure_local must not hang");

    let err = result.expect_err("must error on hash mismatch");
    match err {
        RegistryError::HashMismatch { model_id, expected, actual } => {
            assert_eq!(model_id, "fake-model");
            assert_eq!(expected, expected_hash);
            assert_ne!(actual, expected, "actual hash must differ");
        }
        other => panic!("expected HashMismatch, got {other:?}"),
    }

    // No file on disk.
    let cached = registry.cached_path(&spec);
    assert!(!cached.exists(), "verified path must not exist");
    let partial = cached.with_extension("partial");
    assert!(!partial.exists(), "partial file must be cleaned up");

    // No DB row.
    let cached_rows = registry.list_cached().expect("list_cached works");
    assert!(
        cached_rows.is_empty(),
        "no local_models row must be written on hash mismatch, got {cached_rows:?}"
    );
}

#[tokio::test]
async fn unknown_model_id_errors_without_touching_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).unwrap());
    let registry = ModelRegistry::new_with_paths(
        store,
        tmp.path().join("models"),
        vec![], // empty catalogue
        "http://127.0.0.1:1".to_string(),
    )
    .unwrap();

    let err = registry.ensure_local("nope").await.expect_err("must error");
    assert!(matches!(err, RegistryError::UnknownModel(_)));
}
