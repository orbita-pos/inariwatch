//! Slack channel — read-only mirror for S8.
//!
//! Same scope cut as [`super::telegram`]: web bot owns the AI loop,
//! desktop mirrors threads in the dock with attribution chips. S8.5
//! flips this into bidirectional.

pub mod adapter;
pub mod inbound;

pub use adapter::SlackChannel;
