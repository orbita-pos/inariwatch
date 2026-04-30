//! Event bus — broadcast with drop-oldest lossy semantics.
//!
//! Multi-producer multi-consumer BROADCAST: every live subscriber sees
//! every published event (modulo drops). The producer is wait-free —
//! when a subscriber's per-subscriber queue is full, the OLDEST pending
//! event in that subscriber's queue is dropped to make room.
//!
//! Why a hand-rolled VecDeque + flume notifier instead of flume's mpmc
//! channel: flume Receiver clones COMPETE for events (mpmc semantics),
//! which is the wrong primitive for broadcast. tokio::sync::broadcast
//! has the right semantics but couples lifetime to a tokio runtime
//! (sensors that aren't async would need an extra adapter). The chosen
//! design — `Arc<Mutex<VecDeque>>` for the queue plus a tiny `flume`
//! notifier channel for wakeups — gives:
//!   * true broadcast (each subscriber owns its own queue),
//!   * drop-oldest at the producer with O(1) cost,
//!   * blocking + async receive support out of the box (flume),
//!   * no tokio dependency in the receive path.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use flume::{RecvError, RecvTimeoutError, TryRecvError};

use super::DaemonEvent;

/// Per-subscriber queue capacity. 4096 ≈ 30 minutes of heartbeats with
/// plenty of headroom for sensor bursts. Slow consumers lose oldest
/// events first; the producer is never blocked.
pub const BUS_CAPACITY: usize = 4096;

#[derive(Clone)]
struct Subscriber {
    queue:  Arc<Mutex<VecDeque<DaemonEvent>>>,
    /// Capacity-1 notifier. `try_send` coalesces duplicate wakeups —
    /// the receiver loops on `try_recv` so a single notification is
    /// enough to drain whatever has accumulated.
    notify: flume::Sender<()>,
}

/// Multi-producer multi-consumer broadcast bus.
///
/// Cloning shares the subscriber list. Subscribers unregister
/// implicitly: when their [`Receiver`] is dropped, the next publish
/// detects the closed notifier and prunes the entry.
#[derive(Clone)]
pub struct EventBus {
    subs: Arc<Mutex<Vec<Subscriber>>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            subs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Register a new subscriber. The returned [`Receiver`] only sees
    /// events published AFTER this call.
    pub fn subscribe(&self) -> Receiver {
        let queue            = Arc::new(Mutex::new(VecDeque::with_capacity(BUS_CAPACITY)));
        let (notify_tx, notify_rx) = flume::bounded::<()>(1);
        let mut subs         = self.subs.lock().expect("EventBus subs mutex poisoned");
        subs.push(Subscriber {
            queue:  queue.clone(),
            notify: notify_tx,
        });
        Receiver {
            queue,
            notify: notify_rx,
        }
    }

    /// Publish an event to all live subscribers. Wait-free.
    /// On a full subscriber queue, the oldest pending event in THAT
    /// subscriber's queue is dropped (other subscribers unaffected).
    pub fn publish(&self, event: DaemonEvent) {
        let mut subs = self.subs.lock().expect("EventBus subs mutex poisoned");
        subs.retain(|sub| {
            // Disconnected notifier ⇒ Receiver dropped ⇒ prune.
            if sub.notify.is_disconnected() {
                return false;
            }
            {
                let mut q = sub.queue.lock().expect("subscriber queue poisoned");
                if q.len() >= BUS_CAPACITY {
                    // Drop oldest. tracing::warn so we surface the
                    // pressure in logs without spamming (one line per
                    // dropped event is fine here — see lifecycle log
                    // sampling for higher-volume needs).
                    q.pop_front();
                    tracing::warn!(
                        capacity = BUS_CAPACITY,
                        "EventBus subscriber queue full — dropping oldest event"
                    );
                }
                q.push_back(event.clone());
            }
            // Best-effort wakeup; coalesced so a missed send is fine.
            let _ = sub.notify.try_send(());
            true
        });
    }

    /// Number of currently-registered subscribers (lazily pruned).
    pub fn subscriber_count(&self) -> usize {
        self.subs
            .lock()
            .expect("EventBus subs mutex poisoned")
            .len()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-subscriber receive handle. Drop to unsubscribe (next publish
/// prunes the entry). Both blocking and async receive are supported.
pub struct Receiver {
    queue:  Arc<Mutex<VecDeque<DaemonEvent>>>,
    notify: flume::Receiver<()>,
}

impl Receiver {
    /// Non-blocking pop. Returns `Empty` if no event is queued and the
    /// bus is still alive; `Disconnected` would only be returned if
    /// the bus itself were dropped (the `EventBus`'s `Arc<Mutex<Vec>>`
    /// holds the notifier txs, but the `Receiver` doesn't depend on
    /// the bus — so we treat the bus going away as Empty forever).
    pub fn try_recv(&self) -> Result<DaemonEvent, TryRecvError> {
        let mut q = self.queue.lock().expect("subscriber queue poisoned");
        q.pop_front().ok_or(TryRecvError::Empty)
    }

    /// Blocking receive. Sleeps the calling thread until an event is
    /// available. Returns [`RecvError`] if the bus has been dropped
    /// AND the queue is empty.
    pub fn recv(&self) -> Result<DaemonEvent, RecvError> {
        loop {
            if let Ok(ev) = self.try_recv() {
                return Ok(ev);
            }
            // notifier disconnected ⇒ bus dropped ⇒ no more events
            self.notify.recv()?;
        }
    }

    /// Async receive. Awaits until an event is available.
    pub async fn recv_async(&self) -> Result<DaemonEvent, RecvError> {
        loop {
            if let Ok(ev) = self.try_recv() {
                return Ok(ev);
            }
            self.notify.recv_async().await?;
        }
    }

    /// Blocking receive with timeout. Returns `Timeout` if no event
    /// arrives in `dur`.
    pub fn recv_timeout(
        &self,
        dur: std::time::Duration,
    ) -> Result<DaemonEvent, RecvTimeoutError> {
        if let Ok(ev) = self.try_recv() {
            return Ok(ev);
        }
        self.notify.recv_timeout(dur)?;
        // Notifier fired — pull (might be empty if another consumer of
        // this Receiver beat us, but that's not allowed since Receiver
        // is not Clone).
        self.try_recv().map_err(|_| RecvTimeoutError::Timeout)
    }

    /// Current depth of this subscriber's queue. Mainly for tests.
    pub fn len(&self) -> usize {
        self.queue
            .lock()
            .expect("subscriber queue poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
