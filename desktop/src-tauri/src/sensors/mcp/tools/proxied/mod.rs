//! Cloud-proxied tools. None of these have local implementations
//! today — each is represented by a `Stub` that returns a structured
//! `not_yet_wired` response so MCP clients render a clear message
//! rather than a generic failure.
//!
//! When a future session ships the real implementation, replace the
//! corresponding `Box::new(stub::Stub { ... })` in `tools::registry()`
//! with a fresh struct that implements `Tool`.

pub mod stub;
