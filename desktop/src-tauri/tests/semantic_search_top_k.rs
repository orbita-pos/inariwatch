//! Sesión 13 — semantic memory layer.
//!
//! Validates that `crate::store::queries::semantic_search` (the
//! engine the `crate::memory::semantic::search` wrapper delegates to)
//! returns the right top-K hits and respects the `repo_id` filter
//! when fed deterministic synthetic embeddings. We deliberately
//! bypass `embed_one` here so the test runs without loading the
//! MiniLM ONNX model — that path is exercised by the
//! `#[ignore]`-gated `indexer_semantic_search` integration test.
//!
//! The wrapper itself is referenced (typed function pointer) so a
//! signature regression at the layer boundary still breaks the build.

use std::sync::Arc;
use std::time::Instant;

use inariwatch_desktop_lib::indexer::EMBEDDING_DIM;
use inariwatch_desktop_lib::store::queries::{
    semantic_search, upsert_embedding, upsert_repo, upsert_symbol, SymbolRow,
};
use inariwatch_desktop_lib::store::Store;

const REPO_PRIMARY: &str = "repo-primary";
const REPO_OTHER:   &str = "repo-other";

fn open_store() -> Arc<Store> {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("semantic.db")).expect("open store"),
    );
    // Keep the tempdir alive for the duration of the test — Store has
    // no Drop hook and SQLite holds the file open via the pool.
    std::mem::forget(dir);
    store
}

/// Build a 384-dim embedding aligned with the canonical query
/// direction `[1, 0, 0, …, 0]`. `score` is written to `dim[0]`; a
/// constant `1.0` lives in `dim[1]` so cosine similarity is well-
/// defined (the magnitude is never zero) and strictly monotonic in
/// `score`.
fn make_embedding(score: f32) -> Vec<f32> {
    let mut v = vec![0f32; EMBEDDING_DIM];
    v[0] = score;
    v[1] = 1.0;
    v
}

fn query_vec() -> Vec<f32> {
    let mut v = vec![0f32; EMBEDDING_DIM];
    v[0] = 1.0;
    v
}

#[test]
fn semantic_search_returns_top_k_in_descending_similarity() {
    let store = open_store();
    upsert_repo(&store, REPO_PRIMARY, "/tmp/repo-primary", "primary", 0).unwrap();
    upsert_repo(&store, REPO_OTHER,   "/tmp/repo-other",   "other",   0).unwrap();

    // 50 symbols on the primary repo, monotonically decreasing
    // similarity. Symbol i has score (50 - i) / 50 ⇒ the top-K query
    // is symbols 0..K. Plus 10 symbols on a second repo, each with
    // the highest possible score so they would dominate the global
    // ranking — the repo filter must keep them out.
    for i in 0..50u32 {
        let row = SymbolRow {
            repo_id:     REPO_PRIMARY,
            file_path:   "src/lib.rs",
            symbol_name: &format!("primary_sym_{i:02}"),
            kind:        "function",
            line_start:  i + 1,
            line_end:    i + 5,
            ast_hash:    &format!("primary-{i}"),
        };
        let id = upsert_symbol(&store, &row).unwrap();
        let score = (50.0 - i as f32) / 50.0;
        upsert_embedding(&store, id, &make_embedding(score)).unwrap();
    }
    for i in 0..10u32 {
        let row = SymbolRow {
            repo_id:     REPO_OTHER,
            file_path:   "src/lib.rs",
            symbol_name: &format!("other_sym_{i:02}"),
            kind:        "function",
            line_start:  i + 1,
            line_end:    i + 5,
            ast_hash:    &format!("other-{i}"),
        };
        let id = upsert_symbol(&store, &row).unwrap();
        // Highest score — would dominate without the repo filter.
        upsert_embedding(&store, id, &make_embedding(2.0)).unwrap();
    }

    let q = query_vec();

    // Filtered query — should never return any "other" rows.
    let started = Instant::now();
    let hits    = semantic_search(&store, &q, 5, Some(REPO_PRIMARY))
        .expect("semantic_search filtered");
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "[perf] semantic_search filtered (50 primary + 10 noise, k=5): {:.2} ms",
        elapsed_ms
    );

    assert_eq!(hits.len(), 5, "expected 5 hits, got {}", hits.len());
    for h in &hits {
        assert_eq!(h.repo_id, REPO_PRIMARY, "repo filter leaked: {:?}", h);
    }
    let names: Vec<_> = hits.iter().map(|h| h.symbol_name.as_str()).collect();
    let expected = [
        "primary_sym_00",
        "primary_sym_01",
        "primary_sym_02",
        "primary_sym_03",
        "primary_sym_04",
    ];
    assert_eq!(names, expected, "ordering wrong: {:?}", names);

    // Strictly monotonically decreasing similarity.
    for w in hits.windows(2) {
        assert!(
            w[0].similarity >= w[1].similarity,
            "non-monotonic ordering: {} ({}) before {} ({})",
            w[0].symbol_name, w[0].similarity,
            w[1].symbol_name, w[1].similarity,
        );
    }

    // Unfiltered query — should pull the noise repo to the top because
    // those rows have the highest synthetic score.
    let unfiltered = semantic_search(&store, &q, 5, None)
        .expect("semantic_search unfiltered");
    assert_eq!(unfiltered.len(), 5);
    for h in &unfiltered {
        assert_eq!(h.repo_id, REPO_OTHER, "noise repo should dominate without filter");
    }
}

/// Compile-time check that the `memory::semantic::search` wrapper
/// keeps the documented signature. A change here means the layer
/// boundary contract moved and downstream consumers need an audit.
#[test]
fn memory_semantic_search_signature_is_stable() {
    fn _assert<F>(_: F)
    where
        F: for<'a> Fn(
            &'a Arc<Store>,
            &'a str,
            usize,
            Option<&'a str>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<
                Output = inariwatch_desktop_lib::memory::error::Result<
                    Vec<inariwatch_desktop_lib::memory::semantic::Hit>,
                >,
            > + Send + 'a>,
        >,
    {}
    // Type-elision: the closure proves the signature without ever
    // calling the wrapper (which would load the MiniLM model).
    _assert(|store, query, k, repo_id| Box::pin(async move {
        inariwatch_desktop_lib::memory::semantic::search(store, query, k, repo_id).await
    }));
}
