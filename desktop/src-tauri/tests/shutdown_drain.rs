//! Lifecycle: subscribers see `Shutdown` within the grace window.

use std::sync::Arc;

use tokio::sync::Notify;

use inariwatch_desktop_lib::daemon::{
    lifecycle::{run, SHUTDOWN_GRACE},
    DaemonEvent, EventBus, SharedDaemonState,
};

#[tokio::test(start_paused = true)]
async fn subscribers_observe_shutdown_before_grace_expires() {
    let bus      = EventBus::new();
    let state    = SharedDaemonState::new();
    let shutdown = Arc::new(Notify::new());

    let rx_a = bus.subscribe();
    let rx_b = bus.subscribe();
    let rx_c = bus.subscribe();

    let bus_for_task      = bus.clone();
    let state_for_task    = state.clone();
    let shutdown_for_task = shutdown.clone();
    let task = tokio::spawn(async move {
        run(bus_for_task, state_for_task, shutdown_for_task).await;
    });

    // Let the loop reach its tokio::select.
    tokio::task::yield_now().await;

    // Trigger shutdown — Shutdown is published before the grace sleep.
    shutdown.notify_waiters();

    // All three subscribers must see Shutdown within the grace window.
    for rx in [&rx_a, &rx_b, &rx_c] {
        let ev = tokio::time::timeout(SHUTDOWN_GRACE, async {
            loop {
                if let Ok(ev) = rx.try_recv() {
                    return ev;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("subscriber should see Shutdown within grace");
        assert!(
            matches!(ev, DaemonEvent::Shutdown),
            "expected Shutdown, got {ev:?}"
        );
    }

    // Drain the task. tokio's paused-time auto-advance wakes the
    // SHUTDOWN_GRACE sleep when no other progress is possible.
    let _ = task.await;
}
