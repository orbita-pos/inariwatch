//! Auto-config helpers — write the right snippet to each editor's MCP
//! config so Claude Code / Codex CLI / Cursor / Zed see Inari Live as
//! a server named `inari-live`.
//!
//! Idempotent: if an entry with the same name + same command + same
//! args already exists, we leave the file alone and return
//! `Unchanged`. If it exists with different settings, we overwrite
//! after backing up to `<file>.bak.<timestamp>`. If the file is
//! missing, we create it.
//!
//! Each install writes the `inari-mcp-stdio` sidecar invocation —
//! NEVER the daemon itself. Editors don't need to know about the
//! HTTP port; the sidecar reads it from the local `auth.json`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum McpClient {
    ClaudeCode,
    Codex,
    Cursor,
    Zed,
}

impl McpClient {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude-code" | "claude" => Some(Self::ClaudeCode),
            "codex"                  => Some(Self::Codex),
            "cursor"                 => Some(Self::Cursor),
            "zed"                    => Some(Self::Zed),
            _                        => None,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex      => "codex",
            Self::Cursor     => "cursor",
            Self::Zed        => "zed",
        }
    }
}

/// Outcome of an install / uninstall attempt. Returned to the UI so
/// the Settings screen can show "Inari Live wired into Claude Code"
/// vs. "Already wired (no change)".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum InstallOutcome {
    Created  { path: String },
    Updated  { path: String, backup: String },
    Unchanged { path: String },
    Removed  { path: String },
    NotInstalled { path: String },
}

/// Where the editor expects its MCP config file. We pass `home` so
/// tests can run against a tempdir without monkey-patching the
/// process env.
pub fn config_path(home: &Path, client: McpClient) -> PathBuf {
    match client {
        McpClient::ClaudeCode => home.join(".claude").join("mcp.json"),
        McpClient::Codex      => home.join(".codex").join("mcp.json"),
        McpClient::Cursor     => home.join(".cursor").join("mcp.json"),
        McpClient::Zed        => home.join(".config").join("zed").join("settings.json"),
    }
}

const SERVER_NAME: &str = "inari-live";

/// Build the snippet to inject. The shape varies per client because
/// each one normalised its config schema slightly differently. We
/// match each ecosystem's documented format verbatim.
fn build_entry(sidecar_path: &Path) -> Value {
    let path_str = sidecar_path.display().to_string();
    json!({
        "command": path_str,
        "args":    [],
        "env":     {},
    })
}

pub fn install_for(
    home: &Path,
    client: McpClient,
    sidecar_path: &Path,
) -> std::io::Result<InstallOutcome> {
    let path  = config_path(home, client);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let entry = build_entry(sidecar_path);

    let existing: Value = if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        match serde_json::from_str(&raw) {
            Ok(v)  => v,
            Err(_) => Value::Object(Map::new()),
        }
    } else {
        Value::Object(Map::new())
    };

    let (mut root, key) = match client {
        McpClient::ClaudeCode | McpClient::Codex | McpClient::Cursor => {
            let map = existing.as_object().cloned().unwrap_or_default();
            (map, "mcpServers")
        }
        McpClient::Zed => {
            let map = existing.as_object().cloned().unwrap_or_default();
            (map, "context_servers")
        }
    };

    let mut servers = root
        .get(key)
        .cloned()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let already_correct = servers
        .get(SERVER_NAME)
        .map(|v| v == &entry)
        .unwrap_or(false);

    if already_correct {
        return Ok(InstallOutcome::Unchanged {
            path: path.display().to_string(),
        });
    }

    let was_present = servers.contains_key(SERVER_NAME);
    servers.insert(SERVER_NAME.to_string(), entry);
    root.insert(key.to_string(), Value::Object(servers));
    let new_raw = serde_json::to_string_pretty(&Value::Object(root))?;

    let outcome = if path.exists() {
        // Back up only if file existed AND we're modifying.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let backup = path.with_extension(format!("json.bak.{now_ms}"));
        std::fs::copy(&path, &backup)?;
        std::fs::write(&path, new_raw)?;
        if was_present {
            InstallOutcome::Updated {
                path:   path.display().to_string(),
                backup: backup.display().to_string(),
            }
        } else {
            // File existed (other servers in it) but we just added a
            // new entry — still counts as Updated so the UI shows
            // the backup path.
            InstallOutcome::Updated {
                path:   path.display().to_string(),
                backup: backup.display().to_string(),
            }
        }
    } else {
        std::fs::write(&path, new_raw)?;
        InstallOutcome::Created { path: path.display().to_string() }
    };

    Ok(outcome)
}

pub fn uninstall_for(home: &Path, client: McpClient) -> std::io::Result<InstallOutcome> {
    let path = config_path(home, client);
    if !path.exists() {
        return Ok(InstallOutcome::NotInstalled {
            path: path.display().to_string(),
        });
    }
    let raw = std::fs::read_to_string(&path)?;
    let mut root: Map<String, Value> = match serde_json::from_str(&raw) {
        Ok(Value::Object(m)) => m,
        _ => return Ok(InstallOutcome::NotInstalled {
            path: path.display().to_string(),
        }),
    };
    let key = match client {
        McpClient::ClaudeCode | McpClient::Codex | McpClient::Cursor => "mcpServers",
        McpClient::Zed                                              => "context_servers",
    };
    let mut servers = root
        .get(key)
        .cloned()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if servers.remove(SERVER_NAME).is_none() {
        return Ok(InstallOutcome::NotInstalled {
            path: path.display().to_string(),
        });
    }
    if servers.is_empty() {
        root.remove(key);
    } else {
        root.insert(key.to_string(), Value::Object(servers));
    }
    let new_raw = serde_json::to_string_pretty(&Value::Object(root))?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup = path.with_extension(format!("json.bak.{now_ms}"));
    std::fs::copy(&path, &backup)?;
    std::fs::write(&path, new_raw)?;
    Ok(InstallOutcome::Removed { path: path.display().to_string() })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientStatus {
    pub client:    String,
    pub installed: bool,
    pub path:      String,
    /// True when an entry exists AND matches the current sidecar
    /// command. When it's installed but stale (e.g. the sidecar moved
    /// after an upgrade) the UI prompts the user to re-install.
    pub matches_current: bool,
}

pub fn status_for(home: &Path, client: McpClient, sidecar_path: &Path) -> ClientStatus {
    let path = config_path(home, client);
    let entry = build_entry(sidecar_path);
    let installed = path.exists();
    let matches_current = if installed {
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let key = match client {
            McpClient::ClaudeCode | McpClient::Codex | McpClient::Cursor => "mcpServers",
            McpClient::Zed                                              => "context_servers",
        };
        value
            .get(key)
            .and_then(|v| v.get(SERVER_NAME))
            .map(|v| v == &entry)
            .unwrap_or(false)
    } else {
        false
    };
    ClientStatus {
        client:          client.slug().to_string(),
        installed:       installed && matches_current,
        path:            path.display().to_string(),
        matches_current,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_path_per_client() {
        let home = Path::new("/tmp/h");
        assert_eq!(
            config_path(home, McpClient::ClaudeCode),
            Path::new("/tmp/h/.claude/mcp.json")
        );
        assert_eq!(
            config_path(home, McpClient::Codex),
            Path::new("/tmp/h/.codex/mcp.json")
        );
        assert_eq!(
            config_path(home, McpClient::Cursor),
            Path::new("/tmp/h/.cursor/mcp.json")
        );
        assert_eq!(
            config_path(home, McpClient::Zed),
            Path::new("/tmp/h/.config/zed/settings.json")
        );
    }

    #[test]
    fn install_idempotent_for_claude() {
        let home = tempfile::tempdir().unwrap();
        let sidecar = std::env::temp_dir().join("inari-mcp-stdio");
        let a = install_for(home.path(), McpClient::ClaudeCode, &sidecar).unwrap();
        let b = install_for(home.path(), McpClient::ClaudeCode, &sidecar).unwrap();
        assert!(matches!(a, InstallOutcome::Created { .. }));
        assert!(matches!(b, InstallOutcome::Unchanged { .. }));
    }

    #[test]
    fn uninstall_returns_removed() {
        let home = tempfile::tempdir().unwrap();
        let sidecar = std::env::temp_dir().join("inari-mcp-stdio");
        install_for(home.path(), McpClient::Cursor, &sidecar).unwrap();
        let r = uninstall_for(home.path(), McpClient::Cursor).unwrap();
        assert!(matches!(r, InstallOutcome::Removed { .. }));
    }
}
