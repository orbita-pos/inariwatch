//! Concrete tool implementations registered into [`super::ToolRegistry`].
//!
//! Each tool is a small struct holding a [`ToolMeta`] block + an
//! `Arc<dyn SomeBackend>`. The backend trait is the seam that lets us
//! drive the tool from production (`Tauri*Backend` calls into the
//! Tauri plugin layer) and from headless tests (`Mock*Backend`
//! captures the calls into a `Mutex`). The boundary is explicit so
//! tests don't need a Tauri runtime — that's the whole reason the
//! seam exists.
//!
//! Sub-modules:
//!
//! - [`desktop_os`] — S3, six tools that surface the OS to the chat
//!   agent (`open_in_editor`, `open_url`, `read_clipboard`,
//!   `write_clipboard`, `notify`, `focus_window`).
//! - [`local_exec`] — S4, six tools that surface local execution
//!   (`run_shell`, `read_file`, `write_file`, `run_test`,
//!   `git_status`, `git_diff`). Mocks are feature-gated behind
//!   `agent-test-utils` because a `MockShellBackend` that ignores
//!   commands is a footgun if accidentally imported from production
//!   code.
//! - [`comm`] — S5, three tools that send messages on the user's
//!   behalf (`send_whatsapp`, `send_telegram`, `send_slack`). Wraps
//!   the local Baileys sidecar plus the desktop web proxies. Same
//!   feature-gated mocks pattern as [`local_exec`].
//! - [`search`] — S13, one tool (`search.error_context`) that wraps
//!   the [`inari_search::Searcher`] facade for Tier 0 search across
//!   Stack Overflow + GitHub Issues + MDN. Anonymous quotas only —
//!   no key, no signup. Default permission is `Auto` because search
//!   is read-only, free, and < 1s; pedir confirm en cada search sería
//!   ruidoso. Same feature-gated mocks pattern as the other clusters.
//!
//! The `register_*` helpers stay narrow on purpose: each cluster
//! exposes one helper that takes an `Arc<ToolRegistry>` plus a
//! cluster-specific backend bundle. Boot wiring (S6) calls the prod
//! constructors; tests pass mocks directly.
//!
//! [`ToolMeta`]: super::ToolMeta

pub mod cloud;
pub mod comm;
pub mod desktop_os;
pub mod local_exec;
// S13 — search cluster. New module; merge with S8 should be a no-op
// here (S8 doesn't add a new tool cluster, it adds a messenger
// gateway in lib.rs::run + an IPC surface).
pub mod search;
// setup cluster — chat-facing wrapper around the wizard install pipeline.
pub mod setup;

pub use desktop_os::{
    register_desktop_os_tools, ClipboardBackend, DesktopOsBackends, EditorBackend, FinderBackend,
    FocusWindowTool, MockClipboardBackend, MockEditorBackend, MockFinderBackend, MockNotifyBackend,
    MockUrlOpenerBackend, MockWindowFocusBackend, NotifyBackend, NotifyTool, OpenFinderTool,
    OpenInEditorTool, OpenUrlTool, ReadClipboardTool, UrlOpenerBackend, WindowFocusBackend,
    WriteClipboardTool,
};

pub use local_exec::{
    register_local_exec_tools, ConstructError as LocalExecConstructError, FsBackend, FsKind,
    GitBackend, GitDiffTool, GitStatusTool, LocalExecBackends, ReadFileTool, RunShellTool,
    RunTestTool, ShellBackend, ShellOutput, TauriFsBackend, TauriGitBackend, TauriShellBackend,
    WriteFileTool,
};

pub use comm::{
    register_comm_tools, CommBackends, ConstructError as CommConstructError, DesktopApiClient,
    SendSlackTool, SendTelegramTool, SendWhatsAppTool, SlackBackend, TauriSlackBackend,
    TauriTelegramBackend, TauriWhatsAppBackend, TelegramBackend, TelegramChatId, WhatsAppBackend,
};

// Cloud workspace cluster — read-only queries against /api/desktop/*.
pub use cloud::{
    register_cloud_tools, CloudApiBackend, CloudBackends, GetProjectHealthTool,
    GetWorkspaceSummaryTool, ListProjectsTool, TauriCloudApiBackend,
};

// S13 — search cluster re-exports. Mocks behind the feature gate so
// `MockSearchBackend` is only visible to integration tests with
// `--features agent-test-utils`.
pub use search::{
    register_search_tools, BackendError as SearchBackendError, SearchBackend,
    SearchErrorContextTool, SearchToolBackends, TauriSearchBackend,
};

pub use setup::{
    register_setup_tools, InstallCaptureBackend, InstallCaptureTool, SetupBackends,
    TauriInstallCaptureBackend,
};

use super::ToolMeta;

/// Pure-data catalog of every tool that *would* be registered if the
/// chat agent were running. S11's settings UI + audit log read this so
/// they can enumerate per-tool defaults without instantiating the
/// `ToolRegistry` (which needs Tauri-bound backends not present at
/// dock boot).
///
/// Order matches the cluster registration order: `desktop_os` first,
/// then `local_exec` (S4), then `comm` (S5), then `search` (S13),
/// then `setup` (install_capture), then `cloud` (S6.5).
/// Every cluster owns its own `pub fn catalog()`; this aggregator
/// just chains them.
pub fn catalog_all() -> Vec<ToolMeta> {
    let mut v = Vec::new();
    v.extend(desktop_os::catalog());
    v.extend(local_exec::catalog());
    v.extend(comm::catalog());
    v.extend(search::catalog()); // S13 — search.error_context (1 tool)
    v.extend(setup::catalog()); // setup.install_capture (1 tool)
    v.extend(cloud::catalog()); // S6.5 — cloud.{list_projects, get_project_health, get_workspace_summary}
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_all_includes_every_desktop_os_tool() {
        let aggregate_v = catalog_all();
        let cluster_v = desktop_os::catalog();
        let aggregate: Vec<&str> = aggregate_v.iter().map(|m| m.name.as_str()).collect();
        let cluster: Vec<&str> = cluster_v.iter().map(|m| m.name.as_str()).collect();
        // Every cluster entry appears in the aggregate, in the same order.
        for (i, name) in cluster.iter().enumerate() {
            assert_eq!(aggregate[i], *name, "aggregate drifted from cluster order");
        }
    }

    #[test]
    fn catalog_all_names_are_unique() {
        let mut names: Vec<String> = catalog_all().into_iter().map(|m| m.name).collect();
        let len_before = names.len();
        names.sort();
        names.dedup();
        assert_eq!(
            len_before,
            names.len(),
            "duplicate tool name in catalog_all"
        );
    }

    // S13 — search cluster appended after comm. Asserts that the
    // search tool is present AND comes after every comm tool, so the
    // settings UI builder doesn't need to special-case ordering.
    #[test]
    fn catalog_all_includes_search_tools_after_comm() {
        let aggregate_v = catalog_all();
        let names: Vec<&str> = aggregate_v.iter().map(|m| m.name.as_str()).collect();
        let comm_last_idx = comm::catalog()
            .last()
            .map(|m| names.iter().position(|n| *n == m.name).expect("comm last tool present"))
            .expect("comm cluster has at least one tool");
        let search_first_idx = search::catalog()
            .first()
            .map(|m| names.iter().position(|n| *n == m.name).expect("search first tool present"))
            .expect("search cluster has at least one tool");
        assert!(
            search_first_idx > comm_last_idx,
            "search.* must follow comm.* in catalog_all (got search@{search_first_idx} comm-last@{comm_last_idx})"
        );
        assert!(
            names.contains(&"search.error_context"),
            "search.error_context must appear in catalog_all"
        );
    }

    // setup cluster appended after search. Asserts ordering and presence.
    #[test]
    fn catalog_all_includes_setup_tools_after_search() {
        let aggregate_v = catalog_all();
        let names: Vec<&str> = aggregate_v.iter().map(|m| m.name.as_str()).collect();
        let search_last_idx = search::catalog()
            .last()
            .map(|m| names.iter().position(|n| *n == m.name).expect("search last tool present"))
            .expect("search cluster has at least one tool");
        let setup_first_idx = setup::catalog()
            .first()
            .map(|m| names.iter().position(|n| *n == m.name).expect("setup first tool present"))
            .expect("setup cluster has at least one tool");
        assert!(
            setup_first_idx > search_last_idx,
            "setup.* must follow search.* in catalog_all (got setup@{setup_first_idx} search-last@{search_last_idx})"
        );
        assert!(
            names.contains(&"setup.install_capture"),
            "setup.install_capture must appear in catalog_all"
        );
    }

    // Cloud cluster (S6.5) appended after setup — last in the catalog
    // today so a fresh paired user discovers workspace-level reads after
    // the setup checklist is done.
    #[test]
    fn catalog_all_includes_cloud_tools_after_setup() {
        let aggregate_v = catalog_all();
        let names: Vec<&str> = aggregate_v.iter().map(|m| m.name.as_str()).collect();
        let setup_last_idx = setup::catalog()
            .last()
            .map(|m| {
                names
                    .iter()
                    .position(|n| *n == m.name)
                    .expect("setup last tool present")
            })
            .expect("setup cluster has at least one tool");
        let cloud_first_idx = cloud::catalog()
            .first()
            .map(|m| {
                names
                    .iter()
                    .position(|n| *n == m.name)
                    .expect("cloud first tool present")
            })
            .expect("cloud cluster has at least one tool");
        assert!(
            cloud_first_idx > setup_last_idx,
            "cloud.* must follow setup.* in catalog_all (got cloud@{cloud_first_idx} setup-last@{setup_last_idx})"
        );
        for expected in [
            "cloud.list_projects",
            "cloud.get_project_health",
            "cloud.get_workspace_summary",
        ] {
            assert!(
                names.contains(&expected),
                "{expected} must appear in catalog_all"
            );
        }
    }
}
