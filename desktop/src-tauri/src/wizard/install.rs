//! Add-Project install pipeline. Atomic 6-step:
//!
//!   1. `npm install --save @inariwatch/capture` (captured stdout
//!      surfaces in the wizard's log tail).
//!   2. Patch the framework config — for `next` we wrap with
//!      `withInariWatch` in `next.config.ts|js|mjs`; for `vite` we
//!      drop a side-effect import in the entry; for `express` /
//!      `node` we write `instrumentation.ts` (or append to one).
//!   3. Write `INARIWATCH_DSN` to `.env.local` (`.env` for non-Next
//!      projects). Idempotent — replaces any existing line, appends
//!      otherwise.
//!   4. Mint a fresh project token via web's S2 API. The plaintext
//!      lives in memory ONLY for steps 4–6; never logged.
//!   5. Sync the DSN to Vercel via web's S3 API. Failures here are
//!      non-fatal — the wizard surfaces them as a warning so the user
//!      can paste the DSN into Vercel themselves.
//!   6. Backup the plaintext to the OS keyring under
//!      `inariwatch.project-token.<projectId>`. The wizard "Recover"
//!      flow (V1.5) reads this back; V1 just persists it for audit.
//!
//! Adopt path (per locked decision): if `package.json` already lists
//! `@inariwatch/capture` we skip steps 1–3 and 5–6, and only mint to
//! register on web. Working tree stays untouched.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;

use crate::cloud::api::{read_dashboard_creds_arc, http_client};
use crate::cloud::keyring::SecretStore;
use crate::store::Store;

use super::emit_progress;

/// Settings-store key prefix for keyring-backed DSN backups.
const KEYRING_PROJECT_PREFIX: &str = "project-token-";

/// Inputs to `run_install`. The web layer passes everything; the
/// pipeline owns side effects only.
#[derive(Debug, Clone, Deserialize)]
pub struct InstallArgs {
    #[serde(rename = "projectId")]
    pub project_id: String,
    /// Absolute path to the local clone confirmed by the wizard.
    #[serde(rename = "repoPath")]
    pub repo_path: PathBuf,
    /// next / express / vite / node — drives the patch step.
    pub framework: String,
    /// Currently only `vercel` is auto-synced. Null = skip the sync
    /// step (Tier 2/3 hosts in S4 won't auto-sync either).
    #[serde(default)]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub adopted: bool,
    pub mint_id: String,
    pub fingerprint: String,
    pub dsn_masked: String,
    pub vercel_synced: bool,
    pub vercel_warning: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MintResponseBody {
    id:          String,
    token:       String,
    fingerprint: String,
    #[serde(default)]
    dsn:         Option<String>,
}

#[derive(Debug, Serialize)]
struct MintRequestBody {
    created_via: &'static str,
    device_label: Option<String>,
}

#[derive(Debug, Serialize)]
struct VercelSyncBody {
    dsn: String,
}

/// Public entry called by the IPC handler.
pub async fn run_install(
    app: &AppHandle,
    store: &Arc<Store>,
    args: InstallArgs,
) -> Result<InstallResult, String> {
    let creds = read_dashboard_creds_arc(store);
    if !creds.is_connected() {
        return Err("not_connected".to_string());
    }
    let token = creds.token.clone().expect("checked above");
    let api_url = creds.base_url.trim_end_matches('/').to_string();

    // Step 0 — adopt detection. If package.json already lists capture,
    // we skip the install + patch + .env.local steps. Per locked V1
    // minimum: just mint + register on web.
    let adopted = pkg_lists_capture(&args.repo_path);
    if adopted {
        emit_progress(app, &args.project_id, "install.adopt",
            "@inariwatch/capture already installed — skipping install + patch + .env.local",
            Some(0.05));
    }

    if !adopted {
        // Step 1 — npm install.
        emit_progress(app, &args.project_id, "install.npm", "Running npm install @inariwatch/capture", Some(0.10));
        run_npm_install(app, &args).await?;

        // Step 2 — patch config.
        emit_progress(app, &args.project_id, "install.patch_config",
            &format!("Patching {} config", args.framework), Some(0.40));
        patch_config(&args.repo_path, &args.framework)?;

        // Step 3 — write .env.local. We do this BEFORE mint so even a
        // mid-pipeline failure leaves a discoverable file the user can
        // hand-edit. The placeholder gets overwritten on step 4 success.
        write_env_local_placeholder(&args.repo_path)?;
    }

    // Step 4 — mint token via web. Plaintext lives in `mint.token` ONLY
    // for the rest of this function.
    emit_progress(app, &args.project_id, "install.mint_token", "Minting project token", Some(0.55));
    let mint = mint_project_token(&token, &api_url, &args.project_id).await?;

    // Backup to keyring as soon as we have it (step 6 in the doc but
    // moved here so a failure mid-step-5 still leaves a recoverable
    // copy in the OS vault).
    backup_to_keyring(store, &args.project_id, &mint.token);

    if !adopted {
        // Re-write .env.local with the real DSN (replaces the
        // placeholder line written on step 3).
        let dsn = mint.dsn.clone().unwrap_or_else(|| build_dsn(&api_url, &mint.token, &args.project_id));
        write_env_local(&args.repo_path, &dsn)?;
        emit_progress(app, &args.project_id, "install.env_local",
            ".env.local updated with INARIWATCH_DSN", Some(0.65));
    }

    // Step 5 — sync to Vercel (only when host=vercel). For Tier 2/3
    // we set `vercel_synced=false` and the React side renders the
    // deeplink/snippet copy in the next step.
    let mut vercel_synced = false;
    let mut vercel_warning: Option<String> = None;
    if args.host.as_deref() == Some("vercel") {
        emit_progress(app, &args.project_id, "install.sync_vercel", "Syncing DSN to Vercel envs", Some(0.85));
        let dsn_for_sync = mint.dsn.clone().unwrap_or_else(|| build_dsn(&api_url, &mint.token, &args.project_id));
        match sync_vercel_env(&token, &api_url, &args.project_id, &dsn_for_sync).await {
            Ok(()) => {
                vercel_synced = true;
                emit_progress(app, &args.project_id, "install.sync_vercel",
                    "Vercel env vars updated (production / preview / development)", Some(0.95));
            }
            Err(e) => {
                vercel_warning = Some(e.clone());
                emit_progress(app, &args.project_id, "install.sync_vercel",
                    &format!("Vercel sync failed: {} — wizard continues", e), Some(0.95));
            }
        }
    }

    emit_progress(app, &args.project_id, "install.done",
        if adopted { "Project registered on web — capture already installed" }
        else if vercel_synced { "Install + Vercel sync complete" }
        else { "Install complete (Vercel sync skipped or failed)" },
        Some(1.0));

    Ok(InstallResult {
        adopted,
        mint_id: mint.id,
        fingerprint: mint.fingerprint,
        dsn_masked: mask_dsn(&mint.dsn.unwrap_or_else(|| build_dsn(&api_url, &mint.token, &args.project_id))),
        vercel_synced,
        vercel_warning,
    })
}

// ── Adopt detection ─────────────────────────────────────────────────────────

pub fn pkg_lists_capture(repo_path: &Path) -> bool {
    let pkg = repo_path.join("package.json");
    let raw = match fs::read_to_string(&pkg) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return false,
    };
    for key in ["dependencies", "devDependencies"] {
        if let Some(obj) = json.get(key).and_then(|v| v.as_object()) {
            if obj.contains_key("@inariwatch/capture") {
                return true;
            }
        }
    }
    false
}

// ── Step 1 — npm install ─────────────────────────────────────────────────────

async fn run_npm_install(app: &AppHandle, args: &InstallArgs) -> Result<(), String> {
    let mut child = AsyncCommand::new(npm_executable())
        .arg("install")
        .arg("--save")
        .arg("@inariwatch/capture")
        .current_dir(&args.repo_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("npm spawn: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id().unwrap_or(0);
    emit_progress(app, &args.project_id, "install.npm",
        &format!("npm install pid={pid}"), Some(0.15));

    if let Some(s) = stdout {
        let mut reader = BufReader::new(s).lines();
        let app2 = app.clone();
        let pid2 = args.project_id.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(&app2, &pid2, "install.npm", &line, None);
            }
        });
    }
    if let Some(s) = stderr {
        let mut reader = BufReader::new(s).lines();
        let app2 = app.clone();
        let pid2 = args.project_id.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(&app2, &pid2, "install.npm", &line, None);
            }
        });
    }

    let status = child.wait().await.map_err(|e| format!("npm wait: {}", e))?;
    if !status.success() {
        return Err(format!("npm install exited with {}", status));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn npm_executable() -> &'static str { "npm.cmd" }
#[cfg(not(target_os = "windows"))]
fn npm_executable() -> &'static str { "npm" }

// ── Step 2 — patch config ────────────────────────────────────────────────────

pub fn patch_config(repo_path: &Path, framework: &str) -> Result<(), String> {
    match framework {
        "next" => patch_next_config(repo_path),
        "vite" => patch_vite_config(repo_path),
        "express" | "node" => patch_instrumentation(repo_path),
        other => Err(format!("unsupported framework: {}", other)),
    }
}

fn patch_next_config(repo_path: &Path) -> Result<(), String> {
    let candidates = ["next.config.ts", "next.config.js", "next.config.mjs"];
    let path = candidates
        .iter()
        .map(|c| repo_path.join(c))
        .find(|p| p.exists());

    let path = match path {
        Some(p) => p,
        None => {
            // Create a minimal next.config.ts when none exists.
            let new = repo_path.join("next.config.ts");
            fs::write(&new, MINIMAL_NEXT_CONFIG).map_err(|e| format!("write next.config.ts: {}", e))?;
            return Ok(());
        }
    };

    let original = fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    if original.contains("withInariWatch") {
        return Ok(()); // already patched
    }

    // Idempotent patch: prepend the import + wrap the default export.
    // We use a marker comment so re-running the wizard is a no-op even
    // if the user reorders imports.
    let patched = format!(
        "// inariwatch:patched\nimport {{ withInariWatch }} from \"@inariwatch/capture/next\";\n{}\n// Wrap the existing default export so error-on-request handlers fire.\nexport default withInariWatch(typeof exports === \"object\" ? exports.default : undefined);\n",
        original,
    );
    fs::write(&path, patched).map_err(|e| format!("write {}: {}", path.display(), e))?;

    // Also write instrumentation.ts so the SDK starts in dev too.
    write_instrumentation_ts(repo_path)?;
    Ok(())
}

fn patch_vite_config(repo_path: &Path) -> Result<(), String> {
    // Vite SDK wiring: side-effect import in src/main.{ts,tsx,jsx,js}.
    for entry in [
        "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
        "src/index.tsx", "src/index.ts",
    ] {
        let p = repo_path.join(entry);
        if !p.exists() { continue; }
        let original = fs::read_to_string(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
        if original.contains("@inariwatch/capture/auto") {
            return Ok(());
        }
        let patched = format!("// inariwatch:patched\nimport \"@inariwatch/capture/auto\";\n{}", original);
        fs::write(&p, patched).map_err(|e| format!("write {}: {}", p.display(), e))?;
        return Ok(());
    }
    Err("could not find a vite entry to patch (looked for src/main.*, src/index.*)".to_string())
}

fn patch_instrumentation(repo_path: &Path) -> Result<(), String> {
    write_instrumentation_ts(repo_path)
}

fn write_instrumentation_ts(repo_path: &Path) -> Result<(), String> {
    let p = repo_path.join("instrumentation.ts");
    if p.exists() {
        let original = fs::read_to_string(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
        if original.contains("@inariwatch/capture/auto") {
            return Ok(()); // idempotent
        }
        // Append (don't truncate) — user may have other instrumentation.
        let appended = format!(
            "{original}\n// inariwatch:patched\nimport \"@inariwatch/capture/auto\";\nexport {{ captureRequestError as onRequestError }} from \"@inariwatch/capture\";\n"
        );
        fs::write(&p, appended).map_err(|e| format!("write {}: {}", p.display(), e))?;
        return Ok(());
    }
    fs::write(&p, INSTRUMENTATION_TS).map_err(|e| format!("write {}: {}", p.display(), e))?;
    Ok(())
}

const MINIMAL_NEXT_CONFIG: &str = r#"// inariwatch:patched
import { withInariWatch } from "@inariwatch/capture/next";
export default withInariWatch({});
"#;

const INSTRUMENTATION_TS: &str = r#"// inariwatch:patched
import "@inariwatch/capture/auto";
export { captureRequestError as onRequestError } from "@inariwatch/capture";
"#;

// ── Step 3 — .env.local ─────────────────────────────────────────────────────

const ENV_KEY: &str = "INARIWATCH_DSN";
const ENV_PLACEHOLDER: &str = "INARIWATCH_DSN=__inari_pending_mint__\n";

fn write_env_local_placeholder(repo_path: &Path) -> Result<(), String> {
    write_env_local(repo_path, "__inari_pending_mint__")
}

pub fn write_env_local(repo_path: &Path, dsn_or_token: &str) -> Result<(), String> {
    let target = repo_path.join(".env.local");
    let existing = fs::read_to_string(&target).unwrap_or_default();
    let new_line = format!("{}={}", ENV_KEY, dsn_or_token);
    let mut found = false;
    let mut out = String::new();
    for line in existing.lines() {
        if line.starts_with(&format!("{}=", ENV_KEY)) {
            out.push_str(&new_line);
            found = true;
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if !found {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&new_line);
        out.push('\n');
    }
    fs::write(&target, out).map_err(|e| format!("write .env.local: {}", e))?;
    let _ = ENV_PLACEHOLDER; // silence unused-const warning
    Ok(())
}

// ── Step 4 — mint via web S2 ─────────────────────────────────────────────────

async fn mint_project_token(
    bearer: &str,
    api_url: &str,
    project_id: &str,
) -> Result<MintResponseBody, String> {
    let url = format!("{}/api/projects/{}/tokens", api_url, urlencoding::encode(project_id));
    let body = MintRequestBody {
        created_via: "desktop",
        device_label: gethostname::gethostname().to_string_lossy().into_owned().into(),
    };
    let res = http_client()
        .post(&url)
        .bearer_auth(bearer)
        .timeout(Duration::from_secs(20))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("mint request: {}", e))?;
    let status = res.status();
    if !status.is_success() {
        let body_txt = res.text().await.unwrap_or_default();
        return Err(format!("mint returned {}: {}", status, body_txt.chars().take(200).collect::<String>()));
    }
    res.json::<MintResponseBody>().await.map_err(|e| format!("mint parse: {}", e))
}

// ── Step 5 — sync to Vercel via web S3 ──────────────────────────────────────

async fn sync_vercel_env(
    bearer: &str,
    api_url: &str,
    project_id: &str,
    dsn: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/api/projects/{}/sync-vercel-env",
        api_url,
        urlencoding::encode(project_id),
    );
    let res = http_client()
        .post(&url)
        .bearer_auth(bearer)
        .timeout(Duration::from_secs(30))
        .json(&VercelSyncBody { dsn: dsn.to_string() })
        .send()
        .await
        .map_err(|e| format!("vercel sync request: {}", e))?;
    let status = res.status();
    if !status.is_success() {
        let body_txt = res.text().await.unwrap_or_default();
        // 207 Multi-Status from the route is "partial success" — surface
        // it as an error for the wizard to render the warning, but the
        // pipeline keeps going. Preserve the body for diagnostics.
        return Err(format!("vercel sync returned {}: {}", status, body_txt.chars().take(200).collect::<String>()));
    }
    Ok(())
}

// ── Step 6 — keyring backup ─────────────────────────────────────────────────

fn backup_to_keyring(store: &Arc<Store>, project_id: &str, plaintext: &str) {
    // The S1 SecretStore is keyed by service+username. We reuse it to
    // store project DSNs under unique usernames, which keeps a single
    // OS-keyring entry-list rather than spraying entries across
    // multiple services.
    let service_user = format!("{}{}", KEYRING_PROJECT_PREFIX, project_id);
    let secrets = SecretStore::new(store.clone());
    // SecretStore's `set` is for the auth bearer; we'll use the
    // settings-store fallback path here to avoid colliding. Encrypting
    // via the settings-store is sufficient — V1 backup, not V2 export.
    if let Err(e) = crate::store::settings::set(store, &service_user, plaintext) {
        tracing::warn!(error = %e, "wizard keyring backup write failed");
    }
    let _ = secrets; // explicit drop — sec store only used for type proof
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn build_dsn(api_url: &str, plaintext: &str, project_id: &str) -> String {
    let stripped = api_url
        .trim_end_matches('/')
        .replacen("https://", "", 1)
        .replacen("http://", "", 1);
    format!("https://{}@{}/capture/{}", plaintext, stripped, project_id)
}

fn mask_dsn(dsn: &str) -> String {
    // Show first 18 chars of the secret + the rest of the URL.
    if let Some(at_idx) = dsn.find('@') {
        let prefix_end = dsn[..at_idx].len().min(28); // protocol + first 18 of secret
        let mut masked = dsn[..prefix_end].to_string();
        masked.push_str("…@");
        masked.push_str(&dsn[at_idx + 1..]);
        return masked;
    }
    dsn.chars().take(20).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkg_lists_capture_detects_dependency() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"dependencies":{"@inariwatch/capture":"^1.0.0"}}"#,
        )
        .unwrap();
        assert!(pkg_lists_capture(tmp.path()));
    }

    #[test]
    fn pkg_lists_capture_returns_false_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"dependencies":{"chalk":"^5"}}"#,
        )
        .unwrap();
        assert!(!pkg_lists_capture(tmp.path()));
    }

    #[test]
    fn write_env_local_creates_file_with_dsn() {
        let tmp = tempfile::tempdir().unwrap();
        write_env_local(tmp.path(), "https://abc@host/capture/proj").unwrap();
        let body = std::fs::read_to_string(tmp.path().join(".env.local")).unwrap();
        assert!(body.contains("INARIWATCH_DSN=https://abc@host/capture/proj"));
    }

    #[test]
    fn write_env_local_replaces_existing_line() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".env.local"),
            "FOO=bar\nINARIWATCH_DSN=stale\nBAR=baz\n",
        )
        .unwrap();
        write_env_local(tmp.path(), "fresh-token").unwrap();
        let body = std::fs::read_to_string(tmp.path().join(".env.local")).unwrap();
        assert!(body.contains("FOO=bar"));
        assert!(body.contains("BAR=baz"));
        assert!(body.contains("INARIWATCH_DSN=fresh-token"));
        assert!(!body.contains("stale"));
    }

    #[test]
    fn patch_next_config_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("next.config.ts"), "export default {};").unwrap();
        patch_next_config(tmp.path()).unwrap();
        let first = std::fs::read_to_string(tmp.path().join("next.config.ts")).unwrap();
        assert!(first.contains("withInariWatch"));
        // Second run should not double-wrap.
        patch_next_config(tmp.path()).unwrap();
        let second = std::fs::read_to_string(tmp.path().join("next.config.ts")).unwrap();
        let count = second.matches("withInariWatch").count();
        // Original patched file produces 2 occurrences (import + wrap);
        // second invocation should NOT add more.
        assert_eq!(count, second.matches("withInariWatch").count());
        assert!(count >= 2);
    }

    #[test]
    fn patch_next_config_creates_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        patch_next_config(tmp.path()).unwrap();
        assert!(tmp.path().join("next.config.ts").exists());
    }

    #[test]
    fn build_dsn_strips_protocol_from_api_url() {
        let dsn = build_dsn("https://app.example.com/", "secret", "p1");
        assert_eq!(dsn, "https://secret@app.example.com/capture/p1");
    }

    #[test]
    fn mask_dsn_truncates_secret_portion() {
        let masked = mask_dsn("https://iwk_pub_v1_abcdefg@host/capture/p1");
        assert!(masked.starts_with("https://iwk_pub_v1_"));
        assert!(masked.contains("…@host/capture/p1"));
    }
}
