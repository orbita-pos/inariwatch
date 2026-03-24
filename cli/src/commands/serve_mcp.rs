use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::mcp::{self, DispatchAction};

pub async fn run() -> Result<()> {
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    let mut line = String::new();

    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            break; // EOF — client disconnected
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let method = msg["method"].as_str().unwrap_or("").to_string();
        let id = msg.get("id").cloned();

        let response = match mcp::dispatch_message(&method, id, &msg) {
            None => continue, // notification — no response
            Some(DispatchAction::Immediate(v)) => v,
            Some(DispatchAction::ToolCall { id, name, args }) => {
                let result = mcp::call_tool(&name, &args).await;
                mcp::format_tool_result(id, result)
            }
        };

        let mut out = serde_json::to_string(&response)?;
        out.push('\n');
        stdout.write_all(out.as_bytes()).await?;
        stdout.flush().await?;
    }

    Ok(())
}
