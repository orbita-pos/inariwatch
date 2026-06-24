//! fastembed-rs wrapper — lazy singleton MiniLM-L6-v2 embedder.
//!
//! Strategy:
//!   * The model is heavyweight (~25MB ONNX file) — we lazy-load via
//!     `OnceLock<Mutex<TextEmbedding>>`. First call is slow (download
//!     + load ≈ 1-3s), subsequent calls amortize.
//!   * `embed_batch` runs on `tokio::task::spawn_blocking` so the
//!     event-bus consumer never blocks on inference. fastembed itself
//!     uses rayon internally — passing it a 64-string batch is the
//!     happy path.
//!   * 384-dim is locked by the model. Fixed-size return type keeps
//!     callers honest about the SQL schema (`FLOAT[384]`).
//!
//! Offline behaviour:
//!   * If the model isn't cached and no network is available, the
//!     first call returns `Err(IndexerError::ModelLoad)`. The indexer
//!     surfaces a `SensorWarning` and continues in "degraded mode" —
//!     symbols persist without embeddings; semantic search returns
//!     no hits until the user comes back online.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use super::error::{IndexerError, Result};

/// Embedding dimension produced by MiniLM-L6-v2. SQL schema
/// (`code_embeddings.embedding FLOAT[384]`) is locked to this number.
pub const EMBEDDING_DIM: usize = 384;

/// Soft cap on a single batch. fastembed handles larger batches but
/// 64 keeps p99 latency predictable on a 2-core dev machine.
pub const MAX_BATCH_SIZE: usize = 64;

/// Process-wide singleton. `OnceLock` initializes once; the `Mutex`
/// serializes access (TextEmbedding is not `Sync`). Inference is
/// CPU-bound — concurrent callers queue, which is fine for the
/// indexer's batch-driven workload.
static EMBEDDER: OnceLock<Mutex<TextEmbedding>> = OnceLock::new();

/// Optional override for the model cache directory. Set once at
/// startup (Inari Live points it at
/// `<app_local_data_dir>/inari-live/models/`); test code can leave
/// it default to use `$HOME/.cache/fastembed/`.
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Configure the on-disk cache for the ONNX model + tokenizer. Must
/// be called before the first embed; subsequent calls are no-ops.
pub fn set_cache_dir(dir: PathBuf) {
    let _ = CACHE_DIR.set(dir);
}

/// Force-init the embedder. Useful at startup (warm path on first
/// `RepoIndexed`) or in tests that want to fail fast on offline.
/// Idempotent — repeat calls observe the cached singleton.
pub fn ensure_loaded() -> Result<()> {
    if EMBEDDER.get().is_some() {
        return Ok(());
    }
    let mut opts = InitOptions::new(EmbeddingModel::AllMiniLML6V2);
    opts = opts.with_show_download_progress(false);
    if let Some(dir) = CACHE_DIR.get() {
        std::fs::create_dir_all(dir).map_err(|e| {
            IndexerError::ModelLoad(format!("create cache dir: {e}"))
        })?;
        opts = opts.with_cache_dir(dir.clone());
    }

    let model = TextEmbedding::try_new(opts)
        .map_err(|e| IndexerError::ModelLoad(e.to_string()))?;
    let _ = EMBEDDER.set(Mutex::new(model));
    Ok(())
}

/// Embed a batch of strings into 384-dim vectors. Blocking; callers
/// in async contexts should wrap in `spawn_blocking`. Empty input
/// returns an empty vector without loading the model.
pub fn embed_batch(texts: &[String]) -> Result<Vec<[f32; EMBEDDING_DIM]>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    ensure_loaded()?;

    // Process in MAX_BATCH_SIZE chunks so a 5k-symbol bootstrap stays
    // bounded in memory.
    let mut out: Vec<[f32; EMBEDDING_DIM]> = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(MAX_BATCH_SIZE) {
        let model_guard = EMBEDDER
            .get()
            .ok_or_else(|| IndexerError::ModelLoad("embedder not initialized".into()))?
            .lock()
            .map_err(|e| IndexerError::Embedding(format!("embedder mutex poisoned: {e}")))?;

        // fastembed accepts &[String]; we already own `String`s from
        // the parser so just borrow.
        let owned: Vec<&String> = chunk.iter().collect();
        let vectors = model_guard
            .embed(owned, None)
            .map_err(|e| IndexerError::Embedding(e.to_string()))?;

        for v in vectors {
            if v.len() != EMBEDDING_DIM {
                return Err(IndexerError::Embedding(format!(
                    "expected {EMBEDDING_DIM}-dim vector, got {}", v.len()
                )));
            }
            let mut arr = [0f32; EMBEDDING_DIM];
            arr.copy_from_slice(&v);
            out.push(arr);
        }
    }
    Ok(out)
}

/// Embed a single text. Convenience for the semantic-search query
/// path where we always have one string.
pub fn embed_one(text: &str) -> Result<[f32; EMBEDDING_DIM]> {
    let mut v = embed_batch(&[text.to_string()])?;
    v.pop().ok_or_else(|| {
        IndexerError::Embedding("embed_batch returned empty for single text".into())
    })
}
