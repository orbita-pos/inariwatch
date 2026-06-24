//! Re-export of [`crate::daemon::FsChangeKind`] so callers reading the
//! sensor module structure can find the type without crossing into
//! `daemon::*`.
//!
//! Why the canonical home is `daemon` rather than `sensors::fs`: the
//! IPC bridge (`ipc::events`) and future indexer (Session 6) need to
//! pattern-match on `FsChangeKind` without importing from sensor
//! internals. Putting it at the daemon layer keeps the cross-sensor
//! dependency direction one-way (sensors → daemon, never the reverse).

pub use crate::daemon::FsChangeKind;
