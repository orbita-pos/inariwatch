//! Input streams: fs, mcp, shell, git, substrate. Filled in by Sessions 5-10.
//!
//! Session 7 ships `mcp` (local JSON-RPC server over HTTP + stdio
//! sidecar). Session 5 ships `fs` on a parallel branch — when both
//! merge, `mod fs;` lands here too.

pub mod mcp;
