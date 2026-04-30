//! Sensor 2 — opt-in shell hooks (Session 9).
//!
//! Reads commands the user runs in their interactive shell (`zsh` /
//! `bash` / `fish`) by sourcing a hook script that POSTs `{cmd, cwd,
//! exit_code, duration_ms, timestamp}` over a per-platform local socket
//! every time `precmd` (or its shell-specific equivalent) fires. The
//! daemon publishes one [`crate::daemon::DaemonEvent::ShellEvent`] per
//! parsed message and persists a `shell_event` row into the `events`
//! table for downstream consumers (memory layer, analytics).
//!
//! Privacy SSOT: the hook script SCRUBS env-var-shaped secrets BEFORE
//! sending. The Rust [`installer::scrub_secrets`] helper is the
//! canonical regex (kept testable in pure Rust); the shipped shell
//! templates implement an equivalent regex per shell. See
//! `desktop/src-tauri/resources/shell/README.md` for the full pattern
//! list users can audit + the threat model.
//!
//! Lifecycle:
//!   * [`spawn`] increments `sensor_count`, opens the platform listener
//!     (Unix socket / Windows named pipe), and accepts connections in a
//!     tokio task. Each accepted connection gets its own server-issued
//!     `session_id` (UUID v4) + a per-session token-bucket rate limit
//!     so a runaway loop in one shell can't flood the daemon.
//!   * Listener bind failure is logged at `warn` and decrements the
//!     sensor count without aborting — same precedent as the MCP
//!     transport's bind fallback (Session 7) and the FS sensor's
//!     inotify-limit recovery (Session 5).
//!   * On `DaemonEvent::Shutdown`, the listener task exits and the
//!     accept loop drops outstanding connections.
//!
//! Ports of this module add a [`socket::spawn_at_name`] helper that
//! takes an explicit socket name so integration tests bind under a
//! tempdir without touching the user's `~/.inari/sock/`.

pub mod installer;
pub mod socket;

pub use installer::{
    install,
    scrub_secrets,
    uninstall,
    InstallOutcome,
    ShellKind,
    UninstallOutcome,
    INARI_MARKER,
    SHELL_HOOKS_DIR,
};
pub use socket::{spawn, spawn_at_name, SocketName, SHELL_SENSOR_NAME};
