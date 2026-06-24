//! sqlite-vec is auto-loaded on every fresh connection from the pool.
//! Inserting a 384-dim vector then computing cosine distance against
//! a second vector returns a finite float in [0, 2].

use inariwatch_desktop_lib::store::Store;
use rusqlite::params;

fn unit_vec_dim_first(dim: usize, idx: usize) -> Vec<f32> {
    // Returns a unit vector with 1.0 at position `idx` and 0 elsewhere.
    // Two such vectors with different `idx` are orthogonal — cosine
    // distance = 1.0 (1 - 0).
    let mut v = vec![0.0_f32; dim];
    v[idx] = 1.0;
    v
}

fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    // sqlite-vec FLOAT[N] columns accept a tightly-packed little-endian
    // blob of 4-byte floats. (The crate's KnnQuery wrapper is also
    // available but the raw blob format is the documented contract.)
    let mut out = Vec::with_capacity(v.len() * 4);
    for &f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

#[test]
fn vec_module_loaded_and_cosine_distance_works() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let conn = store.conn().expect("conn");

    // The vec_version() function is registered by sqlite-vec — its
    // presence is the cleanest "extension loaded" signal.
    let version: String = conn
        .query_row("SELECT vec_version()", [], |row| row.get(0))
        .expect("vec_version() should be available");
    assert!(
        !version.is_empty(),
        "vec_version() returned empty string: {version}"
    );

    // Insert 2 384-dim vectors into code_embeddings (created by 0002).
    let a = unit_vec_dim_first(384, 0);
    let b = unit_vec_dim_first(384, 1);

    conn.execute(
        "INSERT INTO code_embeddings (symbol_id, embedding) VALUES (?1, ?2)",
        params![1_i64, vec_to_blob(&a)],
    )
    .expect("insert a");
    conn.execute(
        "INSERT INTO code_embeddings (symbol_id, embedding) VALUES (?1, ?2)",
        params![2_i64, vec_to_blob(&b)],
    )
    .expect("insert b");

    // vec_distance_cosine(a, a) should be ~ 0; vec_distance_cosine(a, b)
    // should be ~ 1 (orthogonal unit vectors).
    let self_dist: f64 = conn
        .query_row(
            "SELECT vec_distance_cosine(
                 (SELECT embedding FROM code_embeddings WHERE symbol_id = 1),
                 (SELECT embedding FROM code_embeddings WHERE symbol_id = 1)
             )",
            [],
            |row| row.get(0),
        )
        .expect("self distance");
    assert!(
        self_dist.abs() < 1e-4,
        "cosine(a,a) expected ≈0, got {self_dist}"
    );

    let cross_dist: f64 = conn
        .query_row(
            "SELECT vec_distance_cosine(
                 (SELECT embedding FROM code_embeddings WHERE symbol_id = 1),
                 (SELECT embedding FROM code_embeddings WHERE symbol_id = 2)
             )",
            [],
            |row| row.get(0),
        )
        .expect("cross distance");
    assert!(
        (cross_dist - 1.0).abs() < 1e-4,
        "cosine(a,b) for orthogonal vectors expected ≈1, got {cross_dist}"
    );

    // Sanity bound: cosine distance must always be in [0, 2].
    assert!((0.0..=2.0).contains(&cross_dist));
}
