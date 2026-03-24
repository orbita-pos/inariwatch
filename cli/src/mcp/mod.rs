pub mod escalation;
pub mod fingerprint;
pub mod post_merge_monitor;
pub mod progress;
pub mod safety;
pub mod tools;

use serde_json::{json, Value};

/// Return the full tool list for MCP tools/list.
pub fn tools_list() -> Value {
    json!([
        {
            "name": "query_alerts",
            "description": "Query recent alerts from the local InariWatch database. Returns alerts with severity, title, body, sources, and timestamps.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Filter by project slug. Omit to return alerts across all projects."
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "warning", "info"],
                        "description": "Filter by severity level."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Max number of alerts to return (default: 20, max: 100)."
                    }
                }
            }
        },
        {
            "name": "get_status",
            "description": "List all configured projects and their active integrations (GitHub, Vercel, Sentry, Git).",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "run_check",
            "description": "Run one monitoring cycle right now and return any new alerts found. Checks GitHub CI, Vercel deployments, Sentry errors, and local git branches.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project name or slug to check. Omit to use the current directory project."
                    }
                }
            }
        },
        {
            "name": "get_root_cause",
            "description": "Deep AI-powered root cause analysis of a specific alert. Gathers context from Sentry stack traces, Vercel build logs, and GitHub CI logs, then uses AI to diagnose the issue. Returns structured analysis with confidence score, impact assessment, suggested fix, and prevention steps.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "alert_id": {
                        "type": "string",
                        "description": "The alert ID to analyze. Use query_alerts to find alert IDs."
                    },
                    "include_context": {
                        "type": "boolean",
                        "description": "If true, also gathers context from Sentry/Vercel/GitHub APIs. Default: true."
                    }
                },
                "required": ["alert_id"]
            }
        },
        {
            "name": "trigger_fix",
            "description": "Autonomous AI remediation pipeline. Diagnoses the alert, reads relevant source code, generates a fix, self-reviews it, pushes a branch, waits for CI, creates a PR, and optionally auto-merges. Safety guards: file blocklist prevents touching .env/locks/CI configs, confidence < 30% aborts, self-review can reject. This tool may take several minutes (CI wait + optional 10-min post-merge monitoring). Use dry_run=true to preview without side effects.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "alert_id": {
                        "type": "string",
                        "description": "The alert ID to fix."
                    },
                    "project": {
                        "type": "string",
                        "description": "Project slug. If omitted, auto-detected from the alert."
                    },
                    "auto_merge": {
                        "type": "boolean",
                        "description": "If true, auto-merge the PR when all safety gates pass. Default: false (creates draft PR)."
                    },
                    "max_attempts": {
                        "type": "number",
                        "description": "Max CI retry attempts if the first fix fails. Default: 2, max: 3."
                    },
                    "dry_run": {
                        "type": "boolean",
                        "description": "If true, diagnose and generate the fix but do NOT push or create a PR. Returns proposed changes. Default: false."
                    }
                },
                "required": ["alert_id"]
            }
        },
        {
            "name": "get_postmortem",
            "description": "Generate or retrieve a post-mortem document for a resolved alert. Returns a structured markdown document with Summary, Timeline, Root Cause, Impact, Resolution, and Prevention Measures. If a postmortem was already generated, returns the stored version.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "alert_id": {
                        "type": "string",
                        "description": "The alert ID to generate/retrieve the post-mortem for."
                    }
                },
                "required": ["alert_id"]
            }
        },
        {
            "name": "rollback_vercel",
            "description": "Roll back a Vercel project to a previous production deployment. If no deployment_id is given, automatically selects the last successful production deployment. Returns the deployment that was promoted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project name or slug. Omit to use the current directory project."
                    },
                    "deployment_id": {
                        "type": "string",
                        "description": "Specific deployment ID to roll back to. Omit to auto-select the last successful production deployment."
                    }
                }
            }
        },
        {
            "name": "get_build_logs",
            "description": "Fetch Vercel deployment build logs. Returns the build output with error summary. Useful for understanding why a deployment failed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project name or slug."
                    },
                    "deployment_id": {
                        "type": "string",
                        "description": "Specific deployment ID. Omit to fetch the latest failed deployment's logs."
                    }
                }
            }
        },
        {
            "name": "silence_alert",
            "description": "Mark an alert as read and optionally resolved in the local database. Use this after investigating an alert that does not require action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "alert_id": {
                        "type": "string",
                        "description": "The alert ID to silence."
                    },
                    "resolve": {
                        "type": "boolean",
                        "description": "If true, mark as resolved (not just read). Default: true."
                    }
                },
                "required": ["alert_id"]
            }
        }
    ])
}

/// Dispatch a tools/call to the appropriate handler.
pub async fn call_tool(name: &str, args: &Value) -> anyhow::Result<String> {
    match name {
        "query_alerts"    => tools::query_alerts::execute(args).await,
        "get_status"      => tools::get_status::execute(args).await,
        "run_check"       => tools::run_check::execute(args).await,
        "get_root_cause"  => tools::get_root_cause::execute(args).await,
        "get_postmortem"  => tools::get_postmortem::execute(args).await,
        "trigger_fix"     => tools::trigger_fix::execute(args).await,
        "rollback_vercel" => tools::rollback_vercel::execute(args).await,
        "get_build_logs"  => tools::get_build_logs::execute(args).await,
        "silence_alert"   => tools::silence_alert::execute(args).await,
        _ => Err(anyhow::anyhow!("Unknown tool: {}", name)),
    }
}

/// Handle a full JSON-RPC message and return the response.
pub fn dispatch_message(method: &str, id: Option<Value>, msg: &Value) -> Option<DispatchAction> {
    match method {
        // Notifications — no response
        m if m.starts_with("notifications/") => None,

        "initialize" => Some(DispatchAction::Immediate(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "inariwatch",
                    "version": format!("{}-mcp-v2", env!("CARGO_PKG_VERSION"))
                }
            }
        }))),

        "tools/list" => Some(DispatchAction::Immediate(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tools_list() }
        }))),

        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
            let args = msg["params"]["arguments"].clone();
            Some(DispatchAction::ToolCall { id, name, args })
        }

        "ping" => Some(DispatchAction::Immediate(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }))),

        _ => Some(DispatchAction::Immediate(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "Method not found" }
        }))),
    }
}

pub enum DispatchAction {
    /// Send immediately, no async work needed.
    Immediate(Value),
    /// Call a tool (async), then format the result.
    ToolCall { id: Option<Value>, name: String, args: Value },
}

/// Format a tool call result into a JSON-RPC response.
pub fn format_tool_result(id: Option<Value>, result: anyhow::Result<String>) -> Value {
    match result {
        Ok(text) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "content": [{ "type": "text", "text": text }] }
        }),
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": format!("Error: {}", e) }],
                "isError": true
            }
        }),
    }
}
