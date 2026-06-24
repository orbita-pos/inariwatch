//! Input streams: fs, mcp, shell, git, substrate. Filled in by Sessions 5-10.
//!
//! Session 5 ships `fs` (notify-debouncer-mini watcher + per-repo walker).
//! Session 7 ships `mcp` (local JSON-RPC server over HTTP + stdio sidecar).
//! Session 8 ships `git` (opt-in hooks + pre-push gate plumbing); the HTTP
//! handler is mounted onto the MCP listener via `axum::Router::merge`.
//! Session 9 ships `shell` (opt-in zsh/bash/fish hooks over a per-platform
//! local socket — Unix domain socket / Windows named pipe — via `interprocess`).
//! Session 10 ships `substrate` (Replay-as-you-code correlation: subscribes
//! to `FsChange::Modified`, finds the recent recording, asks the
//! configured backend to replay, publishes `ReplayResult`).

pub mod fs;
pub mod git;
pub mod mcp;
pub mod shell;
pub mod substrate;
