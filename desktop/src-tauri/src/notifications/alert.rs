//! Frozen alert payload used by ambient surfaces.
//!
//! Modeled after `cloud-alerts-update` SSE rows but kept deliberately
//! lean — only the fields the ambient surfaces (`tray::handlers`,
//! `notifications::actions`) need to compose a toast or open the
//! latest stacktrace in the editor.

use serde::{Deserialize, Serialize};

/// Snapshot of one alert as it lives in the user's session memory.
///
/// `stacktrace` is the raw text the originating Sentry/Vercel/etc
/// payload carried — `first_location` parses it on demand when the
/// tray's "Open Latest Stacktrace in Editor" item runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertSnapshot {
    /// Stable id for the alert in the upstream system. Echoed into
    /// `chat:prefill` payloads so the dock can attach the alert as
    /// chat context once the user types something.
    pub id: String,
    /// Human-readable title — first line of the OS toast.
    pub title: String,
    /// Body / details — everything below the title in the toast and
    /// the prefilled prompt sent to the chat.
    pub body: String,
    /// Raw stacktrace text. Empty string when the alert carries no
    /// stack (uptime checks, deploy failures, …).
    #[serde(default)]
    pub stacktrace: String,
}

impl AlertSnapshot {
    /// Convenience constructor used by tests + the (eventual) bus
    /// adapter. Validates nothing — empty strings are legal everywhere
    /// because the upstream alert sources sometimes truly have no
    /// title or body (we surface them as-is rather than dropping).
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        body: impl Into<String>,
        stacktrace: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            body: body.into(),
            stacktrace: stacktrace.into(),
        }
    }
}
