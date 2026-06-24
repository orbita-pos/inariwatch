//! Tray menu item identification + async-side-effect dispatcher for
//! the four Quick Actions. The `tray::mod` integration glue is the
//! only consumer; both the id-mapping and the dispatcher are
//! unit-tested here against a registry seeded with mock backends.

use crate::notifications::{
    first_location, handle_ambient_action, AmbientAction, AmbientActionDeps, AmbientError,
    LastAlertStore, PrefillPayload, AMBIENT_SESSION_TRAY,
};

/// Stable enum mirror of the tray menu's MenuItem ids. The strings
/// in [`Self::id`] / [`Self::from_id`] are the same `MenuItem::with_id`
/// strings the [`super::menu::build_menu`] uses, so this enum is the
/// single source of truth for "what does the user just clicked
/// resolve to".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayMenuItem {
    Open,
    Inari,
    Dashboard,
    Settings,
    Pause,
    PauseSensors,
    Quit,
    /// Quick Actions → Fix Last Alert.
    QuickFix,
    /// Quick Actions → Investigate Last.
    QuickInvestigate,
    /// Quick Actions → Open Latest Stacktrace in Editor.
    QuickOpenStacktrace,
    /// Quick Actions → Show Audit Log.
    QuickShowAudit,
}

impl TrayMenuItem {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Inari => "inari",
            Self::Dashboard => "dashboard",
            Self::Settings => "settings",
            Self::Pause => "pause",
            Self::PauseSensors => "pause_sensors",
            Self::Quit => "quit",
            Self::QuickFix => "quick.fix",
            Self::QuickInvestigate => "quick.investigate",
            Self::QuickOpenStacktrace => "quick.stacktrace",
            Self::QuickShowAudit => "quick.audit",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "open" => Self::Open,
            "inari" => Self::Inari,
            "dashboard" => Self::Dashboard,
            "settings" => Self::Settings,
            "pause" => Self::Pause,
            "pause_sensors" => Self::PauseSensors,
            "quit" => Self::Quit,
            "quick.fix" => Self::QuickFix,
            "quick.investigate" => Self::QuickInvestigate,
            "quick.stacktrace" => Self::QuickOpenStacktrace,
            "quick.audit" => Self::QuickShowAudit,
            _ => return None,
        })
    }
}

/// Resolve a Quick Actions click into an `AmbientAction` and
/// dispatch it through [`handle_ambient_action`]. Returns:
///
/// - `Some(Ok(()))` — the action ran (or its prefill emit succeeded).
/// - `Some(Err(_))` — registry / audit / emit failure.
/// - `None` — the click was a no-op (no last alert, or
///   "Open Latest Stacktrace" with an alert that has no parseable
///   stacktrace). The caller logs at info — this is normal UX, not
///   a bug.
///
/// `QuickShowAudit` is intentionally NOT handled here — it's a
/// purely UI-side deeplink (frontend route change). The tray mod
/// fires `tray:navigate` directly. We only route the three items
/// that touch the registry / audit / emit pipeline through this
/// helper so the test surface stays narrow.
pub async fn dispatch_quick_action<F>(
    item: TrayMenuItem,
    last_alert: &LastAlertStore,
    deps: &AmbientActionDeps<'_, F>,
) -> Option<Result<(), AmbientError>>
where
    F: Fn(&PrefillPayload) -> Result<(), String> + Send + Sync,
{
    let alert = last_alert.get()?;
    match item {
        TrayMenuItem::QuickFix => {
            let prefill = format!(
                "Fix this alert:\n\n**{}**\n\n{}",
                alert.title.trim(),
                alert.body.trim()
            );
            Some(
                handle_ambient_action(
                    AmbientAction::FixWithAi {
                        alert_id: alert.id,
                        prefill,
                    },
                    deps,
                    AMBIENT_SESSION_TRAY,
                )
                .await,
            )
        }
        TrayMenuItem::QuickInvestigate => {
            let prefill = format!(
                "Investigate this alert:\n\n**{}**\n\n{}",
                alert.title.trim(),
                alert.body.trim()
            );
            Some(
                handle_ambient_action(
                    AmbientAction::Investigate {
                        alert_id: alert.id,
                        prefill,
                    },
                    deps,
                    AMBIENT_SESSION_TRAY,
                )
                .await,
            )
        }
        TrayMenuItem::QuickOpenStacktrace => {
            let location = first_location(&alert.stacktrace)?;
            Some(
                handle_ambient_action(
                    AmbientAction::OpenInEditor {
                        file: location.path,
                        line: Some(location.line),
                    },
                    deps,
                    AMBIENT_SESSION_TRAY,
                )
                .await,
            )
        }
        // Non-Quick-Action variants are a programming error — the
        // tray mod never routes them here. Surfacing as `None` keeps
        // the function total without panicking.
        TrayMenuItem::Open
        | TrayMenuItem::Inari
        | TrayMenuItem::Dashboard
        | TrayMenuItem::Settings
        | TrayMenuItem::Pause
        | TrayMenuItem::PauseSensors
        | TrayMenuItem::Quit
        | TrayMenuItem::QuickShowAudit => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::{
        register_desktop_os_tools, DesktopOsBackends, MockClipboardBackend, MockEditorBackend,
        MockFinderBackend, MockNotifyBackend, MockUrlOpenerBackend, MockWindowFocusBackend,
    };
    use crate::agent::witness::{InMemoryReceiptSink, WitnessEmitter};
    use crate::agent::{AuditLog, PermissionResolver, ToolRegistry};
    use crate::notifications::AlertSnapshot;
    use r2d2_sqlite::SqliteConnectionManager;
    use std::sync::{Arc, Mutex};

    fn pool() -> crate::store::SqlitePool {
        let manager = SqliteConnectionManager::memory();
        r2d2::Pool::builder()
            .max_size(1)
            .build(manager)
            .expect("memory pool")
    }

    fn rig() -> (Arc<ToolRegistry>, Arc<AuditLog>) {
        let resolver = Arc::new(PermissionResolver::new());
        let sink = Arc::new(InMemoryReceiptSink::new(64));
        let witness = Arc::new(WitnessEmitter::new(sink));
        let audit = Arc::new(AuditLog::new(pool()));
        audit.ensure_schema().expect("schema");
        let registry = Arc::new(ToolRegistry::new(resolver, witness, audit.clone()));
        let backends = DesktopOsBackends {
            editor: Arc::new(MockEditorBackend::new()),
            url_opener: Arc::new(MockUrlOpenerBackend::new()),
            clipboard: Arc::new(MockClipboardBackend::new()),
            notify: Arc::new(MockNotifyBackend::new()),
            window_focus: Arc::new(MockWindowFocusBackend::new()),
            finder: Arc::new(MockFinderBackend::new()),
        };
        register_desktop_os_tools(&registry, backends).expect("register");
        (registry, audit)
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

    #[test]
    fn from_id_handles_all_known_ids_and_rejects_others() {
        for variant in [
            TrayMenuItem::Open,
            TrayMenuItem::Inari,
            TrayMenuItem::Dashboard,
            TrayMenuItem::Settings,
            TrayMenuItem::Pause,
            TrayMenuItem::PauseSensors,
            TrayMenuItem::Quit,
            TrayMenuItem::QuickFix,
            TrayMenuItem::QuickInvestigate,
            TrayMenuItem::QuickOpenStacktrace,
            TrayMenuItem::QuickShowAudit,
        ] {
            assert_eq!(TrayMenuItem::from_id(variant.id()), Some(variant));
        }
        assert_eq!(TrayMenuItem::from_id("nope"), None);
        assert_eq!(TrayMenuItem::from_id(""), None);
    }

    #[test]
    fn id_strings_are_unique_across_variants() {
        let ids = [
            TrayMenuItem::Open.id(),
            TrayMenuItem::Inari.id(),
            TrayMenuItem::Dashboard.id(),
            TrayMenuItem::Settings.id(),
            TrayMenuItem::Pause.id(),
            TrayMenuItem::PauseSensors.id(),
            TrayMenuItem::Quit.id(),
            TrayMenuItem::QuickFix.id(),
            TrayMenuItem::QuickInvestigate.id(),
            TrayMenuItem::QuickOpenStacktrace.id(),
            TrayMenuItem::QuickShowAudit.id(),
        ];
        let mut sorted = ids.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "duplicate menu id");
    }

    #[tokio::test]
    async fn quick_fix_with_no_alert_returns_none() {
        let (registry, audit) = rig();
        let last_alert = LastAlertStore::new();
        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };
        assert!(dispatch_quick_action(TrayMenuItem::QuickFix, &last_alert, &deps)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn quick_fix_with_alert_emits_prefill_with_title_and_body() {
        let (registry, audit) = rig();
        let last_alert = LastAlertStore::new();
        last_alert.set(AlertSnapshot::new(
            "a-1",
            "Sentry: TypeError",
            "Cannot read property 'foo' of undefined at handler.",
            "",
        ));
        let (emit, captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        let result = dispatch_quick_action(TrayMenuItem::QuickFix, &last_alert, &deps)
            .await
            .expect("some")
            .expect("ok");
        let _ = result;

        let payloads = captured.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].alert_id, "a-1");
        assert!(payloads[0].text.contains("Sentry: TypeError"));
        assert!(payloads[0].text.contains("Cannot read property"));
    }

    #[tokio::test]
    async fn quick_investigate_with_alert_emits_prefill_with_distinct_intro() {
        let (registry, audit) = rig();
        let last_alert = LastAlertStore::new();
        last_alert.set(AlertSnapshot::new(
            "a-2",
            "Vercel: Build failed",
            "Module not found: 'foo/bar'.",
            "",
        ));
        let (emit, captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        dispatch_quick_action(TrayMenuItem::QuickInvestigate, &last_alert, &deps)
            .await
            .expect("some")
            .expect("ok");

        let payloads = captured.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert!(payloads[0].text.starts_with("Investigate"));
    }

    #[tokio::test]
    async fn quick_stacktrace_with_no_stack_returns_none() {
        let (registry, audit) = rig();
        let last_alert = LastAlertStore::new();
        last_alert.set(AlertSnapshot::new(
            "a-3",
            "Uptime check",
            "https://example.com unreachable",
            "", // no stacktrace
        ));
        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };
        assert!(
            dispatch_quick_action(TrayMenuItem::QuickOpenStacktrace, &last_alert, &deps)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn quick_stacktrace_with_node_v8_frame_invokes_open_in_editor() {
        let (registry, audit) = rig();
        let last_alert = LastAlertStore::new();
        last_alert.set(AlertSnapshot::new(
            "a-4",
            "Sentry: TypeError",
            "Cannot read prop",
            "TypeError: Cannot read property 'foo' of undefined\n    at handler (/srv/app/server.js:42:13)",
        ));
        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };

        dispatch_quick_action(TrayMenuItem::QuickOpenStacktrace, &last_alert, &deps)
            .await
            .expect("some")
            .expect("ok");

        let row = audit.list_recent(1).unwrap().pop().expect("audit row");
        assert_eq!(row.tool_name, "desktop.open_in_editor");
        assert!(row.args_json.contains("/srv/app/server.js"));
        assert!(row.args_json.contains("42"));
        assert_eq!(row.session_id.as_deref(), Some(AMBIENT_SESSION_TRAY));
    }

    #[tokio::test]
    async fn non_quick_variants_return_none() {
        let (registry, audit) = rig();
        let last_alert = LastAlertStore::new();
        last_alert.set(AlertSnapshot::new("a", "T", "B", ""));
        let (emit, _captured) = capture_emit();
        let deps = AmbientActionDeps {
            registry: &registry,
            audit: &audit,
            emit_prefill: emit,
        };
        for variant in [
            TrayMenuItem::Open,
            TrayMenuItem::Inari,
            TrayMenuItem::Dashboard,
            TrayMenuItem::Settings,
            TrayMenuItem::Pause,
            TrayMenuItem::PauseSensors,
            TrayMenuItem::Quit,
            TrayMenuItem::QuickShowAudit,
        ] {
            assert!(dispatch_quick_action(variant, &last_alert, &deps)
                .await
                .is_none());
        }
    }
}
