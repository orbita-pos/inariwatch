//! S7 — Ambient surfaces support: OS notification toasts, tray quick
//! actions, and right-click menus all dispatch through this module.
//!
//! Three pieces:
//!
//! 1. [`AlertSnapshot`] — frozen alert payload that ambient surfaces
//!    can act on. Populated by [`LastAlertStore::set`] when an alert
//!    arrives; tray "Quick Actions → Fix Last Alert" reads it.
//! 2. [`AmbientAction`] — tagged enum of the four ambient action ids
//!    we wire through the OS notification action callback. Maps to
//!    direct `ToolRegistry` calls (Open in Editor) or `chat:prefill`
//!    Tauri events (Fix / Investigate) or audit-log dismissals
//!    (Ignore).
//! 3. [`handle_ambient_action`] — single dispatcher that turns an
//!    [`AmbientAction`] into the right side effect. Unit-tested
//!    against an injected dependency vector so no Tauri runtime is
//!    required.
//!
//! NOT a full notification bus. The agent-plan S10 OS-side delivered
//! a coalescer + dedupe + tray badge in a parallel worktree that has
//! not been merged into `feat/inari-live-integration-s1-s11`. When it
//! lands, this module's [`LastAlertStore`] should be populated by the
//! bus's "alert delivered" hook; until then, callers populate the
//! store directly when they call [`show_alert_toast`].

pub mod actions;
pub mod alert;
pub mod last_alert;
pub mod stacktrace;

pub use actions::{
    handle_ambient_action, show_alert_toast, AmbientAction, AmbientActionDeps, AmbientError,
    PrefillPayload,
};
pub use alert::AlertSnapshot;
pub use last_alert::LastAlertStore;
pub use stacktrace::first_location;

/// Tauri event name for "the chat surface should stuff this text into
/// the input box and focus it". Listened to by the dock window's chat
/// store on mount.
pub const EVT_CHAT_PREFILL: &str = "chat:prefill";

/// `session_id` tag we stamp on every audit row that originated from a
/// tray menu click.
pub const AMBIENT_SESSION_TRAY: &str = "ambient-tray";
/// `session_id` tag for OS notification toast action clicks.
pub const AMBIENT_SESSION_TOAST: &str = "ambient-toast";
/// `session_id` tag for the in-app right-click context menu.
pub const AMBIENT_SESSION_CONTEXT: &str = "ambient-context";
/// `session_id` tag for the hover tooltip "Open in Editor" button.
pub const AMBIENT_SESSION_HOVER: &str = "ambient-hover";
