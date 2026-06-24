//! S7 ambient action dispatcher.
//!
//! Three of the four `AmbientAction` variants emit a side effect via
//! a dependency injected at the boundary so tests can drive the full
//! pipeline without a Tauri runtime:
//!
//! | Variant         | Side effect                                   |
//! |-----------------|-----------------------------------------------|
//! | `OpenInEditor`  | `ToolRegistry::invoke_traced_confirmed`       |
//! | `FixWithAi`     | emit `chat:prefill` event (`text`, `alert_id`)|
//! | `Investigate`   | emit `chat:prefill` event (`text`, `alert_id`)|
//! | `Ignore`        | append `ambient.dismiss_alert` audit row      |
//!
//! `OpenInEditor` always uses `_confirmed` because the user clicking
//! a tray menu / toast button / context-menu item IS the consent. The
//! permission resolver still gates the call, so a `Deny` override on
//! `desktop.open_in_editor` returns `Err(AmbientError::Denied)` and
//! the caller surfaces a toast pointing at Settings → Permissions.
//!
//! `show_alert_toast` is the single entry point the eventual
//! notification bus will call. For S7 it serves two purposes:
//!
//! 1. Populates [`LastAlertStore`] so the tray's "Quick Actions"
//!    submenu has something to act on.
//! 2. Fires the `tauri-plugin-notification` toast with title+body.
//!    We deliberately ship WITHOUT inline action buttons in this
//!    session — those actions are accessible from the tray Quick
//!    Actions submenu (also S7) and the in-app right-click menu
//!    (also S7), both of which dispatch through the same
//!    [`handle_ambient_action`]. See the "Scope cuts" section in the
//!    S7 prompt for the rationale (cross-platform action paritary
//!    is brittle on Windows AppUserModelID + macOS notification
//!    center registration; the tray menu is byte-identical UX
//!    without the cross-OS wiring fragility).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::agent::{
    AuditEntry, AuditError, AuditLog, PermissionDecision, PermissionLevel, RegistryError,
    ToolRegistry,
};

use super::{AlertSnapshot, LastAlertStore};

/// Tagged ambient action. Emitted by ambient surfaces (toast button,
/// tray menu item, right-click context, hover tooltip button) and
/// resolved through [`handle_ambient_action`].
///
/// Wire-shape `kind` matches the Rust variant names in `snake_case`
/// so the eventual `tauri-plugin-notification` action ids round-trip
/// identically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AmbientAction {
    /// Open `file` at `line` (1-based) in the user's default editor.
    /// Direct `desktop.open_in_editor` tool call. `line` is `None`
    /// when no stacktrace was attached to the alert.
    OpenInEditor { file: String, line: Option<u32> },
    /// Open the chat with a "Fix this for me" prefilled prompt
    /// scoped to `alert_id`.
    FixWithAi { alert_id: String, prefill: String },
    /// Same as [`Self::FixWithAi`] but worded as an investigation
    /// rather than a directive — the chat surface treats them
    /// identically; the user-facing copy is the only difference.
    Investigate { alert_id: String, prefill: String },
    /// User dismissed the alert. We log the dismissal so the audit
    /// trail can show "user saw + ignored" vs "user never saw".
    Ignore { alert_id: String },
}

/// Wire shape of the `chat:prefill` event payload. The dock's chat
/// store listens for this on mount (S7 frontend) and stuffs the
/// input value + (optionally) attaches `alert_id` as turn context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrefillPayload {
    pub alert_id: String,
    pub text: String,
}

/// What `handle_ambient_action` can fail with. Genuine programming
/// errors (audit insert failure on a wedged SQLite, registry returning
/// a panic-shaped error) bubble up; the two domain-meaningful
/// short-circuits — denied + tool-missing — get their own variants
/// so the caller can render a different toast / tooltip per case.
#[derive(Debug, thiserror::Error)]
pub enum AmbientError {
    /// User has set `desktop.open_in_editor` to `Deny` in Settings.
    /// The toast / tray surface should point at Settings →
    /// Permissions.
    #[error("permission denied: {tool}")]
    Denied { tool: String },
    /// `desktop.open_in_editor` is missing from the registry. Happens
    /// when the desktop_os cluster failed to install at boot
    /// (unexpected — desktop OS tools always construct).
    #[error("tool not registered: {tool}")]
    ToolMissing { tool: String },
    /// Underlying registry error (schema invalid, exec failed, …).
    /// Wrapping `RegistryError` so callers can pattern-match on the
    /// underlying cause when they care.
    #[error("registry: {0}")]
    Registry(#[from] RegistryError),
    /// Audit insert failed (SQLite wedged, disk full, …).
    #[error("audit: {0}")]
    Audit(#[from] AuditError),
    /// `Emit` callback returned an error.
    #[error("emit: {0}")]
    Emit(String),
}

/// Type-erased dependency vector. Keeping the surface as a single
/// `&AmbientActionDeps` argument means tests construct one in three
/// lines and the production caller (Tauri menu handler) does the
/// same.
pub struct AmbientActionDeps<'a, F>
where
    F: Fn(&PrefillPayload) -> Result<(), String> + Send + Sync,
{
    pub registry: &'a Arc<ToolRegistry>,
    pub audit: &'a Arc<AuditLog>,
    /// Callback that fires the `chat:prefill` Tauri event. In
    /// production this is `move |p| app.emit("chat:prefill", p)`. In
    /// tests it's a closure that records the payload in a `Mutex`.
    pub emit_prefill: F,
}

/// Single dispatcher for every `AmbientAction`. Side-effect map:
///
/// - `OpenInEditor` → `registry.invoke_traced_confirmed("desktop.open_in_editor", …, "ambient-toast")`
/// - `FixWithAi` / `Investigate` → call `emit_prefill(payload)`
/// - `Ignore` → insert an `ambient.dismiss_alert` audit row
///
/// `session_id` is fixed to `"ambient-toast"` here because that's
/// where the action canonically originates. Tray menu and context
/// menu paths use the same handler but pass their own `session_id`
/// via the dedicated `dispatch_*` helpers below.
pub async fn handle_ambient_action<F>(
    action: AmbientAction,
    deps: &AmbientActionDeps<'_, F>,
    session_id: &str,
) -> Result<(), AmbientError>
where
    F: Fn(&PrefillPayload) -> Result<(), String> + Send + Sync,
{
    match action {
        AmbientAction::OpenInEditor { file, line } => {
            // The tool requires `path`; `line` is optional. Match the
            // schema in `agent::tools::desktop_os::open_in_editor_meta`.
            let mut args = serde_json::Map::new();
            args.insert("path".to_string(), Value::String(file));
            if let Some(line) = line {
                args.insert("line".to_string(), Value::Number(line.into()));
            }
            invoke_open_in_editor(deps.registry, Value::Object(args), session_id).await
        }
        AmbientAction::FixWithAi { alert_id, prefill }
        | AmbientAction::Investigate { alert_id, prefill } => {
            let payload = PrefillPayload {
                alert_id,
                text: prefill,
            };
            (deps.emit_prefill)(&payload).map_err(AmbientError::Emit)
        }
        AmbientAction::Ignore { alert_id } => {
            append_dismissal(deps.audit, &alert_id, session_id)?;
            Ok(())
        }
    }
}

/// Invoke `desktop.open_in_editor` as the user.
///
/// Two-phase to honour `Deny` while still skipping `Confirm`:
///
/// 1. First call goes through `invoke_traced` so the permission
///    resolver decides. If the effective level is `Deny`, the
///    registry returns `PermissionDenied` and we surface
///    [`AmbientError::Denied`] without ever calling `execute()`.
/// 2. If the resolver short-circuits with `RequiresConfirm`, the
///    user clicking the ambient surface IS the consent, so we
///    re-invoke through `invoke_traced_confirmed` to skip the gate
///    and persist exactly one audit row.
/// 3. `Auto` paths return `Ok(_)` from the first call and we're
///    done in one round-trip.
///
/// Calling `invoke_traced_confirmed` directly would have bypassed
/// the `Deny` override too, which is wrong: we must never run a
/// tool the user explicitly disabled.
async fn invoke_open_in_editor(
    registry: &Arc<ToolRegistry>,
    args: Value,
    session_id: &str,
) -> Result<(), AmbientError> {
    let session = Some(session_id.to_string());
    let first = registry
        .invoke_traced("desktop.open_in_editor", args.clone(), session.clone())
        .await;

    match first {
        Ok(_) => Ok(()),
        Err(RegistryError::PermissionDenied) => Err(AmbientError::Denied {
            tool: "desktop.open_in_editor".to_string(),
        }),
        Err(RegistryError::RequiresConfirm) => {
            // Click on the ambient surface IS the consent — re-invoke
            // with the gate skipped. Schema-invalid args still fail
            // here; that's a programming error in the parser, not a
            // permission issue, so it propagates as `Registry`.
            let second = registry
                .invoke_traced_confirmed("desktop.open_in_editor", args, session)
                .await;
            match second {
                Ok(_) => Ok(()),
                Err(RegistryError::UnknownTool(name)) => {
                    Err(AmbientError::ToolMissing { tool: name })
                }
                Err(other) => Err(AmbientError::Registry(other)),
            }
        }
        Err(RegistryError::UnknownTool(name)) => Err(AmbientError::ToolMissing { tool: name }),
        Err(other) => Err(AmbientError::Registry(other)),
    }
}

/// Insert an `ambient.dismiss_alert` row with `args = {alert_id}`,
/// `success = true`, `permission = Auto`. The audit-log viewer will
/// show this filtered alongside chat-driven dismissals.
fn append_dismissal(
    audit: &Arc<AuditLog>,
    alert_id: &str,
    session_id: &str,
) -> Result<(), AuditError> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let entry = AuditEntry {
        id: Uuid::new_v4().simple().to_string(),
        tool_name: "ambient.dismiss_alert".to_string(),
        session_id: Some(session_id.to_string()),
        args_json: serde_json::json!({ "alert_id": alert_id }).to_string(),
        result_json: None,
        permission: PermissionLevel::Auto,
        permission_decision: PermissionDecision::Allow,
        // No witness receipt because we never produced one — this is
        // a pure UI-side audit row, not a tool invocation.
        witness_receipt_id: None,
        started_at_ms: now_ms,
        finished_at_ms: now_ms,
        success: true,
        error: None,
        // User clicked Dismiss in the toast/tray — equivalent to a
        // user-initiated action, but not via /<command>. Tag as
        // "ambient" so it's distinguishable from agent-driven and
        // slash-driven rows.
        source: "ambient".to_string(),
    };
    audit.insert(&entry)
}

/// Populate `LastAlertStore` and fire the OS toast for `alert`.
///
/// The toast carries title + body only — no inline action buttons.
/// Action paritary across Windows / macOS / Linux notification
/// daemons is unreliable enough that the S7 prompt explicitly opts
/// out (see "Cross-platform reality" in the spec). Users reach the
/// 4 actions via:
///
/// - Tray menu → Quick Actions submenu (handles all 4)
/// - In-app right-click on a stacktrace line (handles `OpenInEditor`,
///   `FixWithAi`, `Investigate`)
/// - Hover tooltip on a `file:line` location (handles `OpenInEditor`)
///
/// All three surfaces dispatch through [`handle_ambient_action`], so
/// the action audit trail is byte-identical.
pub fn show_alert_toast<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    last_alert: &LastAlertStore,
    alert: AlertSnapshot,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    last_alert.set(alert.clone());

    app.notification()
        .builder()
        .title(alert.title)
        .body(alert.body)
        .show()
        .map_err(|e| e.to_string())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::{
        register_desktop_os_tools, DesktopOsBackends, MockClipboardBackend, MockEditorBackend,
        MockFinderBackend, MockNotifyBackend, MockUrlOpenerBackend, MockWindowFocusBackend,
    };
    use crate::agent::witness::{InMemoryReceiptSink, WitnessEmitter};
    use crate::agent::{AuditLog, PermissionResolver, ToolRegistry};
    use r2d2_sqlite::SqliteConnectionManager;
    use std::sync::Mutex;

    fn pool() -> crate::store::SqlitePool {
        let manager = SqliteConnectionManager::memory();
        r2d2::Pool::builder()
            .max_size(1)
            .build(manager)
            .expect("memory pool")
    }

    /// Build a registry with the desktop_os cluster registered against
    /// mock backends so `desktop.open_in_editor` is callable end-to-
    /// end without Tauri.
    fn rig() -> (Arc<ToolRegistry>, Arc<AuditLog>, Arc<PermissionResolver>) {
        let resolver = Arc::new(PermissionResolver::new());
        let sink = Arc::new(InMemoryReceiptSink::new(64));
        let witness = Arc::new(WitnessEmitter::new(sink));
        let audit = Arc::new(AuditLog::new(pool()));
        audit.ensure_schema().expect("schema");

        let registry = Arc::new(ToolRegistry::new(
            resolver.clone(),
            witness,
            audit.clone(),
        ));
        let backends = DesktopOsBackends {
            editor: Arc::new(MockEditorBackend::new()),
            url_opener: Arc::new(MockUrlOpenerBackend::new()),
            clipboard: Arc::new(MockClipboardBackend::new()),
            notify: Arc::new(MockNotifyBackend::new()),
            window_focus: Arc::new(MockWindowFocusBackend::new()),
            finder: Arc::new(MockFinderBackend::new()),
        };
        register_desktop_os_tools(&registry, backends).expect("register");
        (registry, audit, resolver)
    }

    fn capture_emit() -> (
        impl Fn(&PrefillPayload) -> Result<(), String> + Send + Sync,
        Arc<Mutex<Vec<PrefillPayload>>>,
    ) {
        let captured: Arc<Mutex<Vec<PrefillPayload>>> = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = captured.clone();
        let emit = move |p: &PrefillPayload| -> Result<(), String> {
            captured_clone.lock().unwrap().push(p.clone());
            Ok(())
        };
        (emit, captured)
    }

    #[tokio::test]
    async fn open_in_editor_invokes_tool_with_args_and_audits_with_session_tag() {
        let (registry, audit, _res) = rig();
        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        handle_ambient_action(
            AmbientAction::OpenInEditor {
                file: "/srv/app/server.js".into(),
                line: Some(42),
            },
            &deps,
            super::super::AMBIENT_SESSION_TOAST,
        )
        .await
        .expect("ok");

        let row = audit.list_recent(1).unwrap().pop().expect("row");
        assert_eq!(row.tool_name, "desktop.open_in_editor");
        assert_eq!(row.session_id.as_deref(), Some("ambient-toast"));
        assert!(row.args_json.contains("/srv/app/server.js"));
        assert!(row.args_json.contains("42"));
        assert!(row.success);
    }

    #[tokio::test]
    async fn open_in_editor_without_line_omits_line_arg() {
        let (registry, audit, _res) = rig();
        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        handle_ambient_action(
            AmbientAction::OpenInEditor {
                file: "/x.rs".into(),
                line: None,
            },
            &deps,
            super::super::AMBIENT_SESSION_TRAY,
        )
        .await
        .expect("ok");

        let row = audit.list_recent(1).unwrap().pop().unwrap();
        // Schema accepts the call without `line`; ensure we didn't
        // accidentally serialise `null`.
        assert!(!row.args_json.contains("\"line\""));
        assert_eq!(row.session_id.as_deref(), Some("ambient-tray"));
    }

    #[tokio::test]
    async fn fix_with_ai_emits_prefill_payload_and_does_not_audit() {
        let (registry, audit, _res) = rig();
        let (emit, captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        handle_ambient_action(
            AmbientAction::FixWithAi {
                alert_id: "a-1".into(),
                prefill: "Fix this stacktrace".into(),
            },
            &deps,
            super::super::AMBIENT_SESSION_TOAST,
        )
        .await
        .expect("ok");

        let payloads = captured.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].alert_id, "a-1");
        assert_eq!(payloads[0].text, "Fix this stacktrace");
        // Prefill is a frontend hand-off, not a tool invocation; we
        // don't write an audit row for the click itself.
        assert_eq!(audit.count().unwrap(), 0);
    }

    #[tokio::test]
    async fn investigate_emits_prefill_with_distinct_text() {
        let (registry, audit, _res) = rig();
        let (emit, captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        handle_ambient_action(
            AmbientAction::Investigate {
                alert_id: "a-7".into(),
                prefill: "Why did this fail?".into(),
            },
            &deps,
            super::super::AMBIENT_SESSION_CONTEXT,
        )
        .await
        .expect("ok");

        let payloads = captured.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].text, "Why did this fail?");
    }

    #[tokio::test]
    async fn ignore_appends_dismissal_audit_row() {
        let (registry, audit, _res) = rig();
        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        handle_ambient_action(
            AmbientAction::Ignore {
                alert_id: "a-9".into(),
            },
            &deps,
            super::super::AMBIENT_SESSION_TOAST,
        )
        .await
        .expect("ok");

        let row = audit.list_recent(1).unwrap().pop().expect("row");
        assert_eq!(row.tool_name, "ambient.dismiss_alert");
        assert!(row.args_json.contains("a-9"));
        assert!(row.success);
        assert!(row.witness_receipt_id.is_none());
        assert_eq!(row.session_id.as_deref(), Some("ambient-toast"));
    }

    #[tokio::test]
    async fn open_in_editor_returns_denied_when_user_overrode_to_deny() {
        let (registry, audit, resolver) = rig();
        resolver.set_override("desktop.open_in_editor", PermissionLevel::Deny);

        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        let err = handle_ambient_action(
            AmbientAction::OpenInEditor {
                file: "/x.rs".into(),
                line: None,
            },
            &deps,
            super::super::AMBIENT_SESSION_TOAST,
        )
        .await
        .expect_err("must deny");

        match err {
            AmbientError::Denied { tool } => assert_eq!(tool, "desktop.open_in_editor"),
            other => panic!("expected Denied, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn emit_callback_failure_propagates_as_emit_error() {
        let (registry, audit, _res) = rig();
        let failing_emit = |_p: &PrefillPayload| -> Result<(), String> {
            Err("listener gone".into())
        };
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: failing_emit,
        };

        let err = handle_ambient_action(
            AmbientAction::FixWithAi {
                alert_id: "a-1".into(),
                prefill: "Fix me".into(),
            },
            &deps,
            super::super::AMBIENT_SESSION_TOAST,
        )
        .await
        .expect_err("must error");

        match err {
            AmbientError::Emit(msg) => assert!(msg.contains("listener gone")),
            other => panic!("expected Emit, got {other:?}"),
        }
    }
}
