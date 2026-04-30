//! Typed IPC error returned to the webview.
//!
//! Discriminates the most-actionable [`crate::store::StoreError`]
//! variants so the dock can show specific copy ("Database is from a
//! newer build of Inari Live — please update.") instead of an opaque
//! string. Other variants collapse into [`IpcError::Internal`].
//!
//! `serde(tag = "kind")` so the JSON shape on the wire is
//! `{"kind": "migration", "version": 3, "name": "memory", "message": "..."}`
//! and the TS binding ts-rs generates is a tagged union.

use std::path::PathBuf;

use serde::Serialize;
use thiserror::Error;
use ts_rs::TS;

use crate::store::error::StoreError;

#[derive(Debug, Clone, Serialize, Error, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/types/")]
pub enum IpcError {
    /// A SQLite migration failed mid-way. Typically signals "DB is from
    /// a newer build than this client". The dock can suggest an update.
    #[error("migration {version} ({name}) failed: {message}")]
    Migration {
        version: u32,
        name:    String,
        message: String,
    },

    /// Could not establish or check out a connection from the pool.
    #[error("connection error: {message}")]
    Connection { message: String },

    /// sqlite-vec (or any LOAD EXTENSION) failed at startup.
    #[error("extension load failed: {message}")]
    ExtensionLoad { message: String },

    /// Plain I/O failure (filesystem, log dir, etc.).
    #[error("io error: {message}")]
    Io { message: String },

    /// Generic SQL query failure that doesn't deserve its own variant.
    #[error("query error: {message}")]
    Query { message: String },

    /// Caller passed a non-existent or invalid path.
    #[error("invalid path: {path}: {reason}")]
    InvalidPath { path: String, reason: String },

    /// Repo id not found. Pure not-found, not an authorization issue.
    #[error("repo not found: {id}")]
    RepoNotFound { id: String },

    /// Catch-all for the variants we don't want to expose as discrete
    /// failure modes. The `message` is logged at WARN on the Rust side
    /// before being returned so we can find the root cause.
    #[error("internal: {message}")]
    Internal { message: String },
}

impl IpcError {
    pub fn invalid_path(path: impl Into<PathBuf>, reason: impl Into<String>) -> Self {
        Self::InvalidPath {
            path: path.into().display().to_string(),
            reason: reason.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal { message: message.into() }
    }
}

impl From<StoreError> for IpcError {
    fn from(err: StoreError) -> Self {
        // Discriminate on the variants the dock cares about; everything
        // else collapses to Internal so we don't leak SQLite verbiage.
        match err {
            StoreError::Migration { version, name, source } => IpcError::Migration {
                version,
                name: name.to_string(),
                message: source.to_string(),
            },
            StoreError::Pool(e) => IpcError::Connection { message: e.to_string() },
            StoreError::ExtensionLoad(msg) => IpcError::ExtensionLoad { message: msg },
            StoreError::Io(e) => IpcError::Io { message: e.to_string() },
            StoreError::Sqlite(e) => IpcError::Query { message: e.to_string() },
            StoreError::PathResolution(msg) => IpcError::Internal { message: msg },
            StoreError::Internal(msg) => IpcError::Internal { message: msg },
        }
    }
}

impl From<std::io::Error> for IpcError {
    fn from(err: std::io::Error) -> Self {
        IpcError::Io { message: err.to_string() }
    }
}
