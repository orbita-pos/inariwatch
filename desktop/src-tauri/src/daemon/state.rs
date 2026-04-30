//! Daemon-wide read state. Heartbeats refresh `uptime`; sensors increment
//! `sensor_count` / `repo_count` as they spawn. IPC commands (Session 4)
//! return `DaemonStatus` snapshots to the webview.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Snapshot returned to the webview / IPC. Shape is part of the public
/// IPC contract — Session 4 adds it to the typed wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub uptime_secs:  u64,
    pub sensor_count: u32,
    pub repo_count:   u32,
}

struct Inner {
    started_at:   Instant,
    uptime:       Duration,
    sensor_count: u32,
    repo_count:   u32,
}

/// Cloneable handle to the shared daemon state. Reads are cheap; writes
/// are infrequent (heartbeat once per 30s + sensor lifecycle events).
#[derive(Clone)]
pub struct SharedDaemonState {
    inner: Arc<RwLock<Inner>>,
}

impl SharedDaemonState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Inner {
                started_at:   Instant::now(),
                uptime:       Duration::ZERO,
                sensor_count: 0,
                repo_count:   0,
            })),
        }
    }

    pub fn set_uptime(&self, dur: Duration) {
        self.write().uptime = dur;
    }

    pub fn inc_sensors(&self) {
        self.write().sensor_count += 1;
    }

    pub fn dec_sensors(&self) {
        let mut g = self.write();
        g.sensor_count = g.sensor_count.saturating_sub(1);
    }

    pub fn inc_repos(&self) {
        self.write().repo_count += 1;
    }

    pub fn dec_repos(&self) {
        let mut g = self.write();
        g.repo_count = g.repo_count.saturating_sub(1);
    }

    /// Snapshot the current state for IPC / status display.
    pub fn snapshot(&self) -> DaemonStatus {
        let g = self.read();
        DaemonStatus {
            uptime_secs:  g.uptime.as_secs(),
            sensor_count: g.sensor_count,
            repo_count:   g.repo_count,
        }
    }

    /// Wall-clock instant the daemon started. Heartbeat writers don't
    /// touch this — useful for callers that want fresher uptime than
    /// the last-set value.
    pub fn started_at(&self) -> Instant {
        self.read().started_at
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().expect("DaemonState rwlock poisoned")
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().expect("DaemonState rwlock poisoned")
    }
}

impl Default for SharedDaemonState {
    fn default() -> Self {
        Self::new()
    }
}
