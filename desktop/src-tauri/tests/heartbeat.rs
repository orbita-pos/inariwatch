//! Lifecycle: 5 heartbeats fire across 150s of simulated time.
//!
//! Drives `daemon::lifecycle::run` directly under tokio's paused-time
//! test runtime, side-stepping the `tauri::async_runtime::spawn` path
//! the production daemon uses (which would couple us to a runtime
//! instance separate from the test's).

use std::sync::Arc;

use tokio::sync::Notify;

use inariwatch_desktop_lib::daemon::{
    lifecycle::{run, HEARTBEAT_INTERVAL},
    DaemonEvent, EventBus, SharedDaemonState,
};

#[tokio::test(start_paused = true)]
async fn five_heartbeats_in_150s() {
    let bus      = EventBus::new();
    let state    = SharedDaemonState::new();
    let shutdown = Arc::new(Notify::new());

    // Subscribe BEFORE starting the loop so we don't miss the first
    // tick. The loop awaits the first interval before publishing.
    let rx = bus.subscribe();

    let bus_for_task      = bus.clone();
    let state_for_task    = state.clone();
    let shutdown_for_task = shutdown.clone();
    let task = tokio::spawn(async move {
        run(bus_for_task, state_for_task, shutdown_for_task).await;
    });

    // Yield once so the spawned task is polled and reaches its first
    // `ticker.tick().await` (which consumes the immediate t=0 tick)
    // BEFORE we begin advancing time. Without this, time has already
    // moved past t=0 by the time the task initializes its ticker, and
    // the test sees one fewer heartbeat than expected.
    tokio::task::yield_now().await;

    // Advance simulated time 5 × HEARTBEAT_INTERVAL. Each advance
    // crosses one tick boundary, so we expect exactly 5 heartbeats.
    for _ in 0..5 {
        tokio::time::advance(HEARTBEAT_INTERVAL).await;
        tokio::task::yield_now().await;
    }

    let mut count = 0u32;
    while let Ok(ev) = rx.try_recv() {
        match ev {
            DaemonEvent::Heartbeat { .. } => count += 1,
            other => panic!("unexpected event: {other:?}"),
        }
    }
    assert_eq!(count, 5, "expected 5 heartbeats in 150s simulated time");

    // Drain the task. Shutdown publishes `Shutdown` then sleeps
    // SHUTDOWN_GRACE before returning; tokio's paused-time
    // auto-advance wakes the sleep when no other progress is
    // possible, so a plain `await` resolves cleanly.
    shutdown.notify_waiters();
    let _ = task.await;
}
