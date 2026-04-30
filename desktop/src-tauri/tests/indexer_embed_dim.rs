//! Embedding dimension is locked at 384 (MiniLM-L6-v2). Marked
//! `#[ignore]` because the model downloads ~25MB on first call —
//! offline CI would fail. Run with `cargo test --test
//! indexer_embed_dim -- --ignored --test-threads=1` when the model is
//! cached.

use inariwatch_desktop_lib::indexer::EMBEDDING_DIM;

#[test]
#[ignore = "downloads ~25MB MiniLM-L6-v2 ONNX model on first call; run --ignored when cached"]
fn embed_batch_returns_384_dim_vectors() {
    use inariwatch_desktop_lib::indexer::embeddings::embed_batch;
    let texts = vec![
        "fn login(username: &str) -> bool { username.len() > 0 }".to_string(),
        "def authenticate(token): return token == \"valid\"".to_string(),
        "register a new user account".to_string(),
        "compute total balance for an account".to_string(),
    ];
    let vectors = embed_batch(&texts).expect("embed must succeed when model is cached");
    assert_eq!(vectors.len(), 4, "one vector per input");
    for v in &vectors {
        assert_eq!(
            v.len(),
            EMBEDDING_DIM,
            "every vector must be {EMBEDDING_DIM}-dim"
        );
        // Sanity: the vector is non-zero.
        let sum: f32 = v.iter().map(|x| x.abs()).sum();
        assert!(sum > 0.0, "embedding should not be all zeros");
    }
}

#[test]
fn embedding_dim_constant_matches_schema() {
    assert_eq!(
        EMBEDDING_DIM, 384,
        "EMBEDDING_DIM must match migration 0002's FLOAT[384]"
    );
}
