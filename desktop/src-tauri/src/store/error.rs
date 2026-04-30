//! Error type returned by `store::*` operations.
//!
//! All variants flow up through `Store::open` (init + migrations) and
//! pool-acquire paths. The variants are kept narrow on purpose: callers
//! typically only need to know "is this fatal at startup" vs "is this a
//! transient pool error" — finer details live in the wrapped source.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("pool: {0}")]
    Pool(#[from] r2d2::Error),

    #[error("migration {version} ({name}): {source}")]
    Migration {
        version: u32,
        name:    &'static str,
        #[source]
        source:  rusqlite::Error,
    },

    #[error("sqlite-vec extension load failed: {0}")]
    ExtensionLoad(String),

    #[error("could not resolve store path: {0}")]
    PathResolution(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;
