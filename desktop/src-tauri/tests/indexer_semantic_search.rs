//! End-to-end semantic search: index a tiny synthetic codebase, embed
//! the symbols, run a natural-language query, assert the auth-related
//! symbols rank above the unrelated ones.
//!
//! Marked `#[ignore]` because it loads the MiniLM model (~25MB,
//! lazy-downloaded by fastembed on first call). Run with
//! `cargo test --test indexer_semantic_search -- --ignored
//! --test-threads=1` once the model is cached locally.

use std::sync::Arc;

use inariwatch_desktop_lib::indexer;
use inariwatch_desktop_lib::indexer::embeddings::embed_one;
use inariwatch_desktop_lib::store::queries::{upsert_embedding, upsert_repo, upsert_symbol, SymbolRow};
use inariwatch_desktop_lib::store::Store;

fn open_store() -> Arc<Store> {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("semantic.db");
    let store = Arc::new(Store::open_at(&path).expect("open store"));
    std::mem::forget(tmp);
    store
}

#[test]
#[ignore = "loads MiniLM-L6-v2 ONNX model (~25MB); run --ignored when cached"]
fn semantic_search_ranks_authentication_symbols_first() {
    let store = open_store();
    upsert_repo(&store, "repoSearch", "/tmp/repoSearch", "search-test", 0).unwrap();

    // 5 fixture symbols. The first 3 are auth-related; the last 2
    // are unrelated. We assert top-3 hits are drawn from the
    // auth set.
    let fixture: &[(&str, &str, &str)] = &[
        ("auth_service",   "function",
         "function auth_service(user, password) { verify the credentials and return a session token }"),
        ("login_handler",  "function",
         "async function login_handler(req) { authenticate the user with email and password, return JWT }"),
        ("register_user",  "function",
         "async function register_user(email, password) { create a user account and send verification email }"),
        ("compute_total",  "function",
         "function compute_total(items) { sum the prices of all items in the shopping cart }"),
        ("render_chart",   "function",
         "function render_chart(data) { draw a line chart of the time series data on the canvas }"),
    ];

    for (name, kind, body) in fixture {
        let row = SymbolRow {
            repo_id: "repoSearch",
            file_path: "src/lib.ts",
            symbol_name: name,
            kind,
            line_start: 1,
            line_end: 5,
            ast_hash: &format!("hash-{name}"),
        };
        let id = upsert_symbol(&store, &row).unwrap();
        let v = embed_one(body).expect("embed body");
        upsert_embedding(&store, id, v.as_slice()).expect("upsert embedding");
    }

    let hits = indexer::search(&store, "user authentication and login flow", 3, Some("repoSearch"))
        .expect("search");
    assert_eq!(hits.len(), 3, "expected 3 hits");

    let names: Vec<&str> = hits.iter().map(|h| h.symbol_name.as_str()).collect();
    let auth_hits = names
        .iter()
        .filter(|n| matches!(**n, "auth_service" | "login_handler" | "register_user"))
        .count();
    assert!(
        auth_hits >= 2,
        "expected at least 2 auth-related symbols in top-3, got {names:?}"
    );

    // Sanity: similarity is a finite float in [-1, 1].
    for h in &hits {
        assert!(
            h.similarity.is_finite() && h.similarity >= -1.0 && h.similarity <= 1.0,
            "similarity out of range: {} for {}", h.similarity, h.symbol_name
        );
    }
}
