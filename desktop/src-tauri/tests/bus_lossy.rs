//! `EventBus`: producer never blocks; full subscriber queues drop oldest.

use std::time::{Duration, Instant};

use inariwatch_desktop_lib::daemon::{
    bus::BUS_CAPACITY,
    DaemonEvent, EventBus,
};

#[test]
fn producer_never_blocks_when_subscriber_is_full() {
    let bus = EventBus::new();
    // We deliberately don't drain rx — its queue WILL fill up.
    let rx = bus.subscribe();

    // Publish capacity + 1000 extra events; the producer must remain
    // wait-free. A 2-second budget is generous given ~5k publishes
    // are O(allocation). If this exceeds 2s the producer is blocking.
    let total = BUS_CAPACITY + 1000;
    let started = Instant::now();
    for i in 0..total {
        bus.publish(DaemonEvent::Heartbeat { uptime_secs: i as u64 });
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "producer blocked: {elapsed:?} for {total} events (cap {BUS_CAPACITY})"
    );

    // The subscriber's queue must be capped at BUS_CAPACITY — overflow
    // events were dropped (drop-oldest), not silently buffered.
    assert_eq!(rx.len(), BUS_CAPACITY, "queue grew past capacity");

    // Drop-oldest semantics: the FIRST 1000 events were dropped, so
    // the OLDEST event still in the queue is uptime_secs == 1000.
    match rx.try_recv().expect("queue is non-empty") {
        DaemonEvent::Heartbeat { uptime_secs } => assert_eq!(
            uptime_secs, 1000,
            "expected oldest survivor uptime_secs=1000 (drop-oldest)",
        ),
        other => panic!("expected Heartbeat, got {other:?}"),
    }
}
