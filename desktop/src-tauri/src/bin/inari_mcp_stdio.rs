//! `inari-mcp-stdio` — sidecar binary spawned by Claude Code / Codex /
//! Cursor / Zed when they want to talk to Inari Live's local MCP
//! server.
//!
//! It is a CLIENT, not a server: each line read from stdin is forwarded
//! over `127.0.0.1:<port>/mcp` with a `Bearer` header, and the JSON
//! response is echoed back to stdout. The port + token live in
//! `<app_local_data_dir>/inari-live/auth.json` (token) and the SQL
//! `settings.mcp_port` row (port). Both are written by the daemon on
//! first boot.
//!
//! If the daemon is not running we fail FAST with a JSON-RPC error
//! response so the calling editor surfaces "Inari Live not running"
//! instead of hanging.
//!
//! Resolution rules:
//!   1. Path to the auth file: `INARI_LIVE_AUTH_FILE` env var if set,
//!      otherwise the OS app-local-data convention. We avoid pulling
//!      a heavy directory crate by re-implementing only the rule we
//!      need.
//!   2. Port: `INARI_LIVE_MCP_PORT` env var if set, otherwise we look
//!      up the value next to the auth file in `port.txt` (the daemon
//!      writes both at boot for sidecar consumption).

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9876;
const POLL_RECONNECT_MS: u64 = 250;

fn main() {
    let stdin  = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let mut input  = stdin.lock();

    let auth = match resolve_auth() {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stdout, "{}", boot_error(&e.to_string()));
            std::process::exit(0);
        }
    };
    let port = resolve_port();
    let url  = format!("http://{HOST}:{port}/mcp");

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .expect("reqwest blocking client build");

    loop {
        let mut buf = String::new();
        match input.read_line(&mut buf) {
            Ok(0)  => break,                // clean EOF
            Ok(_)  => {}
            Err(_) => break,
        }
        let trimmed = buf.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            continue;
        }

        let response = forward(&client, &url, &auth, trimmed);
        if writeln!(stdout, "{}", response).is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
    }
}

fn forward(client: &reqwest::blocking::Client, url: &str, token: &str, body: &str) -> String {
    let req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {token}"))
        .body(body.to_string());
    match req.send() {
        Ok(r) => match r.text() {
            Ok(txt) => txt,
            Err(e)  => transport_error(&format!("response read failed: {e}")),
        },
        Err(e) => transport_error(&e.to_string()),
    }
}

/// Resolve the Bearer token by reading `auth.json` from the daemon's
/// state directory.
fn resolve_auth() -> std::io::Result<String> {
    let path = if let Ok(p) = std::env::var("INARI_LIVE_AUTH_FILE") {
        PathBuf::from(p)
    } else {
        default_auth_path().ok_or_else(|| std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "could not resolve INARI_LIVE_AUTH_FILE — set the env var or run the daemon at least once",
        ))?
    };

    let contents = std::fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&contents)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    let token = v.get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "auth.json missing `token`"))?;
    Ok(token.to_string())
}

fn resolve_port() -> u16 {
    if let Ok(p) = std::env::var("INARI_LIVE_MCP_PORT") {
        if let Ok(n) = p.parse::<u16>() {
            return n;
        }
    }
    if let Some(parent) = default_auth_path().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let port_file = parent.join("port.txt");
        if let Ok(s) = std::fs::read_to_string(&port_file) {
            if let Ok(n) = s.trim().parse::<u16>() {
                return n;
            }
        }
    }
    DEFAULT_PORT
}

/// Best-effort cross-platform resolution of the daemon's
/// `app_local_data_dir` for the InariWatch desktop app. We only need
/// this when `INARI_LIVE_AUTH_FILE` is unset — Tauri itself handles it
/// at runtime. The bundle id is hard-coded; if Tauri ever changes it,
/// the sidecar still works via the env var override.
fn default_auth_path() -> Option<PathBuf> {
    let bundle_id = "com.inariwatch.desktop";
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        return Some(PathBuf::from(appdata).join(bundle_id).join("inari-live").join("auth.json"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join("Library/Application Support").join(bundle_id).join("inari-live").join("auth.json"));
    }
    #[cfg(target_os = "linux")]
    {
        let xdg = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
        })?;
        return Some(xdg.join(bundle_id).join("inari-live").join("auth.json"));
    }
    #[allow(unreachable_code)]
    None
}

fn boot_error(msg: &str) -> String {
    let _ = POLL_RECONNECT_MS; // reserved for a retry loop in a future rev
    json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": {
            "code":    -32001,
            "message": format!("Inari Live MCP sidecar could not initialize: {msg}"),
        }
    }).to_string()
}

fn transport_error(msg: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": {
            "code":    -32603,
            "message": format!("MCP transport error: {msg}"),
        }
    }).to_string()
}
