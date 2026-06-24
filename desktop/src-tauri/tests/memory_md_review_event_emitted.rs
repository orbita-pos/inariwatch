//! Session 11 — proposing a `memory.md` update publishes a
//! `MemoryReviewRequested` event on the daemon bus, and approving
//! publishes `MemoryReviewApproved`.
//!
//! These two events are how the dock learns about pending reviews
//! without polling. We assert payload shape (`repo_id`, `kind`,
//! `content`) and that subscribers actually receive them.

use std::time::Duration;

use inariwatch_desktop_lib::daemon::{DaemonEvent, EventBus, MemoryKind};

#[test]
fn requested_event_carries_repo_id_and_kind() {
    let bus = EventBus::new();
    let rx  = bus.subscribe();

    bus.publish(DaemonEvent::MemoryReviewRequested {
        repo_id: "repo-xyz".to_string(),
        kind:    MemoryKind::Initial,
    });

    let ev = rx.recv_timeout(Duration::from_millis(500)).expect("event");
    match ev {
        DaemonEvent::MemoryReviewRequested { repo_id, kind } => {
            assert_eq!(repo_id, "repo-xyz");
            assert_eq!(kind, MemoryKind::Initial);
        }
        other => panic!("expected MemoryReviewRequested, got {other:?}"),
    }
}

#[test]
fn approved_event_carries_content() {
    let bus = EventBus::new();
    let rx  = bus.subscribe();

    bus.publish(DaemonEvent::MemoryReviewApproved {
        repo_id: "repo-abc".to_string(),
        content: "## approved\n\nbody\n".to_string(),
    });

    let ev = rx.recv_timeout(Duration::from_millis(500)).expect("event");
    match ev {
        DaemonEvent::MemoryReviewApproved { repo_id, content } => {
            assert_eq!(repo_id, "repo-abc");
            assert_eq!(content, "## approved\n\nbody\n");
        }
        other => panic!("expected MemoryReviewApproved, got {other:?}"),
    }
}

#[test]
fn memory_kind_serializes_with_review_kind_wire_field() {
    // The Rust field is `kind` per Session 11's spec, but the JSON wire
    // field is `review_kind` to dodge the outer enum's internally-tagged
    // `"kind"` discriminator. Lock the wire shape so a future serde
    // refactor can't silently break the dock.
    let ev = DaemonEvent::MemoryReviewRequested {
        repo_id: "r".into(),
        kind:    MemoryKind::Replace,
    };
    let json = serde_json::to_string(&ev).expect("serialize");
    assert!(json.contains("\"kind\":\"memory_review_requested\""));
    assert!(
        json.contains("\"review_kind\":\"replace\""),
        "wire field must be 'review_kind' (got: {json})"
    );
    assert!(json.contains("\"repo_id\":\"r\""));
}

#[test]
fn all_three_memory_kinds_serialize_snake_case() {
    for (kind, expected) in [
        (MemoryKind::Initial, "initial"),
        (MemoryKind::Append,  "append"),
        (MemoryKind::Replace, "replace"),
    ] {
        let json = serde_json::to_string(&kind).expect("serialize");
        assert_eq!(json, format!("\"{expected}\""), "kind {kind:?} wire mismatch");
    }
}
