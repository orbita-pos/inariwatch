//! Daemon lifecycle: heartbeat loop + cooperative shutdown drain.
//!
//! Owns one tokio task that emits a `Heartbeat` every [`HEARTBEAT_INTERVAL`]
//! and updates [`SharedDaemonState::uptime`]. When [`DaemonHandle::shutdown`]
//! is signalled, publishes `DaemonEvent::Shutdown` on the bus and waits up
//! to [`SHUTDOWN_GRACE`] for sensors to drain — sensors observe the event
//! via `EventBus::subscribe`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::async_runtime::JoinHandle;
use tokio::sync::Notify;

use super::bus::EventBus;
use super::state::SharedDaemonState;
use super::DaemonEvent;

/// Heartbeat cadence. Sensors that need a periodic tick subscribe to the
/// bus and react to `DaemonEvent::Heartbeat`.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Maximum wait after `Shutdown` for sensors to drain. Anything taking
/// longer is force-aborted by tokio runtime drop.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Handle returned by [`start_daemon`]. Holding it keeps the daemon
/// running; calling [`DaemonHandle::shutdown`] then awaiting [`join`]
/// drains gracefully.
pub struct DaemonHandle {
    pub bus:      EventBus,
    pub state:    SharedDaemonState,
    shutdown:     Arc<Notify>,
    join_handle:  Option<JoinHandle<()>>,
}

impl DaemonHandle {
    /// Signal cooperative shutdown. Idempotent.
    pub fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }

    /// Wait for the daemon task to finish. Returns immediately if
    /// already joined. Use after [`shutdown`] to ensure drain.
    pub async fn join(&mut self) {
        if let Some(h) = self.join_handle.take() {
            let _ = h.await;
        }
    }
}

/// Spawn the daemon task on the current tokio runtime. Returns a
/// [`DaemonHandle`] the caller stores in tauri State.
pub fn start_daemon() -> DaemonHandle {
    let bus       = EventBus::new();
    let state     = SharedDaemonState::new();
    let shutdown  = Arc::new(Notify::new());

    let bus_for_task      = bus.clone();
    let state_for_task    = state.clone();
    let shutdown_for_task = shutdown.clone();

    let join_handle = tauri::async_runtime::spawn(async move {
        run(bus_for_task, state_for_task, shutdown_for_task).await;
    });

    DaemonHandle {
        bus,
        state,
        shutdown,
        join_handle: Some(join_handle),
    }
}

/// The daemon loop. Public so integration tests can drive it directly
/// under `#[tokio::test(start_paused = true)]` without going through
/// the `tauri::async_runtime` spawner (which may use a different
/// runtime instance than the test).
pub async fn run(bus: EventBus, state: SharedDaemonState, shutdown: Arc<Notify>) {
    tracing::info!(
        heartbeat_interval_secs = HEARTBEAT_INTERVAL.as_secs(),
        "daemon started"
    );

    let started_at  = Instant::now();
    let mut ticker  = tokio::time::interval(HEARTBEAT_INTERVAL);
    // First tick fires immediately; we want the first heartbeat after
    // one full interval so the dashboard doesn't see uptime=0.
    ticker.tick().await;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let uptime = started_at.elapsed();
                state.set_uptime(uptime);
                bus.publish(DaemonEvent::Heartbeat {
                    uptime_secs: uptime.as_secs(),
                });
                tracing::debug!(
                    uptime_secs = uptime.as_secs(),
                    subscribers = bus.subscriber_count(),
                    "heartbeat"
                );
            }
            _ = shutdown.notified() => {
                tracing::info!("daemon shutdown signalled — draining");
                bus.publish(DaemonEvent::Shutdown);
                // Give sensors up to SHUTDOWN_GRACE to react. We sleep
                // here because the bus is fire-and-forget; sensors that
                // need to flush state will have done so by the time
                // this returns. Real drain coordination (waiting on a
                // CountdownLatch of subscribers) lands when the first
                // sensor that needs it ships in Tracks 2-5.
                tokio::time::sleep(SHUTDOWN_GRACE).await;
                tracing::info!("daemon shutdown complete");
                return;
            }
        }
    }
}
