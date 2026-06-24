//! Session 11 — `get_context_stack` builds the precedence stack:
//! CLAUDE.md → AGENTS.md → .cursorrules → memory.md `[pinned]` →
//! memory.md rest → patterns → semantic.
//!
//! This test exercises the gather rules directly (the IPC command is a
//! thin wrapper that calls `gather_context` and DTO-maps the result).

use inariwatch_desktop_lib::memory::declarative::{
    ensure_memory_md, gather_context, ContextLayer,
};

#[test]
fn empty_repo_yields_empty_stack() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let stack = gather_context("any query", tmp.path(), None, None);
    assert!(stack.layers.is_empty(), "no layers when no inputs exist");
    assert_eq!(stack.total_bytes, 0);
    assert!(!stack.truncated);
}

#[test]
fn claude_md_present_emits_first_layer() {
    let tmp = tempfile::tempdir().expect("tempdir");
    std::fs::write(tmp.path().join("CLAUDE.md"), "# Claude rules\n\nuse rust\n")
        .expect("write CLAUDE.md");

    let stack = gather_context("q", tmp.path(), None, None);
    assert_eq!(stack.layers.len(), 1);
    match &stack.layers[0] {
        ContextLayer::ClaudeMd { content } => {
            assert!(content.contains("Claude rules"));
        }
        other => panic!("expected ClaudeMd first, got {other:?}"),
    }
}

#[test]
fn precedence_order_claude_then_agents_then_cursor() {
    let tmp = tempfile::tempdir().expect("tempdir");
    std::fs::write(tmp.path().join("CLAUDE.md"),    "claude").unwrap();
    std::fs::write(tmp.path().join("AGENTS.md"),    "agents").unwrap();
    std::fs::write(tmp.path().join(".cursorrules"), "cursor").unwrap();

    let stack = gather_context("q", tmp.path(), None, None);
    assert!(stack.layers.len() >= 3);
    assert!(matches!(stack.layers[0], ContextLayer::ClaudeMd    { .. }));
    assert!(matches!(stack.layers[1], ContextLayer::AgentsMd    { .. }));
    assert!(matches!(stack.layers[2], ContextLayer::CursorRules { .. }));
}

#[test]
fn memory_md_pinned_precedes_rest() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let outcome = ensure_memory_md(tmp.path()).expect("ensure_memory_md");

    let stack = gather_context("q", tmp.path(), Some(&outcome.doc), None);
    // The template ships with at least one [pinned] heading and one
    // unmarked heading, so we should see Pinned before Rest in layer
    // ordering (Pinned might be index 0 here since no CLAUDE.md exists).
    let pinned_idx = stack.layers.iter().position(|l| matches!(l, ContextLayer::MemoryPinned { .. }));
    let rest_idx   = stack.layers.iter().position(|l| matches!(l, ContextLayer::MemoryRest   { .. }));
    if let (Some(p), Some(r)) = (pinned_idx, rest_idx) {
        assert!(p < r, "MemoryPinned must come before MemoryRest");
    }
}
