//! JSON-Schema literals ported from `web/app/api/mcp/registry.ts`.
//!
//! Keeping these as small `serde_json::json!` builders keeps the
//! registry definitions readable and lets us share commonly-shaped
//! schemas (`alert_id_required`, `project_required`, `empty`).

use serde_json::{json, Value};

pub fn empty() -> Value {
    json!({ "type": "object", "properties": {} })
}

pub fn alert_id_required() -> Value {
    json!({
        "type": "object",
        "properties": {
            "alert_id": { "type": "string", "description": "The alert ID." }
        },
        "required": ["alert_id"]
    })
}

pub fn project_required() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project": { "type": "string", "description": "Project slug." }
        },
        "required": ["project"]
    })
}

pub fn query_alerts() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project":  { "type": "string", "description": "Filter by project slug." },
            "severity": {
                "type": "string",
                "enum": ["critical", "warning", "info"],
                "description": "Filter by severity level."
            },
            "limit":    { "type": "number", "description": "Max alerts to return (default: 20, max: 100)." }
        }
    })
}

pub fn get_uptime() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project": { "type": "string", "description": "Filter to a specific project slug." }
        }
    })
}

pub fn get_build_logs() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project":       { "type": "string", "description": "Project slug." },
            "deployment_id": { "type": "string", "description": "Specific deployment ID. Omit to get the latest." }
        }
    })
}

pub fn assess_risk() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project":   { "type": "string", "description": "Project slug." },
            "pr_number": { "type": "number", "description": "PR number to assess." }
        },
        "required": ["project", "pr_number"]
    })
}

pub fn search_community_fixes() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Error message or description to search for." },
            "limit": { "type": "number", "description": "Max patterns to return (default: 5, max: 20)." }
        },
        "required": ["query"]
    })
}

pub fn trigger_fix() -> Value {
    json!({
        "type": "object",
        "properties": {
            "alert_id":   { "type": "string",  "description": "The alert ID to fix." },
            "project":    { "type": "string",  "description": "Project slug." },
            "dry_run":    { "type": "boolean", "description": "If true, preview the fix without pushing. Default: false." },
            "auto_merge": { "type": "boolean", "description": "Auto-merge when safety gates pass. Default: false." }
        },
        "required": ["alert_id"]
    })
}

pub fn silence_alert() -> Value {
    json!({
        "type": "object",
        "properties": {
            "alert_id": { "type": "string",  "description": "The alert ID." },
            "resolve":  { "type": "boolean", "description": "If true, also mark as resolved. Default: true." }
        },
        "required": ["alert_id"]
    })
}

pub fn submit_feedback() -> Value {
    json!({
        "type": "object",
        "properties": {
            "session_id": { "type": "string",  "description": "The remediation session ID." },
            "worked":     { "type": "boolean", "description": "Whether the fix resolved the issue." }
        },
        "required": ["session_id", "worked"]
    })
}

pub fn run_check() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project": { "type": "string", "description": "Project slug. Omit to check all." }
        }
    })
}

pub fn ask_inari() -> Value {
    json!({
        "type": "object",
        "properties": {
            "question": { "type": "string", "description": "Natural language question." }
        },
        "required": ["question"]
    })
}

pub fn get_error_trends() -> Value {
    json!({
        "type": "object",
        "properties": {
            "days":    { "type": "number", "description": "Number of days to analyze (default: 7, max: 30)." },
            "project": { "type": "string", "description": "Filter to a specific project slug." }
        }
    })
}

pub fn create_uptime_monitor() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url":             { "type": "string", "description": "Public URL to monitor." },
            "project":         { "type": "string", "description": "Project slug to attach the monitor to." },
            "name":            { "type": "string", "description": "Display name for the monitor." },
            "interval_sec":    { "type": "number", "description": "Check interval in seconds (default: 60, min: 30, max: 3600)." },
            "expected_status": { "type": "number", "description": "Expected HTTP status code (default: 200)." }
        },
        "required": ["url", "project"]
    })
}

pub fn reproduce_bug() -> Value {
    json!({
        "type": "object",
        "properties": {
            "alert_id": { "type": "string",  "description": "The alert ID to reproduce." },
            "verbose":  { "type": "boolean", "description": "If true, show full request/response bodies. Default: false." }
        },
        "required": ["alert_id"]
    })
}

pub fn simulate_fix() -> Value {
    json!({
        "type": "object",
        "properties": {
            "alert_id":        { "type": "string", "description": "The alert ID with a Substrate recording." },
            "fix_description": { "type": "string", "description": "Description of the proposed fix." }
        },
        "required": ["alert_id", "fix_description"]
    })
}

pub fn search_codebase() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query":   { "type": "string", "description": "What to search for — error message, function name, concept." },
            "project": { "type": "string", "description": "Project slug (optional, searches all if omitted)." },
            "limit":   { "type": "number", "description": "Max results to return (default: 5, max: 10)." }
        },
        "required": ["query"]
    })
}

pub fn reindex_codebase() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project": { "type": "string", "description": "Project slug." }
        },
        "required": ["project"]
    })
}
