//! Indexer error type. Narrow on purpose — every variant maps to a
//! concrete failure mode in the indexer pipeline.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum IndexerError {
    /// tree-sitter setLanguage / parse failure.
    #[error("parse error: {0}")]
    Parse(String),

    /// fastembed model load / inference error. Wraps `anyhow::Error`
    /// from fastembed via Display.
    #[error("embedding error: {0}")]
    Embedding(String),

    /// SQLite / pool error. Bubbles up from `crate::store`.
    #[error("store: {0}")]
    Store(#[from] crate::store::error::StoreError),

    /// File extension is not in the supported set. Currently silenced
    /// at the call site (we just skip the file) — present so we can
    /// surface via metrics later if needed.
    #[error("unsupported language for {0}")]
    UnsupportedLanguage(String),

    /// fastembed could not download / load the MiniLM model. Common
    /// when offline on first launch.
    #[error("model load failed: {0}")]
    ModelLoad(String),

    /// Plain I/O failure (read source file, etc.).
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, IndexerError>;
