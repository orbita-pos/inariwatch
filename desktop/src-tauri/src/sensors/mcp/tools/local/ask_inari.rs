//! `ask_inari` — local sampling-first. The hosted MCP server returns
//! a `_sampling_request` so the client LLM does the analysis (the
//! server makes ZERO AI calls). We mirror that pattern here: gather
//! context (daemon snapshot + recent local events) and ask the client
//! to reason over it. No OpenAI key is consumed.

use serde_json::{json, Value};

use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

pub struct AskInari;

impl Tool for AskInari {
    fn name(&self) -> &'static str { "ask_inari" }

    fn description(&self) -> &'static str {
        "Ask Inari Live a natural language question about your local \
         repo + daemon state. Uses sampling-first: returns a sampling \
         request the calling MCP client's LLM completes locally. \
         Inari Live makes zero AI calls; your client's API key (or \
         Inari's free platform key, if connected) covers the cost."
    }

    fn input_schema(&self) -> Value {
        super::super::schemas::ask_inari()
    }

    fn call(&self, args: &Value, ctx: &ToolContext) -> Result<Value, McpError> {
        let question = args
            .get("question")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::InvalidParams {
                message: "`question` is required and must be a string".to_string(),
            })?;

        let snap = ctx.daemon.state.snapshot();
        let context_text = format!(
            "DAEMON STATE\n  uptime_secs:  {}\n  sensor_count: {}\n  repo_count:   {}\n",
            snap.uptime_secs, snap.sensor_count, snap.repo_count
        );

        Ok(json!({
            "content": [{
                "type": "text",
                "text": "Sampling request returned. Your MCP client's LLM should \
                         answer using the included context. Inari Live made no AI \
                         calls."
            }],
            "isError": false,
            "_sampling_request": {
                "messages": [
                    { "role": "user", "content": { "type": "text", "text": question } }
                ],
                "system_prompt": "You are Inari, the Inari Live developer companion. \
                                  Answer based ONLY on the provided context — do not \
                                  speculate. If you can't answer with what you have, \
                                  say so and ask for the specific data you need.",
                "context": {
                    "daemon": context_text,
                    "question": question,
                },
                "model_preferences": {
                    "intelligencePriority": 0.6,
                    "speedPriority": 0.4
                }
            }
        }))
    }
}
