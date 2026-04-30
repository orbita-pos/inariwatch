//! Input streams: fs, mcp, shell, git, substrate. Filled in by Sessions 5-10.
//!
//! Session 5 ships `fs` (notify-debouncer-mini watcher + per-repo walker).
//! Session 7 ships `mcp` (local JSON-RPC server over HTTP + stdio sidecar).
//! Session 8 ships `git` (opt-in hooks + pre-push gate plumbing); the HTTP
//! handler is mounted onto the MCP listener via `axum::Router::merge`.

pub mod fs;
pub mod git;
pub mod mcp;
