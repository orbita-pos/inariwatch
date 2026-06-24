//! Setup cluster — tools that help the user connect their project to InariWatch
//! directly from the chat, without going through the Add-Project wizard UI.
//!
//! | name                         | default     | purpose                                           |
//! |------------------------------|-------------|---------------------------------------------------|
//! | `setup.install_capture`      | [`Confirm`] | npm install + config patch + .env.local + mint    |
//!
//! The tool is a chat-facing wrapper around the same 6-step pipeline that
//! powers `wizard_run_install`. When the user says "install capture to my
//! project" or "set up InariWatch", the LLM invokes this tool instead of
//! requiring the wizard UI flow.
//!
//! Adopt path: if `@inariwatch/capture` is already in package.json, the
//! install + patch + .env steps are skipped; only a fresh token is minted.
//!
//! [`Confirm`]: super::super::PermissionLevel::Confirm

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::super::{
    ChatTool, PermissionLevel, RegistryError, ToolError, ToolInvocation, ToolMeta, ToolOutput,
    ToolRegistry,
};
use crate::store::Store;
use crate::wizard::detect::detect_framework;
use crate::wizard::install::{InstallArgs, InstallResult};

// ── Backend trait ─────────────────────────────────────────────────────────────

/// `project_id` is `Option<String>`: when `None` the production backend
/// auto-resolves from the pending WizardStore (set when the user clicked
/// "Add Project" on the web dashboard). Mocks can assert on whatever value
/// the caller passes — they do NOT auto-resolve.
#[async_trait]
pub trait InstallCaptureBackend: Send + Sync + 'static {
    async fn install(
        &self,
        repo_path: PathBuf,
        framework: String,
        host: Option<String>,
        project_id: Option<String>,
    ) -> Result<InstallResult, String>;
}

// ── Production backend ────────────────────────────────────────────────────────

pub struct TauriInstallCaptureBackend {
    app: AppHandle,
    store: Arc<Store>,
}

impl TauriInstallCaptureBackend {
    pub fn new(app: AppHandle, store: Arc<Store>) -> Self {
        Self { app, store }
    }

    /// Resolve project_id from the pending WizardStore entry (the project
    /// the user is adding via the web dashboard). Returns an actionable
    /// error when no pending project exists.
    fn resolve_project_id(&self) -> Result<String, String> {
        if let Some(wizard_store) = self.app.try_state::<Arc<crate::wizard::WizardStore>>() {
            if let Some(pending) = wizard_store.pending() {
                return Ok(pending.project_id);
            }
        }
        Err(
            "No project_id provided and no pending Add-Project wizard found. \
             Open InariWatch, go to Projects, and click \"Add Project\" to link \
             this repository first, or pass project_id explicitly."
                .to_string(),
        )
    }
}

#[async_trait]
impl InstallCaptureBackend for TauriInstallCaptureBackend {
    async fn install(
        &self,
        repo_path: PathBuf,
        framework: String,
        host: Option<String>,
        project_id: Option<String>,
    ) -> Result<InstallResult, String> {
        let id = match project_id {
            Some(id) => id,
            None => self.resolve_project_id()?,
        };
        crate::wizard::install::run_install(
            &self.app,
            &self.store,
            InstallArgs { project_id: id, repo_path, framework, host },
        )
        .await
    }
}

// ── Bundle ────────────────────────────────────────────────────────────────────

pub struct SetupBackends {
    pub install: Arc<dyn InstallCaptureBackend>,
}

impl SetupBackends {
    pub fn from_app(app: AppHandle, store: Arc<Store>) -> Self {
        Self {
            install: Arc::new(TauriInstallCaptureBackend::new(app, store)),
        }
    }
}

// ── Schema + meta ─────────────────────────────────────────────────────────────

fn install_capture_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["repo_path"],
        "properties": {
            "repo_path": {
                "type": "string",
                "minLength": 1,
                "description": "Absolute path to the local repository root"
            },
            "project_id": {
                "type": ["string", "null"],
                "description": "InariWatch project ID. Auto-resolved from the pending Add-Project \
                    wizard when omitted — only needed if you have multiple projects and \
                    the wizard is not open"
            },
            "framework": {
                "type": "string",
                "enum": ["next", "express", "vite", "node"],
                "description": "JS/TS framework. Auto-detected from package.json when omitted"
            },
            "host": {
                "type": ["string", "null"],
                "description": "'vercel' triggers automatic DSN env-var sync; omit for other hosts"
            }
        }
    })
}

fn install_capture_meta() -> ToolMeta {
    ToolMeta {
        name: "setup.install_capture".into(),
        description: "Install @inariwatch/capture into the user's project at any absolute \
            repo_path on disk. Runs npm install, patches the framework config (next.config.ts, \
            instrumentation.ts, etc.), writes INARIWATCH_DSN to .env.local, and mints a \
            project token. When host='vercel', also syncs the DSN to Vercel environment \
            variables. Safe to run on a repo that already has capture installed — skips \
            install + patch and only mints a fresh token. \
            \
            FRAMEWORK AUTO-DETECTED: omit the `framework` arg and the tool reads the repo's \
            package.json itself to pick (next/express/vite/node). DO NOT call \
            `local_exec.read_file` on the target repo to verify framework first — \
            local_exec.* is sandboxed to the InariWatch desktop binary's workspace root and \
            will fail with 'path escapes workspace root' for any repo_path outside it (which \
            is the common case when installing capture into the user's other projects). \
            Just call this tool with `{ repo_path, project_id }` and let it handle detection. \
            \
            REQUIRES `project_id` to link the repo to an InariWatch project. If the user \
            hasn't told you which project, FIRST call `cloud.list_projects`, present the \
            options to them (name · state · current integrations), and ask which one to \
            link to before calling this tool. Calling without `project_id` when no \
            Add-Project wizard is open will fail with a 'no project_id provided' error \
            and waste a turn — always surface the choice first."
            .into(),
        params_schema: install_capture_schema(),
        default_permission: PermissionLevel::Confirm,
    }
}

pub fn catalog() -> Vec<ToolMeta> {
    vec![install_capture_meta()]
}

// ── Tool ──────────────────────────────────────────────────────────────────────

pub struct InstallCaptureTool {
    meta: ToolMeta,
    backend: Arc<dyn InstallCaptureBackend>,
}

impl InstallCaptureTool {
    pub fn new(backend: Arc<dyn InstallCaptureBackend>) -> Self {
        Self {
            meta: install_capture_meta(),
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for InstallCaptureTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let repo_path_str = invocation
            .args
            .get("repo_path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing repo_path".into()))?;

        let repo_path = PathBuf::from(repo_path_str);
        if !repo_path.is_absolute() {
            return Err(ToolError::InvalidArgs(
                "repo_path must be an absolute path".into(),
            ));
        }
        if !repo_path.is_dir() {
            return Err(ToolError::InvalidArgs(format!(
                "repo_path does not exist or is not a directory: {}",
                repo_path.display()
            )));
        }

        // project_id is optional: None → backend auto-resolves from WizardStore.
        let project_id = invocation
            .args
            .get("project_id")
            .and_then(Value::as_str)
            .map(str::to_string);

        // Use explicit framework arg when provided; otherwise auto-detect
        // from package.json using the same logic as the wizard.
        let framework = invocation
            .args
            .get("framework")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                detect_framework(&repo_path).unwrap_or_else(|| "node".to_string())
            });

        let host = invocation
            .args
            .get("host")
            .and_then(Value::as_str)
            .map(str::to_string);

        let result = self
            .backend
            .install(repo_path, framework.clone(), host, project_id)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        let summary = if result.adopted {
            format!(
                "@inariwatch/capture already installed — token minted ({})",
                &result.fingerprint[..8.min(result.fingerprint.len())]
            )
        } else {
            format!(
                "Installed @inariwatch/capture · {} · DSN: {}{}",
                framework,
                result.dsn_masked,
                if result.vercel_synced { " · Vercel synced" } else { "" }
            )
        };

        let value = serde_json::to_value(&result)
            .map_err(|e| ToolError::Internal(format!("serialize result: {e}")))?;

        Ok(ToolOutput {
            value,
            summary: Some(summary),
        })
    }
}

// ── Register ──────────────────────────────────────────────────────────────────

pub fn register_setup_tools(
    reg: &ToolRegistry,
    backends: SetupBackends,
) -> Result<(), RegistryError> {
    reg.register(Arc::new(InstallCaptureTool::new(backends.install)))?;
    Ok(())
}

// ── Mocks (gated) ─────────────────────────────────────────────────────────────

#[cfg(any(test, feature = "agent-test-utils"))]
pub mod mocks {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, Clone)]
    pub struct InstallCall {
        pub args: InstallArgs,
    }

    pub struct MockInstallCaptureBackend {
        inner: Mutex<MockState>,
    }

    struct MockState {
        calls: Vec<InstallCall>,
        next_result: Option<InstallResult>,
        next_error: Option<String>,
    }

    impl Default for MockInstallCaptureBackend {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockInstallCaptureBackend {
        pub fn new() -> Self {
            Self {
                inner: Mutex::new(MockState {
                    calls: Vec::new(),
                    next_result: None,
                    next_error: None,
                }),
            }
        }

        pub fn enqueue_result(&self, result: InstallResult) {
            self.inner.lock().unwrap().next_result = Some(result);
        }

        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }

        pub fn calls(&self) -> Vec<InstallCall> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl InstallCaptureBackend for MockInstallCaptureBackend {
        async fn install(
            &self,
            repo_path: PathBuf,
            framework: String,
            host: Option<String>,
            project_id: Option<String>,
        ) -> Result<InstallResult, String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(InstallCall {
                args: InstallArgs {
                    project_id: project_id.unwrap_or_else(|| "mock-auto-project".to_string()),
                    repo_path,
                    framework,
                    host,
                },
            });
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            Ok(s.next_result.take().unwrap_or_else(|| InstallResult {
                adopted: false,
                mint_id: "mock-mint-id".to_string(),
                fingerprint: "mock-fingerprint-0000".to_string(),
                dsn_masked: "inariwatch:***@example.com/mock".to_string(),
                vercel_synced: false,
                vercel_warning: None,
            }))
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::mocks::MockInstallCaptureBackend;
    use super::*;
    use serde_json::json;

    fn invocation(args: Value) -> ToolInvocation {
        ToolInvocation {
            id: "test-id".into(),
            tool_name: "setup.install_capture".into(),
            args,
            session_id: None,
        }
    }

    fn tmp_repo(pkg_json: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("package.json"), pkg_json).expect("write package.json");
        dir
    }

    // ── meta + schema ─────────────────────────────────────────────────────────

    #[test]
    fn meta_name_and_permission() {
        let tool = InstallCaptureTool::new(Arc::new(MockInstallCaptureBackend::new()));
        assert_eq!(tool.meta().name, "setup.install_capture");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Confirm);
    }

    #[test]
    fn schema_requires_only_repo_path() {
        let meta = install_capture_meta();
        let required: Vec<&str> = meta.params_schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(!required.contains(&"project_id"), "project_id must NOT be required (auto-resolved)");
        assert!(required.contains(&"repo_path"), "repo_path must be required");
    }

    #[test]
    fn schema_project_id_allows_null() {
        let meta = install_capture_meta();
        let ty = &meta.params_schema["properties"]["project_id"]["type"];
        // must be ["string","null"] to accept absent/null values
        let types: Vec<&str> = ty.as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(types.contains(&"null"), "project_id type must include null");
        assert!(types.contains(&"string"), "project_id type must include string");
    }

    #[test]
    fn schema_framework_is_an_enum() {
        let meta = install_capture_meta();
        let variants = meta.params_schema["properties"]["framework"]["enum"]
            .as_array()
            .expect("framework enum");
        let strs: Vec<&str> = variants.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(strs.contains(&"next"));
        assert!(strs.contains(&"vite"));
        assert!(strs.contains(&"express"));
        assert!(strs.contains(&"node"));
    }

    #[test]
    fn catalog_returns_one_meta() {
        assert_eq!(catalog().len(), 1);
        assert_eq!(catalog()[0].name, "setup.install_capture");
    }

    // ── execute — validation ──────────────────────────────────────────────────

    #[tokio::test]
    async fn execute_rejects_relative_repo_path() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        let tool = InstallCaptureTool::new(backend);
        let err = tool
            .execute(&invocation(json!({ "repo_path": "relative/path" })))
            .await
            .expect_err("must fail");
        assert!(
            matches!(err, ToolError::InvalidArgs(ref m) if m.contains("absolute")),
            "got {err}"
        );
    }

    #[tokio::test]
    async fn execute_rejects_nonexistent_repo_path() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        let tool = InstallCaptureTool::new(backend);
        #[cfg(unix)]
        let bad = "/this/path/does/not/exist/at/all";
        #[cfg(windows)]
        let bad = "C:\\this\\path\\does\\not\\exist\\at\\all";
        let err = tool
            .execute(&invocation(json!({ "repo_path": bad })))
            .await
            .expect_err("must fail");
        assert!(
            matches!(err, ToolError::InvalidArgs(ref m) if m.contains("does not exist")),
            "got {err}"
        );
    }

    // ── execute — happy path ──────────────────────────────────────────────────

    #[tokio::test]
    async fn execute_calls_backend_without_project_id() {
        // project_id omitted → mock fills in "mock-auto-project"
        let backend = Arc::new(MockInstallCaptureBackend::new());
        let tool = InstallCaptureTool::new(backend.clone());
        let dir = tmp_repo(r#"{"dependencies":{"next":"15.0.0"}}"#);
        let repo_path = dir.path().to_string_lossy().to_string();

        let out = tool
            .execute(&invocation(json!({ "repo_path": repo_path })))
            .await
            .expect("ok");

        let calls = backend.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args.project_id, "mock-auto-project");
        assert_eq!(calls[0].args.framework, "next"); // auto-detected

        let summary = out.summary.unwrap_or_default();
        assert!(summary.contains("next"), "summary should mention framework");
    }

    #[tokio::test]
    async fn execute_passes_explicit_project_id_to_backend() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        let tool = InstallCaptureTool::new(backend.clone());
        let dir = tmp_repo(r#"{"dependencies":{"next":"15.0.0"}}"#);

        tool.execute(&invocation(json!({
            "repo_path": dir.path().to_string_lossy(),
            "project_id": "explicit-proj-id"
        })))
        .await
        .expect("ok");

        assert_eq!(backend.calls()[0].args.project_id, "explicit-proj-id");
    }

    #[tokio::test]
    async fn execute_auto_detects_vite_framework() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        let tool = InstallCaptureTool::new(backend.clone());
        let dir = tmp_repo(r#"{"devDependencies":{"vite":"5.0.0"}}"#);

        let out = tool
            .execute(&invocation(json!({ "repo_path": dir.path().to_string_lossy() })))
            .await
            .expect("ok");

        assert_eq!(backend.calls()[0].args.framework, "vite");
        assert!(out.summary.unwrap_or_default().contains("vite"));
    }

    #[tokio::test]
    async fn execute_explicit_framework_overrides_detection() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        let tool = InstallCaptureTool::new(backend.clone());
        let dir = tmp_repo(r#"{"devDependencies":{"vite":"5.0.0"}}"#);

        tool.execute(&invocation(json!({
            "repo_path": dir.path().to_string_lossy(),
            "framework": "express"
        })))
        .await
        .expect("ok");

        assert_eq!(backend.calls()[0].args.framework, "express");
    }

    #[tokio::test]
    async fn execute_adopted_summary_mentions_token() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        backend.enqueue_result(crate::wizard::install::InstallResult {
            adopted: true,
            mint_id: "mid-001".to_string(),
            fingerprint: "abcdef1234567890".to_string(),
            dsn_masked: "inariwatch:***@example.com/proj".to_string(),
            vercel_synced: false,
            vercel_warning: None,
        });
        let tool = InstallCaptureTool::new(backend);
        let dir = tmp_repo(r#"{}"#);

        let out = tool
            .execute(&invocation(json!({ "repo_path": dir.path().to_string_lossy() })))
            .await
            .expect("ok");

        let summary = out.summary.unwrap_or_default();
        assert!(summary.contains("already installed"), "got: {summary}");
        assert!(summary.contains("abcdef12"), "fingerprint prefix in summary; got: {summary}");
    }

    #[tokio::test]
    async fn execute_vercel_synced_appears_in_summary() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        backend.enqueue_result(crate::wizard::install::InstallResult {
            adopted: false,
            mint_id: "mid-002".to_string(),
            fingerprint: "0000000000000000".to_string(),
            dsn_masked: "inariwatch:***@x.com/p".to_string(),
            vercel_synced: true,
            vercel_warning: None,
        });
        let tool = InstallCaptureTool::new(backend);
        let dir = tmp_repo(r#"{}"#);

        let out = tool
            .execute(&invocation(json!({
                "repo_path": dir.path().to_string_lossy(),
                "host": "vercel"
            })))
            .await
            .expect("ok");

        assert!(out.summary.unwrap_or_default().contains("Vercel synced"));
    }

    #[tokio::test]
    async fn execute_propagates_backend_error() {
        let backend = Arc::new(MockInstallCaptureBackend::new());
        backend.fail_next("npm ERR! code ENOENT");
        let tool = InstallCaptureTool::new(backend);
        let dir = tmp_repo(r#"{}"#);

        let err = tool
            .execute(&invocation(json!({ "repo_path": dir.path().to_string_lossy() })))
            .await
            .expect_err("must fail");

        assert!(
            matches!(err, ToolError::ExecutionFailed(ref m) if m.contains("npm ERR!")),
            "got {err}"
        );
    }
}
