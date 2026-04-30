//! Git sensor errors. Mapped to HTTP responses by the route handlers
//! and to `IpcError` by the Tauri command shells.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitSensorError {
    #[error("repo not registered: {0}")]
    RepoNotFound(String),

    #[error("path is not inside a git repository: {0}")]
    NotAGitRepo(PathBuf),

    #[error("hook backup conflict: {0}")]
    BackupConflict(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("internal: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, GitSensorError>;
