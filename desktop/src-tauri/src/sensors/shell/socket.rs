//! Listener + per-connection task for Sensor 2 (Session 9).
//!
//! Cross-platform via the `interprocess` crate's `LocalSocket*` API:
//! Unix domain sockets on Linux/macOS, Windows named pipes on Windows.
//! No `#[cfg]` branching at the call site — the [`SocketName`] enum
//! captures the per-platform default and tests inject ephemeral names
//! via [`SocketName::from_path`] / [`SocketName::from_namespaced`].
//!
//! Wire protocol: line-delimited JSON. Each shell hook fires one line
//! of the form
//!
//! ```json
//! {"cmd":"ls /tmp","cwd":"/tmp","exit_code":0,"duration_ms":5,"timestamp":1234567890123}
//! ```
//!
//! `session_id` is server-assigned per accepted connection (UUID v4)
//! so a malicious or buggy client can't spoof another shell's group.
//! `timestamp` is treated as advisory: a `0` value falls back to the
//! daemon's wall clock.
//!
//! Rate limit: a sliding-window 10-events-per-1s allowlist is enforced
//! per connection. Excess events are dropped with a `tracing::warn!`
//! line and the connection stays open — we never block the user's
//! shell.
//!
//! Persistence: every accepted event is also written to the `events`
//! table via [`crate::store::queries::insert_event`] with `kind =
//! "shell_event"`. The bus publish is the SSOT; persistence failure
//! is logged but does not break the connection.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use interprocess::local_socket::tokio::{prelude::*, Stream};
use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, ListenerOptions, ToFsName, ToNsName,
};
use serde::Deserialize;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;

use crate::daemon::{DaemonEvent, DaemonHandle, EventBus};
use crate::store::{queries, Store};

/// Sensor name surfaced in `tracing::*` events and (eventually) in
/// `SensorWarning`. Single source of truth so the installer + tests
/// can match on it.
pub const SHELL_SENSOR_NAME: &str = "shell";

/// Per-connection burst capacity (= max events accepted in any
/// [`RATE_LIMIT_WINDOW_MS`] window). 10 covers normal interactive
/// pacing with headroom; a `for i in {1..1000}; do echo $i; done`
/// style flood is dropped past the 10th event without disconnecting
/// the shell.
const RATE_LIMIT_BURST: usize = 10;
/// Sliding-window length in milliseconds for the per-connection rate
/// limiter. 1 second pairs with [`RATE_LIMIT_BURST`] = 10 to give the
/// 10 events/sec cap from the spec.
const RATE_LIMIT_WINDOW_MS: u64 = 1000;

/// Maximum size of a single accepted JSON line. Defends the daemon
/// against a runaway shell that tries to dump multi-MB env into the
/// `cmd` field. 64 KB is generous compared to any realistic command.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// Platform-agnostic local socket name. The default platform value is
/// `~/.inari/sock/shell.sock` on Unix and the `inari-live-shell`
/// namespaced name on Windows (which `interprocess` translates to
/// `\\.\pipe\inari-live-shell`).
#[derive(Clone, Debug)]
pub struct SocketName {
    inner: SocketNameKind,
}

#[derive(Clone, Debug)]
enum SocketNameKind {
    /// Filesystem-path-typed name. The parent directory is created at
    /// bind time. Works on Unix (and on Windows for the limited
    /// path-pipe form, but we don't use that path on Windows).
    FsPath(PathBuf),
    /// Namespaced name, used on Windows. The actual on-wire string
    /// becomes `\\.\pipe\<name>` after `interprocess` translation.
    Namespaced(String),
}

impl SocketName {
    /// Resolve the platform default. Fails if `$HOME` /
    /// `%USERPROFILE%` is unset (no place to anchor the socket).
    pub fn default_for_platform() -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            let home = super::installer::resolve_home()?;
            let path = home.join(".inari").join("sock").join("shell.sock");
            return Ok(Self { inner: SocketNameKind::FsPath(path) });
        }
        #[cfg(windows)]
        {
            return Ok(Self {
                inner: SocketNameKind::Namespaced("inari-live-shell".to_string()),
            });
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "unsupported platform",
            ))
        }
    }

    /// Construct from a filesystem path (Unix-style). Tests use this
    /// to put the socket inside a `tempfile::TempDir`.
    pub fn from_path(p: PathBuf) -> Self {
        Self { inner: SocketNameKind::FsPath(p) }
    }

    /// Construct from a namespaced name (Windows-style). Tests use a
    /// per-test unique name to avoid collisions when run concurrently.
    pub fn from_namespaced(name: impl Into<String>) -> Self {
        Self { inner: SocketNameKind::Namespaced(name.into()) }
    }

    /// Filesystem path the socket file lives at, when applicable. Used
    /// by tests + the installer when documenting the path to users.
    pub fn fs_path(&self) -> Option<&std::path::Path> {
        match &self.inner {
            SocketNameKind::FsPath(p)     => Some(p.as_path()),
            SocketNameKind::Namespaced(_) => None,
        }
    }

    /// Connect a tokio [`Stream`] client to this socket. Public for
    /// tests + future programmatic IPC; production code never calls
    /// this (the listener side is the daemon, the client side is the
    /// shell hook script which uses the platform `socket(2)` directly).
    pub async fn connect(&self) -> std::io::Result<Stream> {
        match &self.inner {
            SocketNameKind::FsPath(p) => {
                let name = p.as_path().to_fs_name::<GenericFilePath>()?.into_owned();
                Stream::connect(name).await
            }
            SocketNameKind::Namespaced(s) => {
                let name = s.as_str().to_ns_name::<GenericNamespaced>()?.into_owned();
                Stream::connect(name).await
            }
        }
    }

    fn build_listener(&self) -> std::io::Result<interprocess::local_socket::tokio::Listener> {
        match &self.inner {
            SocketNameKind::FsPath(p) => {
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let name = p.as_path().to_fs_name::<GenericFilePath>()?.into_owned();
                ListenerOptions::new()
                    .name(name)
                    .try_overwrite(true)
                    .create_tokio()
            }
            SocketNameKind::Namespaced(s) => {
                let name = s.as_str().to_ns_name::<GenericNamespaced>()?.into_owned();
                ListenerOptions::new().name(name).create_tokio()
            }
        }
    }
}

/// On-wire payload sent by the shell hook script. Field defaults
/// preserve forward compatibility (a future hook version that omits
/// `duration_ms` won't break the daemon).
#[derive(Debug, Deserialize)]
struct ShellMessage {
    cmd: String,
    #[serde(default)]
    cwd: PathBuf,
    #[serde(default)]
    exit_code: i32,
    #[serde(default)]
    duration_ms: u64,
    #[serde(default)]
    timestamp: u64,
}

/// Spawn the shell sensor on the platform default socket. Bind
/// failures (permission denied / `AddrInUse` after `try_overwrite`
/// also failed / unsupported FS namespace) are logged at `warn` and
/// the sensor count is decremented — same precedent as the FS sensor's
/// inotify-limit recovery (Session 5) and the MCP transport's bind
/// fallback (Session 7).
pub fn spawn(daemon: Arc<DaemonHandle>, store: Arc<Store>) -> JoinHandle<()> {
    let name = match SocketName::default_for_platform() {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(
                sensor = SHELL_SENSOR_NAME,
                error  = %e,
                "shell sensor socket name unresolved — sensor disabled",
            );
            return tauri::async_runtime::spawn(async {});
        }
    };
    spawn_at_name(name, daemon, store)
}

/// Spawn the shell sensor on a custom socket name. Public for tests
/// that bind under a tempdir (Unix) or a per-test namespaced name
/// (Windows). Production code calls [`spawn`].
pub fn spawn_at_name(
    name:   SocketName,
    daemon: Arc<DaemonHandle>,
    store:  Arc<Store>,
) -> JoinHandle<()> {
    daemon.state.inc_sensors();
    let bus_for_task   = daemon.bus.clone();
    let state_for_task = daemon.state.clone();

    tauri::async_runtime::spawn(async move {
        let listener = match name.build_listener() {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(
                    sensor = SHELL_SENSOR_NAME,
                    error  = %e,
                    "shell socket bind failed — sensor disabled",
                );
                state_for_task.dec_sensors();
                return;
            }
        };

        tracing::info!(sensor = SHELL_SENSOR_NAME, "shell sensor listening");
        let bus_rx = bus_for_task.subscribe();

        loop {
            tokio::select! {
                ev = bus_rx.recv_async() => {
                    match ev {
                        Ok(DaemonEvent::Shutdown) => {
                            tracing::info!(sensor = SHELL_SENSOR_NAME, "shutdown observed");
                            break;
                        }
                        Ok(_)  => continue,
                        Err(_) => break,
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok(stream) => {
                            let bus_clone   = bus_for_task.clone();
                            let store_clone = store.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, bus_clone, store_clone).await {
                                    tracing::warn!(
                                        sensor = SHELL_SENSOR_NAME,
                                        error  = %e,
                                        "connection closed with error",
                                    );
                                }
                            });
                        }
                        Err(e) => {
                            tracing::warn!(
                                sensor = SHELL_SENSOR_NAME,
                                error  = %e,
                                "accept failed",
                            );
                        }
                    }
                }
            }
        }

        state_for_task.dec_sensors();
        tracing::info!(sensor = SHELL_SENSOR_NAME, "shell sensor stopped");
    })
}

async fn handle_connection(
    stream: Stream,
    bus:    EventBus,
    store:  Arc<Store>,
) -> std::io::Result<()> {
    let session_id  = Uuid::new_v4().to_string();
    let mut reader  = BufReader::new(stream);
    let mut buf     = String::with_capacity(256);
    let mut limiter = RateLimiter::new();

    loop {
        buf.clear();
        let n = reader.read_line(&mut buf).await?;
        if n == 0 {
            // EOF — client closed cleanly.
            return Ok(());
        }
        if n > MAX_LINE_BYTES {
            tracing::warn!(
                sensor = SHELL_SENSOR_NAME,
                bytes  = n,
                "dropped oversized shell message",
            );
            continue;
        }

        let trimmed = buf.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }

        let msg: ShellMessage = match serde_json::from_str(trimmed) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    sensor = SHELL_SENSOR_NAME,
                    error  = %e,
                    "invalid shell hook payload — dropping",
                );
                continue;
            }
        };

        if !limiter.allow() {
            tracing::warn!(
                sensor  = SHELL_SENSOR_NAME,
                session = %session_id,
                "shell rate limit exceeded — dropping event",
            );
            continue;
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let timestamp = if msg.timestamp == 0 { now_ms } else { msg.timestamp };

        let event = DaemonEvent::ShellEvent {
            session_id:  session_id.clone(),
            cmd:         msg.cmd.clone(),
            cwd:         msg.cwd.clone(),
            exit_code:   msg.exit_code,
            duration_ms: msg.duration_ms,
            timestamp,
        };
        bus.publish(event);

        // Persist (non-fatal). Bus is SSOT; the events row is for
        // analytics + the eventual TTL cleanup job.
        let payload = serde_json::json!({
            "session_id":  session_id,
            "cmd":         msg.cmd,
            "cwd":         msg.cwd.display().to_string(),
            "exit_code":   msg.exit_code,
            "duration_ms": msg.duration_ms,
            "timestamp":   timestamp,
        });
        if let Err(e) = queries::insert_event(
            &store,
            timestamp as i64,
            "shell_event",
            None,
            &payload.to_string(),
        ) {
            tracing::warn!(
                sensor = SHELL_SENSOR_NAME,
                error  = %e,
                "shell event persistence failed",
            );
        }
    }
}

/// Sliding-window rate limiter. Holds the timestamps of the last
/// [`RATE_LIMIT_BURST`] accepted events; on each call, evicts entries
/// older than [`RATE_LIMIT_WINDOW_MS`] before checking capacity.
struct RateLimiter {
    window: Vec<Instant>,
}

impl RateLimiter {
    fn new() -> Self {
        Self { window: Vec::with_capacity(RATE_LIMIT_BURST) }
    }

    fn allow(&mut self) -> bool {
        let now    = Instant::now();
        let cutoff = now.checked_sub(Duration::from_millis(RATE_LIMIT_WINDOW_MS));
        if let Some(c) = cutoff {
            self.window.retain(|t| *t >= c);
        }
        if self.window.len() >= RATE_LIMIT_BURST {
            return false;
        }
        self.window.push(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn rate_limiter_allows_burst_then_blocks() {
        let mut rl = RateLimiter::new();
        for _ in 0..RATE_LIMIT_BURST {
            assert!(rl.allow());
        }
        assert!(!rl.allow());
        // After the window passes, we recover.
        sleep(Duration::from_millis(RATE_LIMIT_WINDOW_MS + 50));
        assert!(rl.allow());
    }

    #[test]
    fn default_socket_name_resolves() {
        // Sanity: at least one of $HOME / %USERPROFILE% is set in any
        // CI environment we'd actually run on.
        let _ = SocketName::default_for_platform().expect("default socket name");
    }
}
