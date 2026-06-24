//! Cloud workspace tool cluster — three `ChatTool`s that let the agent
//! query the user's paired workspace through the desktop's web bearer.
//!
//! Every cluster member is `Auto` (safe reads, no side effects). The
//! tools wrap the existing `/api/desktop/*` endpoints — the agent never
//! invents URLs and the lockdown stays intact because the HTTP call
//! goes through the shared [`super::comm::DesktopApiClient`] (same path
//! as the comm.* cluster).
//!
//! | name                          | default      | wraps                                       |
//! |-------------------------------|--------------|---------------------------------------------|
//! | `cloud.list_projects`         | [`Auto`]     | GET `/api/desktop/projects`                 |
//! | `cloud.get_project_health`    | [`Auto`]     | GET `/api/desktop/projects/<id>/health`     |
//! | `cloud.get_workspace_summary` | [`Auto`]     | GET `/api/desktop/workspace-summary`        |
//!
//! ## Why three tools instead of one
//!
//! A single `cloud.get_json(path)` tool would be more flexible but it
//! puts URL construction in the LLM's hands — risk of hallucinated
//! paths, no per-call permission gating, and a wider audit-log surface
//! that breaks the registry's "one row per intent" invariant. Three
//! purpose-bound tools also make sampling-time filtering cheap (the
//! frontend can show "Inari can see your project list" instead of "Inari
//! has full read access to your workspace").
//!
//! ## Backend seam
//!
//! Same `XBackend` pattern as [`super::local_exec`] and [`super::comm`].
//! Mocks are gated behind the `agent-test-utils` feature so a
//! `MockCloudApiBackend` that fabricates project lists can never end up
//! in production by accident.
//!
//! [`Auto`]: super::super::PermissionLevel::Auto

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::comm::{ApiError, DesktopApiClient};
use super::super::{
    ChatTool, PermissionLevel, RegistryError, ToolError, ToolInvocation, ToolMeta, ToolOutput,
    ToolRegistry,
};

// ── Backend seam ────────────────────────────────────────────────────────────

/// Cloud API backend. One method covers every cloud.* tool — they all
/// read aggregated JSON from a `/api/desktop/*` endpoint and there's no
/// per-tool transport state to keep separate. Mocks queue per-path
/// responses; production wraps the shared [`DesktopApiClient`].
#[async_trait]
pub trait CloudApiBackend: Send + Sync + 'static {
    /// GET the `path` (e.g. `"/api/desktop/projects"`) with the user's
    /// bearer; return the parsed JSON body. Implementations preserve
    /// 401 vs 4xx/5xx vs transport failures in the human message so
    /// the chat surface can suggest the right remediation (sign in
    /// again / wait / pair the desktop).
    async fn get_json(&self, path: &str) -> Result<Value, String>;
}

// ── Bundle ──────────────────────────────────────────────────────────────────

pub struct CloudBackends {
    pub api: Arc<dyn CloudApiBackend>,
}

impl CloudBackends {
    /// Production constructor. Wires the cluster onto the shared
    /// [`DesktopApiClient`] (same one comm.* uses) so re-login on the
    /// Tauri side picks up the new bearer for every cluster at once.
    pub fn from_app(app: tauri::AppHandle) -> Self {
        use tauri::Manager;
        let store = app.state::<Arc<crate::store::Store>>();
        let api = Arc::new(DesktopApiClient::new(store.inner().clone()));
        Self {
            api: Arc::new(TauriCloudApiBackend::new(api)),
        }
    }
}

/// Production [`CloudApiBackend`] — passes through to
/// [`DesktopApiClient::get_json`].
pub struct TauriCloudApiBackend {
    client: Arc<DesktopApiClient>,
}

impl TauriCloudApiBackend {
    pub fn new(client: Arc<DesktopApiClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl CloudApiBackend for TauriCloudApiBackend {
    async fn get_json(&self, path: &str) -> Result<Value, String> {
        self.client.get_json(path).await.map_err(api_error_to_string)
    }
}

fn api_error_to_string(err: ApiError) -> String {
    match err {
        ApiError::Unauthorized => {
            "not paired with the cloud: sign in via Settings → Account so the agent can see your workspace"
                .to_string()
        }
        ApiError::Transport(m) => format!("cloud transport error: {m}"),
        ApiError::Status { status, body } => {
            let trimmed: String = body.chars().take(256).collect();
            format!("cloud HTTP {status}: {trimmed}")
        }
    }
}

// ── Tools ───────────────────────────────────────────────────────────────────

fn list_projects_schema() -> Value {
    // Optional `integration` filter so the model can answer "which
    // projects have capture?" with a server-side filtered response
    // instead of dumping all 16 projects + filtering in-context. Saves
    // tokens AND makes the inspect modal show only the relevant rows.
    // The endpoint already scopes to the user's visible workspaces.
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "integration": {
                "type": "string",
                "description": "Optional. Filter to projects where this integration is active. \
                                Pass when the user asks about a specific integration: \
                                \"capture\" (the @inariwatch/capture SDK), \
                                \"github\", \"vercel\", \"agent\" (the eBPF kernel agent), \
                                \"datadog\", \"expo\", \"sentry\". Omit for the full project list."
            }
        }
    })
}

fn get_project_health_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["project_id"],
        "properties": {
            "project_id": {
                "type": "string",
                "description": "Project id from cloud.list_projects (UUID).",
                "minLength": 1,
                "maxLength": 64
            }
        }
    })
}

fn get_workspace_summary_schema() -> Value {
    // Same rationale as list_projects — no parameters today.
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {}
    })
}

/// `cloud.list_projects` — enumerate the user's projects with their
/// active integration services so the agent can answer questions like
/// "which projects have capture?" without further round-trips.
pub struct ListProjectsTool {
    meta: ToolMeta,
    backend: Arc<dyn CloudApiBackend>,
}

impl ListProjectsTool {
    pub fn new(backend: Arc<dyn CloudApiBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "cloud.list_projects".into(),
                description:
                    "List projects visible to the signed-in user across all workspaces, with \
                     each project's active integration services (e.g. \"vercel\", \"github\", \
                     \"capture\"). \
                     IMPORTANT: when the user asks about ONE specific integration \
                     (\"which projects have capture\" / \"how many use vercel\"), pass that \
                     name as `integration` so the response is pre-filtered server-side — \
                     much cheaper and the inspect modal stays scannable. \
                     Omit `integration` only when the user wants the full project list. \
                     Read-only; safe."
                        .into(),
                params_schema: list_projects_schema(),
                default_permission: PermissionLevel::Auto,
            },
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for ListProjectsTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        // Optional `integration` filter — when set, the endpoint returns
        // only projects where this integration is active. Validates the
        // value as `[a-z_]+` before building the URL: this is a closed
        // set (capture/github/vercel/agent/datadog/expo/sentry) so any
        // other shape is either a typo or a probe — refuse rather than
        // smuggling it onto the wire.
        let integration = invocation
            .args
            .get("integration")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(svc) = integration {
            if !svc.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                return Err(ToolError::InvalidArgs(
                    "integration must be lowercase ascii (e.g. \"capture\", \"github\", \"vercel\")".into(),
                ));
            }
        }
        let path = match integration {
            Some(svc) => format!("/api/desktop/projects?integration={svc}"),
            None => "/api/desktop/projects".to_string(),
        };
        let body = self
            .backend
            .get_json(&path)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        // The endpoint returns 14 fields per project for Settings →
        // Projects, but the LLM only needs identity + integration list to
        // answer "which projects have X" / "what's the state of Y" style
        // questions. Project to a 5-field slim shape: drops `slug`
        // (derived from name), `framework`/`host` (mostly null),
        // `organizationId` (opaque UUID — `workspaceName` already
        // carries the human label), `createdAt`/`lastActivityAt`
        // (timestamps rarely material to the user's question). `id` is
        // preserved because `cloud.get_project_health` takes it as a
        // follow-up arg. This drops the response by ~64% — saves model
        // tokens, makes the inspect modal scannable, and the model still
        // has every field it needs.
        let slim_projects: Vec<Value> = body
            .get("projects")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|p| {
                        json!({
                            "id":            p.get("id"),
                            "name":          p.get("name"),
                            "state":         p.get("state"),
                            "workspaceName": p.get("workspaceName"),
                            "integrations":  p.get("integrations"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let count = slim_projects.len();
        Ok(ToolOutput {
            value: json!({ "projects": slim_projects }),
            summary: Some(format!(
                "Found {count} project{}",
                if count == 1 { "" } else { "s" }
            )),
        })
    }
}

/// `cloud.get_project_health` — snapshot of one project (24h alerts by
/// severity, uptime, last deploy, active integrations).
pub struct GetProjectHealthTool {
    meta: ToolMeta,
    backend: Arc<dyn CloudApiBackend>,
}

impl GetProjectHealthTool {
    pub fn new(backend: Arc<dyn CloudApiBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "cloud.get_project_health".into(),
                description:
                    "Get a health snapshot of one project: alerts (24h, by severity), uptime \
                     monitors, last deploy, active integrations. Pass the project's UUID id \
                     (use cloud.list_projects first if you don't have it). Read-only; safe."
                        .into(),
                params_schema: get_project_health_schema(),
                default_permission: PermissionLevel::Auto,
            },
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for GetProjectHealthTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let project_id = invocation
            .args
            .get("project_id")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArgs("missing project_id".into()))?;
        // Defense-in-depth: reject path-traversal-shaped ids before we
        // ever build the URL. The endpoint also rejects unknown ids
        // with a 404, but this short-circuits an obvious attack.
        if project_id.contains('/') || project_id.contains('?') || project_id.contains('#') {
            return Err(ToolError::InvalidArgs(
                "project_id must be a plain UUID (no '/', '?', '#')".into(),
            ));
        }
        let path = format!("/api/desktop/projects/{}/health", project_id);
        let body = self
            .backend
            .get_json(&path)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let name = body
            .get("projectName")
            .and_then(Value::as_str)
            .unwrap_or(project_id)
            .to_string();
        let state = body
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        Ok(ToolOutput {
            value: body,
            summary: Some(format!("Health of {name}: {state}")),
        })
    }
}

/// `cloud.get_workspace_summary` — aggregate one-liner across all
/// visible projects (24h alerts, uptime, on-call, top noisy project).
pub struct GetWorkspaceSummaryTool {
    meta: ToolMeta,
    backend: Arc<dyn CloudApiBackend>,
}

impl GetWorkspaceSummaryTool {
    pub fn new(backend: Arc<dyn CloudApiBackend>) -> Self {
        Self {
            meta: ToolMeta {
                name: "cloud.get_workspace_summary".into(),
                description:
                    "Aggregate workspace dashboard: total alerts (24h), monitors down, top noisy \
                     project, and the currently on-call primary. Call this for open-ended \
                     'how are things?' style questions. Read-only; safe."
                        .into(),
                params_schema: get_workspace_summary_schema(),
                default_permission: PermissionLevel::Auto,
            },
            backend,
        }
    }
}

#[async_trait]
impl ChatTool for GetWorkspaceSummaryTool {
    fn meta(&self) -> &ToolMeta {
        &self.meta
    }

    async fn execute(&self, _invocation: &ToolInvocation) -> Result<ToolOutput, ToolError> {
        let body = self
            .backend
            .get_json("/api/desktop/workspace-summary")
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let total = body
            .get("totalAlerts24h")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let monitors_down = body
            .get("monitorsDown")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let summary = if monitors_down > 0 {
            format!("Workspace: {total} alerts 24h, {monitors_down} monitor(s) down")
        } else {
            format!("Workspace: {total} alerts 24h, monitors healthy")
        };
        Ok(ToolOutput {
            value: body,
            summary: Some(summary),
        })
    }
}

// ── Catalog + register ──────────────────────────────────────────────────────

pub fn catalog() -> Vec<ToolMeta> {
    let placeholder = Arc::new(mocks_placeholder::NoopCloudApi);
    vec![
        ListProjectsTool::new(placeholder.clone()).meta().clone(),
        GetProjectHealthTool::new(placeholder.clone()).meta().clone(),
        GetWorkspaceSummaryTool::new(placeholder).meta().clone(),
    ]
}

/// Internal placeholder backend used only by [`catalog`]. Never executed.
mod mocks_placeholder {
    use super::*;

    pub(super) struct NoopCloudApi;
    #[async_trait]
    impl CloudApiBackend for NoopCloudApi {
        async fn get_json(&self, _path: &str) -> Result<Value, String> {
            Err("placeholder: do not invoke".into())
        }
    }
}

pub fn register_cloud_tools(
    reg: &ToolRegistry,
    backends: CloudBackends,
) -> Result<(), RegistryError> {
    reg.register(Arc::new(ListProjectsTool::new(backends.api.clone())))?;
    reg.register(Arc::new(GetProjectHealthTool::new(backends.api.clone())))?;
    reg.register(Arc::new(GetWorkspaceSummaryTool::new(backends.api)))?;
    Ok(())
}

// ── Mocks (gated) ───────────────────────────────────────────────────────────

#[cfg(any(test, feature = "agent-test-utils"))]
pub mod mocks {
    //! Test-only backend impls. Same gating policy as the comm + local
    //! exec clusters — never compiled by `cargo build` of the
    //! bin/cdylib because a `MockCloudApiBackend` that fabricates a
    //! `{ projects: [...] }` payload is exactly the kind of object you
    //! do NOT want to wire into production by accident.
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MockCloudApiBackend {
        inner: Mutex<MockCloudApiState>,
    }

    #[derive(Default)]
    struct MockCloudApiState {
        /// Path → JSON to return. Path matched verbatim — the test fixes
        /// the path the tool builds, so an off-by-one in the tool
        /// surfaces as a `path not registered` error.
        responses: HashMap<String, Value>,
        calls: Vec<String>,
        next_error: Option<String>,
    }

    impl MockCloudApiBackend {
        pub fn new() -> Self {
            Self::default()
        }
        pub fn set(&self, path: impl Into<String>, body: Value) {
            self.inner.lock().unwrap().responses.insert(path.into(), body);
        }
        pub fn fail_next(&self, msg: impl Into<String>) {
            self.inner.lock().unwrap().next_error = Some(msg.into());
        }
        pub fn calls(&self) -> Vec<String> {
            self.inner.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl CloudApiBackend for MockCloudApiBackend {
        async fn get_json(&self, path: &str) -> Result<Value, String> {
            let mut s = self.inner.lock().unwrap();
            s.calls.push(path.to_string());
            if let Some(err) = s.next_error.take() {
                return Err(err);
            }
            s.responses
                .get(path)
                .cloned()
                .ok_or_else(|| format!("mock: path not registered: {path}"))
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::mocks::*;
    use super::*;

    fn invocation(name: &str, args: Value) -> ToolInvocation {
        ToolInvocation {
            id: "test-id".into(),
            tool_name: name.into(),
            args,
            session_id: None,
        }
    }

    // ── list_projects ───────────────────────────────────────────────────────

    #[test]
    fn list_projects_meta_is_auto_with_optional_integration_filter() {
        let tool = ListProjectsTool::new(Arc::new(MockCloudApiBackend::new()));
        assert_eq!(tool.meta().name, "cloud.list_projects");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Auto);
        // No required args — the integration filter is optional.
        let required = tool.meta().params_schema["required"].as_array();
        assert!(
            required.is_none() || required.unwrap().is_empty(),
            "list_projects must not require any args (integration is optional)"
        );
        // The optional `integration` filter must be advertised so the
        // model knows to use it for "which projects have X" questions.
        let integration =
            &tool.meta().params_schema["properties"]["integration"];
        assert_eq!(
            integration.get("type").and_then(Value::as_str),
            Some("string"),
            "integration property must be declared as string; got {integration}"
        );
        assert!(
            integration.get("description").and_then(Value::as_str).is_some(),
            "integration property must have a description so the model knows when to use it"
        );
    }

    #[tokio::test]
    async fn list_projects_projects_to_essentials_dropping_bloat() {
        let backend = Arc::new(MockCloudApiBackend::new());
        // Endpoint returns the full 14-field shape (used by Settings →
        // Projects panel). Tool slims to 5 essential fields for the LLM.
        backend.set(
            "/api/desktop/projects",
            json!({
                "projects": [
                    {
                        "id":             "p-1",
                        "name":           "Web",
                        "slug":           "web-abc",
                        "state":          "live",
                        "framework":      "nextjs",
                        "host":           "vercel",
                        "organizationId": "org-uuid-xyz",
                        "workspaceName":  "BERNAL ORG",
                        "createdAt":      "2026-01-01T00:00:00Z",
                        "lastActivityAt": "2026-05-14T20:00:00Z",
                        "integrations":   ["vercel", "capture"]
                    },
                ]
            }),
        );
        let tool = ListProjectsTool::new(backend.clone());
        let out = tool
            .execute(&invocation("cloud.list_projects", json!({})))
            .await
            .expect("ok");
        let arr = out.value["projects"].as_array().expect("projects array");
        assert_eq!(arr.len(), 1);
        let p = &arr[0];
        // Kept fields — the LLM uses these to answer "which projects
        // have X" + identifies projects for follow-up health calls.
        assert_eq!(p["id"], "p-1");
        assert_eq!(p["name"], "Web");
        assert_eq!(p["state"], "live");
        assert_eq!(p["workspaceName"], "BERNAL ORG");
        assert_eq!(p["integrations"], json!(["vercel", "capture"]));
        // Dropped fields — assert via keyset because `Value::index` returns
        // Value::Null for both missing keys and present-with-null values.
        let obj = p.as_object().expect("project must be an object");
        assert_eq!(
            obj.len(),
            5,
            "slim shape must be exactly 5 fields, got {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        for dropped in [
            "slug",
            "framework",
            "host",
            "organizationId",
            "createdAt",
            "lastActivityAt",
        ] {
            assert!(
                !obj.contains_key(dropped),
                "field `{dropped}` should be dropped from the slim shape"
            );
        }
        // Summary mentions the count.
        assert!(out.summary.as_deref().unwrap_or("").contains("1"));
        // Exactly one backend call — no fanout.
        assert_eq!(backend.calls(), vec!["/api/desktop/projects".to_string()]);
    }

    #[tokio::test]
    async fn list_projects_translates_backend_error_to_execution_failed() {
        let backend = Arc::new(MockCloudApiBackend::new());
        backend.fail_next("not paired with the cloud: sign in via Settings → Account");
        let tool = ListProjectsTool::new(backend);
        let err = tool
            .execute(&invocation("cloud.list_projects", json!({})))
            .await
            .expect_err("must fail");
        match err {
            ToolError::ExecutionFailed(m) => assert!(m.contains("not paired")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_projects_passes_integration_filter_to_url() {
        let backend = Arc::new(MockCloudApiBackend::new());
        backend.set(
            "/api/desktop/projects?integration=capture",
            json!({
                "projects": [
                    {
                        "id":             "p-demo",
                        "name":           "DEMO",
                        "state":          "live",
                        "workspaceName":  "BERNAL ORG",
                        "integrations":   ["agent", "capture", "github"]
                    }
                ]
            }),
        );
        let tool = ListProjectsTool::new(backend.clone());
        let out = tool
            .execute(&invocation(
                "cloud.list_projects",
                json!({ "integration": "capture" }),
            ))
            .await
            .expect("ok");
        let arr = out.value["projects"].as_array().expect("projects array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "DEMO");
        // URL must carry the filter — server does the filtering, not us.
        assert_eq!(
            backend.calls(),
            vec!["/api/desktop/projects?integration=capture".to_string()]
        );
    }

    #[tokio::test]
    async fn list_projects_omits_query_string_when_no_filter() {
        let backend = Arc::new(MockCloudApiBackend::new());
        backend.set(
            "/api/desktop/projects",
            json!({ "projects": [] }),
        );
        let tool = ListProjectsTool::new(backend.clone());
        let _ = tool
            .execute(&invocation("cloud.list_projects", json!({})))
            .await
            .expect("ok");
        // Plain URL — no `?integration=` when omitted.
        assert_eq!(
            backend.calls(),
            vec!["/api/desktop/projects".to_string()]
        );
    }

    #[tokio::test]
    async fn list_projects_rejects_malformed_integration_value() {
        let backend = Arc::new(MockCloudApiBackend::new());
        let tool = ListProjectsTool::new(backend.clone());
        // Defense against typos / probes — anything outside [a-z_] is
        // refused before it reaches the wire.
        for bad in [
            "Capture",        // uppercase
            "capture-sdk",    // dash
            "capture sdk",    // space
            "capture?x=1",    // injection attempt
            "capture/admin",  // path traversal
        ] {
            let err = tool
                .execute(&invocation(
                    "cloud.list_projects",
                    json!({ "integration": bad }),
                ))
                .await
                .expect_err(&format!("must reject `{bad}`"));
            assert!(
                matches!(err, ToolError::InvalidArgs(_)),
                "expected InvalidArgs for `{bad}`, got {err:?}"
            );
        }
        // None of the bad values reached the backend.
        assert!(backend.calls().is_empty());
    }

    // ── get_project_health ──────────────────────────────────────────────────

    #[test]
    fn get_project_health_requires_project_id() {
        let tool = GetProjectHealthTool::new(Arc::new(MockCloudApiBackend::new()));
        let req = tool.meta().params_schema["required"]
            .as_array()
            .expect("required");
        assert_eq!(req, &vec![json!("project_id")]);
    }

    #[tokio::test]
    async fn get_project_health_builds_correct_path_and_returns_body() {
        let backend = Arc::new(MockCloudApiBackend::new());
        backend.set(
            "/api/desktop/projects/p-1/health",
            json!({
                "projectId": "p-1",
                "projectName": "Web",
                "state": "warning",
                "alerts24h": { "total": 3, "critical": 0, "warning": 2, "info": 1 },
                "uptime": { "monitorsTotal": 2, "monitorsDown": 0, "avgResponseMs": 187 },
                "lastDeploy": null,
                "integrations": ["vercel", "capture"]
            }),
        );
        let tool = GetProjectHealthTool::new(backend.clone());
        let out = tool
            .execute(&invocation(
                "cloud.get_project_health",
                json!({ "project_id": "p-1" }),
            ))
            .await
            .expect("ok");
        assert_eq!(out.value["state"], "warning");
        assert_eq!(out.value["integrations"], json!(["vercel", "capture"]));
        assert!(out.summary.as_deref().unwrap_or("").contains("Web"));
        assert_eq!(
            backend.calls(),
            vec!["/api/desktop/projects/p-1/health".to_string()],
        );
    }

    #[tokio::test]
    async fn get_project_health_rejects_path_traversal_attempts() {
        let backend = Arc::new(MockCloudApiBackend::new());
        // The agent could be tricked by a malicious tool result earlier
        // in the conversation; the tool itself must reject ids that
        // contain `/` so the LLM can't break out of the path it owns.
        let tool = GetProjectHealthTool::new(backend.clone());
        let err = tool
            .execute(&invocation(
                "cloud.get_project_health",
                json!({ "project_id": "../alerts" }),
            ))
            .await
            .expect_err("must reject");
        match err {
            ToolError::InvalidArgs(m) => assert!(m.contains("plain UUID")),
            other => panic!("unexpected: {other:?}"),
        }
        // Importantly the backend was NEVER called — no leak.
        assert!(backend.calls().is_empty());
    }

    // ── get_workspace_summary ───────────────────────────────────────────────

    #[test]
    fn get_workspace_summary_meta_is_auto_and_has_no_required_args() {
        let tool = GetWorkspaceSummaryTool::new(Arc::new(MockCloudApiBackend::new()));
        assert_eq!(tool.meta().name, "cloud.get_workspace_summary");
        assert_eq!(tool.meta().default_permission, PermissionLevel::Auto);
        let required = tool.meta().params_schema["required"].as_array();
        assert!(
            required.is_none() || required.unwrap().is_empty(),
            "get_workspace_summary must take no args"
        );
    }

    #[tokio::test]
    async fn get_workspace_summary_returns_aggregated_body() {
        let backend = Arc::new(MockCloudApiBackend::new());
        backend.set(
            "/api/desktop/workspace-summary",
            json!({
                "totalAlerts24h": 12,
                "alertsCritical24h": 1,
                "alertsWarning24h": 8,
                "monitorsDown": 0,
                "monitorsTotal": 4,
                "projectCount": 3,
                "topNoisyProject": { "id": "p-1", "name": "Web", "alerts24h": 7 },
                "onCallSummary": null,
                "lastAlertAt": "2026-05-14T10:00:00.000Z"
            }),
        );
        let tool = GetWorkspaceSummaryTool::new(backend);
        let out = tool
            .execute(&invocation("cloud.get_workspace_summary", json!({})))
            .await
            .expect("ok");
        assert_eq!(out.value["totalAlerts24h"], 12);
        // Summary uses the total + monitor count for at-a-glance read.
        let s = out.summary.as_deref().unwrap_or("");
        assert!(s.contains("12"));
        assert!(s.contains("healthy"));
    }

    // ── catalog ─────────────────────────────────────────────────────────────

    #[test]
    fn catalog_returns_three_unique_auto_tools() {
        let metas = catalog();
        assert_eq!(metas.len(), 3);
        let names: std::collections::HashSet<_> =
            metas.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains("cloud.list_projects"));
        assert!(names.contains("cloud.get_project_health"));
        assert!(names.contains("cloud.get_workspace_summary"));
        for m in metas {
            assert_eq!(
                m.default_permission,
                PermissionLevel::Auto,
                "{} must be Auto",
                m.name
            );
        }
    }
}
