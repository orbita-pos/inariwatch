//! Local-clone detection for the Add-Project wizard.
//!
//! Scans the user's typical "code home" directories looking for a clone
//! whose `git remote get-url origin` matches the GitHub `owner/repo`
//! the wizard was opened against. Per the locked decision, we never
//! mutate the directories — only read.
//!
//! The default search list:
//!   * `~/code`
//!   * `~/dev`
//!   * `~/Documents/projects`
//!   * `~/repos`
//!   * `~/src`
//!   * `~/projects`
//!   * `~/work`
//!
//! Customizable from `Settings → Repos → Add Project search dirs` (V1.5
//! follow-up — for V1 we read `wizard_search_dirs` from the SQL settings
//! store if set, falling back to the defaults).
//!
//! Match algorithm:
//!   1. Stop at depth ≤ 2 (i.e. `<dir>/<repo>` and `<dir>/<owner>/<repo>`).
//!      Prevents recursive scans of node_modules / target / etc.
//!   2. A candidate matches when:
//!      - the directory name equals the repo name (case-insensitive), AND
//!      - `<candidate>/.git/config` parses to a remote URL whose
//!        `owner/repo` (extracted from either ssh or https form) equals
//!        the requested owner/repo (case-insensitive).
//!   3. Multiple matches: the first one wins. The wizard's UI exposes
//!      "Use a different folder" so the user can override.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::store::{settings, Store};

use super::DetectionResult;

#[derive(Debug, Clone, Serialize)]
pub struct LocalCloneMatch {
    pub path: PathBuf,
    /// Detected framework hint based on package.json contents.
    pub framework: String,
    /// Detected host hint based on filesystem markers.
    pub host: Option<String>,
}

/// Default search directories relative to `~`. Materialised at scan
/// time so a missing `~/code` doesn't fail the call — we just skip.
const DEFAULT_SEARCH_DIRS: &[&str] = &[
    "code",
    "dev",
    "Documents/projects",
    "repos",
    "src",
    "projects",
    "work",
];

/// Public entry — find the clone matching `repo_full_name` (e.g.
/// `acme/api`). Returns `DetectionResult { path: None, .. }` when
/// nothing matches; the wizard UI then exposes a manual "Pick folder"
/// button.
pub fn detect_local_clone(store: &Store, repo_full_name: &str) -> DetectionResult {
    let (owner, repo) = match split_owner_repo(repo_full_name) {
        Some(p) => p,
        None => return DetectionResult { path: None, framework: None, host: None },
    };

    for dir in resolve_search_dirs(store) {
        if let Some(m) = scan_dir(&dir, &owner, &repo, 0) {
            return DetectionResult {
                path: Some(m.path),
                framework: Some(m.framework),
                host: m.host,
            };
        }
    }
    DetectionResult { path: None, framework: None, host: None }
}

/// Visible for unit tests + the IPC command. Pure function — given a
/// rooted dir + owner/repo, walks up to depth 2 looking for the match.
pub fn scan_dir(root: &Path, owner: &str, repo: &str, depth: u32) -> Option<LocalCloneMatch> {
    if depth > 2 {
        return None;
    }
    let entries = match fs::read_dir(root) {
        Ok(it) => it,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Skip well-known non-repo dirs early.
        if matches!(name.as_str(), "node_modules" | "target" | ".git" | ".next" | "dist") {
            continue;
        }

        // Direct match on the leaf name.
        if name.eq_ignore_ascii_case(repo) {
            if remote_matches(&path, owner, repo) {
                return Some(build_match(path));
            }
        }

        // One level deeper for `<root>/<owner>/<repo>` and friends.
        if depth < 2 {
            if let Some(m) = scan_dir(&path, owner, repo, depth + 1) {
                return Some(m);
            }
        }
    }
    None
}

/// Build the typed match — read package.json + filesystem markers.
fn build_match(path: PathBuf) -> LocalCloneMatch {
    let framework = detect_framework(&path).unwrap_or_else(|| "node".to_string());
    let host = detect_host(&path);
    LocalCloneMatch { path, framework, host }
}

/// Read package.json's dependencies / devDependencies and return a
/// hint string. Recognises the four V1 frameworks; everything else is
/// `node` (caller can default).
pub fn detect_framework(repo_path: &Path) -> Option<String> {
    let pkg = repo_path.join("package.json");
    let raw = fs::read_to_string(&pkg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let deps = collect_deps(&json);

    if deps.contains_key("next") {
        return Some("next".to_string());
    }
    if deps.contains_key("vite") {
        return Some("vite".to_string());
    }
    if deps.contains_key("express") {
        return Some("express".to_string());
    }
    Some("node".to_string())
}

fn collect_deps(json: &serde_json::Value) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for key in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(obj) = json.get(key).and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    out.insert(k.clone(), s.to_string());
                }
            }
        }
    }
    out
}

/// Filesystem markers for hosts. Vercel (Tier 1, auto-sync) is checked
/// first to preserve S3 behaviour; everything below is S4 scope.
///
/// Tier mapping (the React side maps id → tier; the Rust side returns
/// only the canonical id so detection stays a pure file scan):
///   * `vercel`                    — Tier 1 (auto-sync)
///   * `netlify` / `railway` / `fly` / `render` / `cloudflare` /
///     `heroku` / `gcp_app_engine` — Tier 2 (deeplink + clipboard)
///   * `kubernetes` / `docker_compose` / `docker`
///                                 — Tier 3 (snippet picker)
///   * `None`                      — Tier 3 fallback (universal escape:
///     React renders a host dropdown).
///
/// Order matters: more specific markers are checked first so a project
/// with both `Procfile` AND `fly.toml` resolves to `fly`, not `heroku`.
/// Likewise `docker-compose.yml` wins over `Dockerfile` because the
/// compose file is the actual deploy artefact.
pub fn detect_host(repo_path: &Path) -> Option<String> {
    // Tier 1 — Vercel (auto-sync).
    if repo_path.join("vercel.json").exists()
        || repo_path.join(".vercel").join("project.json").exists()
    {
        return Some("vercel".to_string());
    }

    // Tier 2 — deeplink hosts. Order: most specific marker first so a
    // monorepo with multiple deploy targets resolves deterministically.
    if repo_path.join("netlify.toml").exists()
        || repo_path.join("netlify").join("functions").is_dir()
    {
        return Some("netlify".to_string());
    }
    if repo_path.join("railway.json").exists()
        || repo_path.join("railway.toml").exists()
    {
        return Some("railway".to_string());
    }
    // fly.toml is checked BEFORE Procfile — fly buildpacks projects
    // commonly carry a Procfile, but fly.toml is the canonical marker.
    if repo_path.join("fly.toml").exists() {
        return Some("fly".to_string());
    }
    if repo_path.join("render.yaml").exists() {
        return Some("render".to_string());
    }
    if repo_path.join("wrangler.toml").exists()
        || repo_path.join("wrangler.jsonc").exists()
        || repo_path.join("wrangler.json").exists()
    {
        return Some("cloudflare".to_string());
    }
    if repo_path.join("Procfile").exists() {
        return Some("heroku".to_string());
    }
    if app_yaml_is_app_engine(&repo_path.join("app.yaml")) {
        return Some("gcp_app_engine".to_string());
    }

    // Tier 3 — self-hosted / containerised. K8s before docker-compose
    // before plain Dockerfile, since a K8s repo usually also carries a
    // Dockerfile but the deploy artefact is the manifest.
    if has_kubernetes_marker(repo_path) {
        return Some("kubernetes".to_string());
    }
    if repo_path.join("docker-compose.yml").exists()
        || repo_path.join("docker-compose.yaml").exists()
        || repo_path.join("compose.yml").exists()
        || repo_path.join("compose.yaml").exists()
    {
        return Some("docker_compose".to_string());
    }
    if repo_path.join("Dockerfile").exists() {
        return Some("docker".to_string());
    }
    None
}

/// `app.yaml` is ambiguous (used by both GCP App Engine and unrelated
/// CI pipelines). We accept the file as a host marker only when it
/// contains a `runtime:` key at column 0, which is App Engine's
/// canonical YAML shape (`runtime: nodejs20`, `runtime: python311`,
/// etc). Avoids false positives on, e.g., GitHub Actions workflows
/// that happen to be named `app.yaml`.
fn app_yaml_is_app_engine(path: &Path) -> bool {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    raw.lines().any(|line| {
        // top-level `runtime: <value>` — no leading whitespace, no comment.
        let trimmed = line.trim_end();
        trimmed.starts_with("runtime:") && !trimmed.starts_with("# ")
    })
}

/// Kubernetes detection: prefer the conventional `k8s/` (or `kubernetes/`)
/// directory. Fall back to scanning top-level `*.yaml` / `*.yml` files
/// for both `kind:` and `apiVersion:` markers — the two together filter
/// out almost all non-K8s YAML (helm `Chart.yaml`, GitHub Actions, etc.).
/// Only the top level is scanned (no recursion) to keep the cost bounded
/// for large monorepos.
fn has_kubernetes_marker(repo_path: &Path) -> bool {
    for dir in ["k8s", "kubernetes", "manifests"] {
        if repo_path.join(dir).is_dir() {
            return true;
        }
    }
    let entries = match fs::read_dir(repo_path) {
        Ok(it) => it,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !matches!(ext, "yaml" | "yml") {
            continue;
        }
        // Skip well-known non-K8s YAMLs we don't want to misidentify.
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if matches!(
            name,
            "docker-compose.yml"
                | "docker-compose.yaml"
                | "compose.yml"
                | "compose.yaml"
                | "netlify.toml"
                | "render.yaml"
                | "app.yaml"
                | "Chart.yaml"
                | ".gitlab-ci.yml"
        ) {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Cap parse work — manifests are tiny; anything past 64 KiB is
        // almost certainly not a K8s file.
        if raw.len() > 64 * 1024 {
            continue;
        }
        let has_kind = raw.lines().any(|l| l.trim_start().starts_with("kind:"));
        let has_api  = raw.lines().any(|l| l.trim_start().starts_with("apiVersion:"));
        if has_kind && has_api {
            return true;
        }
    }
    false
}

/// Read `.git/config` and verify the `[remote "origin"]` URL points
/// at the requested `owner/repo`. Tolerant of both SSH and HTTPS
/// remote forms.
fn remote_matches(repo_path: &Path, expected_owner: &str, expected_repo: &str) -> bool {
    let cfg = repo_path.join(".git").join("config");
    let raw = match fs::read_to_string(&cfg) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let url = parse_origin_url(&raw);
    let url = match url {
        Some(u) => u,
        None => return false,
    };
    let (got_owner, got_repo) = match parse_github_owner_repo(&url) {
        Some(p) => p,
        None => return false,
    };
    got_owner.eq_ignore_ascii_case(expected_owner)
        && got_repo.eq_ignore_ascii_case(expected_repo)
}

/// Pulled into a free fn so unit tests can verify the parser without
/// touching the filesystem.
pub fn parse_origin_url(git_config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in git_config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_origin = trimmed == "[remote \"origin\"]";
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("url") {
            // Skip `=` and surrounding whitespace.
            let v = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
            return Some(v.trim().to_string());
        }
    }
    None
}

/// Recognises:
///   git@github.com:owner/repo.git
///   ssh://git@github.com/owner/repo.git
///   https://github.com/owner/repo.git
///   https://github.com/owner/repo
pub fn parse_github_owner_repo(url: &str) -> Option<(String, String)> {
    let stripped = url.trim().trim_end_matches(".git");
    // SSH form
    if let Some(rest) = stripped.strip_prefix("git@github.com:") {
        return split_owner_repo(rest);
    }
    // SSH ssh:// form
    if let Some(rest) = stripped.strip_prefix("ssh://git@github.com/") {
        return split_owner_repo(rest);
    }
    // HTTPS form
    for prefix in ["https://github.com/", "http://github.com/"] {
        if let Some(rest) = stripped.strip_prefix(prefix) {
            return split_owner_repo(rest);
        }
    }
    None
}

pub fn split_owner_repo(s: &str) -> Option<(String, String)> {
    let trimmed = s.trim().trim_matches('/');
    let parts: Vec<&str> = trimmed.splitn(3, '/').collect();
    if parts.len() < 2 {
        return None;
    }
    let owner = parts[0].trim();
    let repo = parts[1].trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn resolve_search_dirs(store: &Store) -> Vec<PathBuf> {
    // Settings override — comma-separated, absolute or `~`-relative
    // paths. Falls back to defaults below.
    if let Ok(Some(raw)) = settings::get(store, "wizard_search_dirs") {
        let mut out = Vec::new();
        for entry in raw.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            if let Some(p) = expand_tilde(entry) {
                out.push(p);
            }
        }
        if !out.is_empty() {
            return out;
        }
    }

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    DEFAULT_SEARCH_DIRS.iter().map(|d| home.join(d)).collect()
}

fn expand_tilde(p: &str) -> Option<PathBuf> {
    if let Some(rest) = p.strip_prefix("~/") {
        return Some(dirs::home_dir()?.join(rest));
    }
    if p == "~" {
        return dirs::home_dir();
    }
    Some(PathBuf::from(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_owner_repo_handles_ssh_and_https() {
        assert_eq!(
            parse_github_owner_repo("git@github.com:acme/api.git"),
            Some(("acme".to_string(), "api".to_string())),
        );
        assert_eq!(
            parse_github_owner_repo("ssh://git@github.com/acme/api.git"),
            Some(("acme".to_string(), "api".to_string())),
        );
        assert_eq!(
            parse_github_owner_repo("https://github.com/Acme/Api"),
            Some(("Acme".to_string(), "Api".to_string())),
        );
        assert_eq!(
            parse_github_owner_repo("https://github.com/acme/api.git"),
            Some(("acme".to_string(), "api".to_string())),
        );
        assert_eq!(parse_github_owner_repo("https://gitlab.com/x/y"), None);
    }

    #[test]
    fn parse_origin_url_picks_origin_only() {
        let cfg = r#"
[core]
    repositoryformatversion = 0
[remote "upstream"]
    url = https://github.com/upstream/proj.git
[remote "origin"]
    url = git@github.com:acme/api.git
[branch "main"]
    remote = origin
"#;
        assert_eq!(
            parse_origin_url(cfg).as_deref(),
            Some("git@github.com:acme/api.git"),
        );
    }

    #[test]
    fn split_owner_repo_rejects_empty_or_partial() {
        assert!(split_owner_repo("").is_none());
        assert!(split_owner_repo("acme").is_none());
        assert_eq!(
            split_owner_repo("acme/api"),
            Some(("acme".into(), "api".into())),
        );
        // Extra path segments after owner/repo are tolerated.
        assert_eq!(
            split_owner_repo("acme/api/sub"),
            Some(("acme".into(), "api".into())),
        );
    }

    #[test]
    fn detect_framework_reads_next() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"name":"x","dependencies":{"next":"^15.0.0"}}"#,
        )
        .unwrap();
        assert_eq!(detect_framework(tmp.path()), Some("next".to_string()));
    }

    #[test]
    fn detect_framework_falls_back_to_node() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"name":"x","dependencies":{"chalk":"^5"}}"#,
        )
        .unwrap();
        assert_eq!(detect_framework(tmp.path()), Some("node".to_string()));
    }

    #[test]
    fn detect_host_finds_vercel_marker() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".vercel")).unwrap();
        std::fs::write(tmp.path().join(".vercel").join("project.json"), "{}").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("vercel".to_string()));
    }

    #[test]
    fn detect_host_returns_none_when_no_marker() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(detect_host(tmp.path()), None);
    }

    // S4 — Tier 2 host markers.

    #[test]
    fn detect_host_finds_netlify_toml() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("netlify.toml"), "[build]\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("netlify".to_string()));
    }

    #[test]
    fn detect_host_finds_netlify_functions_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("netlify").join("functions")).unwrap();
        assert_eq!(detect_host(tmp.path()), Some("netlify".to_string()));
    }

    #[test]
    fn detect_host_finds_railway_json() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("railway.json"), "{}").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("railway".to_string()));
    }

    #[test]
    fn detect_host_finds_railway_toml() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("railway.toml"), "").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("railway".to_string()));
    }

    #[test]
    fn detect_host_finds_fly_toml() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("fly.toml"), "app = 'x'\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("fly".to_string()));
    }

    #[test]
    fn detect_host_prefers_fly_over_procfile_when_both_present() {
        // Fly buildpacks projects commonly carry a Procfile alongside
        // fly.toml — we want fly to win, not heroku.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("fly.toml"), "app = 'x'\n").unwrap();
        std::fs::write(tmp.path().join("Procfile"), "web: node server.js\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("fly".to_string()));
    }

    #[test]
    fn detect_host_finds_render_yaml() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("render.yaml"), "services: []\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("render".to_string()));
    }

    #[test]
    fn detect_host_finds_wrangler_toml() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("wrangler.toml"), "name = 'x'\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("cloudflare".to_string()));
    }

    #[test]
    fn detect_host_finds_wrangler_jsonc() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("wrangler.jsonc"), "{}").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("cloudflare".to_string()));
    }

    #[test]
    fn detect_host_finds_procfile() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Procfile"), "web: node server.js\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("heroku".to_string()));
    }

    #[test]
    fn detect_host_finds_app_yaml_with_runtime() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("app.yaml"),
            "runtime: nodejs20\nenv_variables:\n  FOO: bar\n",
        )
        .unwrap();
        assert_eq!(detect_host(tmp.path()), Some("gcp_app_engine".to_string()));
    }

    #[test]
    fn detect_host_ignores_app_yaml_without_runtime() {
        // GitHub Actions workflows occasionally live at app.yaml — we
        // don't want to misidentify those as App Engine.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("app.yaml"), "name: ci\non: push\n").unwrap();
        assert_eq!(detect_host(tmp.path()), None);
    }

    // S4 — Tier 3 host markers.

    #[test]
    fn detect_host_finds_kubernetes_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("k8s")).unwrap();
        assert_eq!(detect_host(tmp.path()), Some("kubernetes".to_string()));
    }

    #[test]
    fn detect_host_finds_kubernetes_yaml_via_kind_apiversion() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("deploy.yaml"),
            "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n",
        )
        .unwrap();
        assert_eq!(detect_host(tmp.path()), Some("kubernetes".to_string()));
    }

    #[test]
    fn detect_host_finds_docker_compose() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("docker-compose.yml"), "version: '3'\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("docker_compose".to_string()));
    }

    #[test]
    fn detect_host_finds_compose_yml() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("compose.yml"), "services: {}\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("docker_compose".to_string()));
    }

    #[test]
    fn detect_host_finds_dockerfile() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Dockerfile"), "FROM node:20\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("docker".to_string()));
    }

    #[test]
    fn detect_host_prefers_docker_compose_over_dockerfile() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Dockerfile"), "FROM node:20\n").unwrap();
        std::fs::write(tmp.path().join("docker-compose.yml"), "version: '3'\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("docker_compose".to_string()));
    }

    #[test]
    fn detect_host_prefers_kubernetes_over_dockerfile() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Dockerfile"), "FROM node:20\n").unwrap();
        std::fs::create_dir_all(tmp.path().join("k8s")).unwrap();
        assert_eq!(detect_host(tmp.path()), Some("kubernetes".to_string()));
    }

    #[test]
    fn detect_host_vercel_still_wins_over_everything() {
        // S3 contract: a project with vercel.json deploys to Vercel,
        // even if it also has Dockerfiles for local dev.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("vercel.json"), "{}").unwrap();
        std::fs::write(tmp.path().join("Dockerfile"), "FROM node:20\n").unwrap();
        std::fs::write(tmp.path().join("netlify.toml"), "[build]\n").unwrap();
        assert_eq!(detect_host(tmp.path()), Some("vercel".to_string()));
    }
}
