pub mod escalation;
pub mod fingerprint;
pub mod post_merge_monitor;
pub mod progress;
pub mod safety;

// NOTE: The MCP server (serve-mcp) has been removed.
// All MCP tools are now hosted at https://mcp.inariwatch.com (web/app/api/mcp/).
// The modules above are kept because they are used by watch, dev, and other CLI commands.
