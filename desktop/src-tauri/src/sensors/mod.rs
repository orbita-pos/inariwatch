//! Input streams: fs, mcp, shell, git, substrate. Filled in by Sessions 5-10.
//!
//! Session 5 ships `fs` (notify-debouncer-mini watcher + per-repo walker).
//! Session 7 ships `mcp` (local JSON-RPC server over HTTP + stdio sidecar).

pub mod fs;
pub mod mcp;
