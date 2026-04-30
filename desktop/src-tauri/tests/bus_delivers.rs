//! `EventBus`: every published event reaches every subscriber.

use std::time::Duration;

use inariwatch_desktop_lib::daemon::{DaemonEvent, EventBus};

#[test]
fn three_subscribers_receive_one_published_event() {
    let bus = EventBus::new();
    let rx_a = bus.subscribe();
    let rx_b = bus.subscribe();
    let rx_c = bus.subscribe();

    bus.publish(DaemonEvent::Heartbeat { uptime_secs: 1 });

    let recv = |rx: &inariwatch_desktop_lib::daemon::bus::Receiver| {
        rx.recv_timeout(Duration::from_millis(500))
            .expect("receiver should see the published event")
    };

    for ev in [recv(&rx_a), recv(&rx_b), recv(&rx_c)] {
        match ev {
            DaemonEvent::Heartbeat { uptime_secs } => assert_eq!(uptime_secs, 1),
            other => panic!("expected Heartbeat, got {other:?}"),
        }
    }
}

#[test]
fn dropped_subscriber_is_pruned_on_next_publish() {
    let bus = EventBus::new();
    let rx_a = bus.subscribe();
    let rx_b = bus.subscribe();
    assert_eq!(bus.subscriber_count(), 2);

    drop(rx_a);
    // Publish triggers the lazy prune.
    bus.publish(DaemonEvent::Heartbeat { uptime_secs: 0 });
    assert_eq!(bus.subscriber_count(), 1);

    // The remaining subscriber still works.
    let _ = rx_b
        .recv_timeout(Duration::from_millis(500))
        .expect("rx_b should still receive");
}
