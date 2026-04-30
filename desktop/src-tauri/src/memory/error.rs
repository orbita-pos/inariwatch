//! Errors raised by the declarative memory layer (Session 11).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("store: {0}")]
    Store(#[from] crate::store::error::StoreError),

    #[error("parse: {0}")]
    Parse(String),

    #[error("pinned section cannot be modified by AI: {0}")]
    PinnedProtected(String),

    #[error("memory.md changed on disk since the proposed update was generated")]
    ConcurrentWrite,

    #[error("memory.md exceeds 1MB cap (got {0} bytes)")]
    TooLarge(u64),

    #[error("repo {0} not registered")]
    UnknownRepo(String),

    #[error("internal: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, MemoryError>;
