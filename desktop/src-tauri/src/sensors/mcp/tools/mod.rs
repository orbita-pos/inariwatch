//! Tool registry — 26 tools ported one-to-one from the hosted MCP
//! server's `web/app/api/mcp/registry.ts` (the SSOT). 5 of them have a
//! real local implementation; the rest are stubs that return a
//! structured "not yet wired" response so an MCP client surfaces a
//! useful message instead of a generic error.
//!
//! Note: CLAUDE.md mentions "25 tools" but the SSOT registry includes
//! `rollback_vercel` as a legacy alias of `rollback_deploy`, bringing
//! the count to 26. We mirror SSOT exactly so a client configured
//! against the hosted server keeps working against the local one.
//!
//! Local-first tools (real implementation):
//!   * `get_status`       — wraps `daemon_status`
//!   * `query_alerts`     — events table query
//!   * `search_codebase`  — delegates to `crate::indexer::semantic` (Session 6); stubbed today
//!   * `reindex_codebase` — emits `DaemonEvent::ReindexRequested`
//!   * `ask_inari`        — sampling-first; returns `_sampling_request`
//!
//! Cloud-proxied / stub tools return a `cloud_only` or `not_yet_wired`
//! McpError so the MCP client renders a clear message.

use std::sync::Arc;

use serde_json::Value;

use crate::daemon::DaemonHandle;
use crate::store::Store;

use super::error::McpError;

pub mod local;
pub mod proxied;
pub mod schemas;

/// Tool execution context. Each tool reads what it needs and ignores
/// the rest. Adding new dependencies is a matter of extending this
/// struct and wiring it through `server::run_tool`.
#[derive(Clone)]
pub struct ToolContext {
    pub store:  Arc<Store>,
    pub daemon: Arc<DaemonHandle>,
}

/// Trait every tool implements. `name()` matches the SSOT; `call()`
/// receives the validated `arguments` object.
pub trait Tool: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn input_schema(&self) -> Value;
    /// Execute. Tools that need shared state read from `ctx`. Long-
    /// running tools should be wrapped at the transport layer; this
    /// trait stays sync to keep the registry simple.
    fn call(&self, args: &Value, ctx: &ToolContext) -> Result<Value, McpError>;
}

/// Build the full registry. Order matches SSOT for stable diffing.
pub fn registry() -> Vec<Box<dyn Tool>> {
    vec![
        // ── Real local tools (5) ───────────────────────────────────
        Box::new(local::query_alerts::QueryAlerts),
        Box::new(local::get_status::GetStatus),
        Box::new(local::search_codebase::SearchCodebase),
        Box::new(local::reindex_codebase::ReindexCodebase),
        Box::new(local::ask_inari::AskInari),

        // ── Cloud-proxied stubs (21 — SSOT minus the 5 real ones) ──
        Box::new(proxied::stub::Stub {
            name:        "get_uptime",
            description: "Get current uptime status for all monitors. \
                          Returns last check result, response time, and \
                          consecutive failures.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::get_uptime(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "get_build_logs",
            description: "Fetch recent Vercel deployment build logs.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::get_build_logs(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "get_substrate_context",
            description: "Retrieve the Substrate I/O recording for an alert.",
            session:     "Session 10 (substrate sensor) + Session 19 (cloud proxy)",
            input_schema: schemas::alert_id_required(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "get_root_cause",
            description: "Root cause analysis of a specific alert (sampling-first).",
            session:     "Session 18 (AI client)",
            input_schema: schemas::alert_id_required(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "assess_risk",
            description: "Pre-deploy risk assessment for a pull request \
                          (sampling-first).",
            session:     "Session 18 (AI client)",
            input_schema: schemas::assess_risk(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "get_postmortem",
            description: "Generate or retrieve a post-mortem for a resolved \
                          alert.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::alert_id_required(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "search_community_fixes",
            description: "Search the InariWatch community fix network.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::search_community_fixes(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "trigger_fix",
            description: "Start the AI remediation pipeline.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::trigger_fix(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "rollback_deploy",
            description: "Roll back a project to its previous successful \
                          production deployment.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::project_required(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "rollback_vercel",
            description: "[Legacy alias for rollback_deploy] Roll back to the \
                          previous deployment.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::project_required(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "silence_alert",
            description: "Mark an alert as read and optionally resolved.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::silence_alert(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "acknowledge_alert",
            description: "Mark an alert as read (acknowledged) without \
                          resolving it.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::alert_id_required(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "reopen_alert",
            description: "Reopen a previously resolved alert.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::alert_id_required(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "submit_feedback",
            description: "Submit feedback on an AI fix.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::submit_feedback(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "run_check",
            description: "Trigger an immediate monitoring check cycle.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::run_check(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "get_error_trends",
            description: "Error trend analysis: alerts per day by severity.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::get_error_trends(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "create_uptime_monitor",
            description: "Create a new uptime monitor for a URL.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::create_uptime_monitor(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "run_health_check",
            description: "Run a complete health check of the InariWatch \
                          installation.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::empty(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "reproduce_bug",
            description: "Reproduce a production bug using Substrate I/O \
                          recording.",
            session:     "Session 10 (substrate sensor) + Session 19 (cloud proxy)",
            input_schema: schemas::reproduce_bug(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "simulate_fix",
            description: "Simulate whether a proposed fix would resolve a bug.",
            session:     "Session 10 (substrate sensor) + Session 18 (AI client)",
            input_schema: schemas::simulate_fix(),
        }),
        Box::new(proxied::stub::Stub {
            name:        "verify_remediation",
            description: "Verify the full remediation chain for an alert.",
            session:     "Session 19 (cloud proxy)",
            input_schema: schemas::alert_id_required(),
        }),
    ]
}
