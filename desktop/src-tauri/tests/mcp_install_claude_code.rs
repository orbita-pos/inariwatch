//! `install_for(McpClient::ClaudeCode, ...)` writes a valid JSON file
//! at `~/.claude/mcp.json`, backs up an existing file before
//! modifying, and is idempotent (a second call returns
//! `InstallOutcome::Unchanged`).

use std::path::Path;

use inariwatch_desktop_lib::sensors::mcp::install::{
    install_for, status_for, uninstall_for, InstallOutcome, McpClient,
};

#[test]
fn install_creates_claude_mcp_json() {
    let home = tempfile::tempdir().unwrap();
    let sidecar = std::env::temp_dir().join("inari-mcp-stdio");
    let outcome = install_for(home.path(), McpClient::ClaudeCode, &sidecar).unwrap();
    let path = home.path().join(".claude").join("mcp.json");
    assert!(path.exists(), "expected mcp.json to be created");
    matches!(outcome, InstallOutcome::Created { .. });

    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let entry = raw.pointer("/mcpServers/inari-live").expect("inari-live entry");
    let cmd = entry.get("command").and_then(|v| v.as_str()).unwrap();
    assert!(cmd.ends_with("inari-mcp-stdio"), "command should reference sidecar binary");
}

#[test]
fn install_is_idempotent() {
    let home = tempfile::tempdir().unwrap();
    let sidecar = std::env::temp_dir().join("inari-mcp-stdio");
    let a = install_for(home.path(), McpClient::ClaudeCode, &sidecar).unwrap();
    let b = install_for(home.path(), McpClient::ClaudeCode, &sidecar).unwrap();
    assert!(matches!(a, InstallOutcome::Created { .. }));
    assert!(
        matches!(b, InstallOutcome::Unchanged { .. }),
        "second call must be Unchanged when entry is identical, got {b:?}"
    );
}

#[test]
fn install_backs_up_existing_file_when_modifying() {
    let home = tempfile::tempdir().unwrap();
    let sidecar_a = std::env::temp_dir().join("inari-mcp-stdio");
    let sidecar_b = std::env::temp_dir().join("different-sidecar");

    // First install with sidecar_a creates the file.
    install_for(home.path(), McpClient::ClaudeCode, &sidecar_a).unwrap();
    let path = home.path().join(".claude").join("mcp.json");
    assert!(path.exists());

    // Second install with a different sidecar path overwrites + backs up.
    let outcome = install_for(home.path(), McpClient::ClaudeCode, &sidecar_b).unwrap();
    let backup = match outcome {
        InstallOutcome::Updated { backup, .. } => backup,
        other => panic!("expected Updated, got {other:?}"),
    };
    assert!(Path::new(&backup).exists(), "backup file should exist");
}

#[test]
fn status_for_uninstalled_returns_not_installed() {
    let home = tempfile::tempdir().unwrap();
    let sidecar = std::env::temp_dir().join("inari-mcp-stdio");
    let s = status_for(home.path(), McpClient::ClaudeCode, &sidecar);
    assert!(!s.installed);
    assert!(!s.matches_current);
}

#[test]
fn uninstall_after_install_is_clean() {
    let home = tempfile::tempdir().unwrap();
    let sidecar = std::env::temp_dir().join("inari-mcp-stdio");
    install_for(home.path(), McpClient::ClaudeCode, &sidecar).unwrap();
    let removed = uninstall_for(home.path(), McpClient::ClaudeCode).unwrap();
    assert!(matches!(removed, InstallOutcome::Removed { .. }));
}

#[test]
fn install_for_zed_writes_context_servers_key() {
    let home = tempfile::tempdir().unwrap();
    let sidecar = std::env::temp_dir().join("inari-mcp-stdio");
    install_for(home.path(), McpClient::Zed, &sidecar).unwrap();
    let path = home.path().join(".config").join("zed").join("settings.json");
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(raw.pointer("/context_servers/inari-live").is_some(),
        "Zed config must use context_servers key");
}
