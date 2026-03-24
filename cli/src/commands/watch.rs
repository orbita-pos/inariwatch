use anyhow::Result;
use chrono::Utc;
use colored::Colorize;
use uuid::Uuid;

use crate::ai;
use crate::config::{self, ProjectConfig};
use crate::db::{self, Alert};
use crate::integrations::git_local;
use crate::integrations::github::GitHubClient;
use crate::integrations::sentry::SentryClient;
use crate::integrations::vercel::VercelClient;
use crate::notifications::telegram::TelegramClient;
use crate::orchestrator::correlator::group_by_time;
use crate::orchestrator::RawEvent;

const POLL_SECS: u64 = 60;
/// Events within this window are treated as potentially related.
const CORRELATION_WINDOW_MINUTES: i64 = 30;

/// Run one monitoring cycle without sending notifications.
/// Returns newly detected alerts (already persisted to the local DB).
pub async fn poll_once(project_name: Option<String>) -> anyhow::Result<Vec<db::Alert>> {
    let cfg = config::load()?;
    if cfg.projects.is_empty() {
        return Ok(vec![]);
    }

    let project = if let Some(ref name) = project_name {
        cfg.projects
            .iter()
            .find(|p| p.name == *name || p.slug == *name)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found", name))?
            .clone()
    } else {
        config::current_project(&cfg)
            .ok_or_else(|| anyhow::anyhow!("No project found"))?
            .clone()
    };

    let conn = db::open()?;
    let mut all_events: Vec<RawEvent> = vec![];

    if let Some(gh) = &project.integrations.github {
        all_events.extend(collect_github(gh).await);
    }
    if let Some(vc) = &project.integrations.vercel {
        all_events.extend(collect_vercel(vc).await);
    }
    if let Some(sn) = &project.integrations.sentry {
        all_events.extend(collect_sentry(sn).await);
    }
    if let Some(git) = &project.integrations.git {
        let repo_path = git.path.as_deref().or(project.path.as_deref()).unwrap_or(".");
        all_events.extend(collect_git(git, repo_path));
    }

    let new_events: Vec<RawEvent> = all_events
        .into_iter()
        .filter(|e| !db::fingerprint_exists(&conn, &e.fingerprint).unwrap_or(false))
        .collect();

    if new_events.is_empty() {
        return Ok(vec![]);
    }

    let groups = group_by_time(new_events, CORRELATION_WINDOW_MINUTES);
    let mut result = vec![];

    for group in groups {
        let (severity, title, body) = if group.events.len() > 1 && cfg.global.ai_key.is_some() {
            match ai::analyze(&cfg.global, &group.events).await {
                Ok(Some(a)) => {
                    let body = match (&a.root_cause, &a.suggested_action) {
                        (Some(rc), Some(sa)) => {
                            format!("{}\n\nRoot cause: {}\nNext: {}", a.body, rc, sa)
                        }
                        _ => a.body,
                    };
                    (a.severity, a.title, body)
                }
                Ok(None) => (group.severity.clone(), group.format_title(), group.format_body()),
                Err(_) => (group.severity.clone(), group.format_title(), group.format_body()),
            }
        } else {
            (group.severity.clone(), group.format_title(), group.format_body())
        };

        for e in &group.events {
            let _ = db::insert_event(
                &conn,
                &Uuid::new_v4().to_string(),
                &project.slug,
                &e.integration,
                &e.event_type,
                &e.payload.to_string(),
                &e.fingerprint,
                &e.occurred_at.to_rfc3339(),
            );
        }

        let source_integrations: Vec<String> = {
            let mut seen = std::collections::HashSet::new();
            group
                .events
                .iter()
                .filter(|e| seen.insert(e.integration.clone()))
                .map(|e| e.integration.clone())
                .collect()
        };

        let alert = db::Alert {
            id: Uuid::new_v4().to_string(),
            project: project.slug.clone(),
            severity,
            title,
            body,
            source_integrations,
            is_read: false,
            sent_at: None,
            created_at: Utc::now(),
        };
        db::insert_alert(&conn, &alert)?;
        result.push(alert);
    }

    Ok(result)
}

// ── Fingerprint helpers ───────────────────────────────────────────────────────
//
// One-time events (CI run, deploy, Sentry issue):  fingerprint = stable ID
//   → alert exactly once per occurrence
//
// Recurring situations (stale PR, unpushed branch, stale branch):
//   fingerprint includes an ISO week key  → re-alerts once per week
//   Use day_key() for more urgent things (Sentry spikes).

fn week_key() -> String {
    Utc::now().format("%Y-W%V").to_string()
}

fn day_key() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub async fn run(project_name: Option<String>) -> Result<()> {
    let cfg = config::load()?;

    if cfg.projects.is_empty() {
        println!("{} No projects. Run {} first.", "✗".red(), "inariwatch init".cyan());
        return Ok(());
    }

    let project = if let Some(ref name) = project_name {
        cfg.projects
            .iter()
            .find(|p| p.name == *name || p.slug == *name)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found", name))?
            .clone()
    } else {
        config::current_project(&cfg)
            .ok_or_else(|| anyhow::anyhow!("No project. Run inariwatch init."))?
            .clone()
    };

    let has_any = project.integrations.github.is_some()
        || project.integrations.vercel.is_some()
        || project.integrations.sentry.is_some()
        || project.integrations.git.is_some();

    if !has_any {
        println!(
            "{} No integrations for {}. Run {} to add one.",
            "✗".red(),
            project.name.bold(),
            "inariwatch add github".cyan()
        );
        return Ok(());
    }

    if project.notifications.telegram.is_none() {
        println!(
            "{} No notification channel — alerts will print here.",
            "⚠".yellow()
        );
        println!(
            "  Run {} to enable Telegram.\n",
            "inariwatch connect telegram".cyan()
        );
    }

    let ai_status = if cfg.global.ai_key.is_some() {
        format!("AI {}", "ON".green())
    } else {
        format!("AI {} (set with `inariwatch config --ai-key`)", "OFF".dimmed())
    };

    println!(
        "{} Watching {} — {}",
        "◉".cyan(),
        project.name.bold(),
        ai_status
    );
    println!("  Polling every {}s. {}\n", POLL_SECS, "Ctrl+C to stop.".dimmed());

    loop {
        let ts = chrono::Local::now().format("%H:%M:%S").to_string();
        let conn = db::open()?;

        match run_cycle(&project, &conn, &cfg.global).await {
            Ok(0) => println!("{}  {} all clear", ts.dimmed(), "✓".green()),
            Ok(n) => println!("{}  {} {} alert(s) sent", ts.dimmed(), "📨".bold(), n),
            Err(e) => println!("{} {} {}", ts.dimmed(), "✗".red(), e),
        }

        drop(conn);
        tokio::time::sleep(tokio::time::Duration::from_secs(POLL_SECS)).await;
    }
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async fn run_cycle(
    project: &ProjectConfig,
    conn: &rusqlite::Connection,
    global: &config::GlobalConfig,
) -> Result<usize> {
    // 1. Collect from every enabled integration
    let mut all_events: Vec<RawEvent> = vec![];

    if let Some(gh) = &project.integrations.github {
        all_events.extend(collect_github(gh).await);
    }
    if let Some(vc) = &project.integrations.vercel {
        all_events.extend(collect_vercel(vc).await);
    }
    if let Some(sn) = &project.integrations.sentry {
        all_events.extend(collect_sentry(sn).await);
    }
    if let Some(git) = &project.integrations.git {
        let repo_path = git
            .path
            .as_deref()
            .or(project.path.as_deref())
            .unwrap_or(".");
        all_events.extend(collect_git(git, repo_path));
    }

    // 2. Dedup
    let new_events: Vec<RawEvent> = all_events
        .into_iter()
        .filter(|e| !db::fingerprint_exists(conn, &e.fingerprint).unwrap_or(false))
        .collect();

    if new_events.is_empty() {
        return Ok(0);
    }

    // 3. Group by time proximity → one alert per group
    let groups = group_by_time(new_events, CORRELATION_WINDOW_MINUTES);
    let mut sent = 0;

    for group in groups {
        let (severity, title, body) = if group.events.len() > 1 && global.ai_key.is_some() {
            match ai::analyze(global, &group.events).await {
                Ok(Some(a)) => {
                    let body = match (&a.root_cause, &a.suggested_action) {
                        (Some(rc), Some(sa)) => {
                            format!("{}\n\nRoot cause: {}\nNext: {}", a.body, rc, sa)
                        }
                        _ => a.body,
                    };
                    (a.severity, a.title, body)
                }
                Ok(None) => (group.severity.clone(), group.format_title(), group.format_body()),
                Err(e) => {
                    eprintln!("  AI error (fallback): {}", e);
                    (group.severity.clone(), group.format_title(), group.format_body())
                }
            }
        } else {
            (group.severity.clone(), group.format_title(), group.format_body())
        };

        // 4. Persist events
        for e in &group.events {
            let _ = db::insert_event(
                conn,
                &Uuid::new_v4().to_string(),
                &project.slug,
                &e.integration,
                &e.event_type,
                &e.payload.to_string(),
                &e.fingerprint,
                &e.occurred_at.to_rfc3339(),
            );
        }

        let source_integrations: Vec<String> = {
            let mut seen = std::collections::HashSet::new();
            group
                .events
                .iter()
                .filter(|e| seen.insert(e.integration.clone()))
                .map(|e| e.integration.clone())
                .collect()
        };

        let alert = Alert {
            id: Uuid::new_v4().to_string(),
            project: project.slug.clone(),
            severity: severity.clone(),
            title: title.clone(),
            body: body.clone(),
            source_integrations,
            is_read: false,
            sent_at: Some(Utc::now()),
            created_at: Utc::now(),
        };

        // 5. Send
        let icon = match severity.as_str() {
            "critical" => "🔴",
            "warning" => "⚠️",
            _ => "ℹ️",
        };

        if let Some(tg) = &project.notifications.telegram {
            let correlated = if group.events.len() > 1 {
                format!(" <i>[{} correlated]</i>", group.events.len())
            } else {
                String::new()
            };
            let msg = format!(
                "{} <b>{}</b>{}\n\n{}\n\n<i>— Kairo</i>",
                icon, title, correlated, body
            );
            TelegramClient::new(tg).send_message(&tg.chat_id, &msg).await?;
            sent += 1;
        } else {
            println!("  {} {}", icon, title.bold());
            for line in body.lines().take(5) {
                println!("    {}", line.dimmed());
            }
        }

        db::insert_alert(conn, &alert)?;
    }

    Ok(sent)
}

// ── Collectors ────────────────────────────────────────────────────────────────

async fn collect_github(cfg: &config::GithubConfig) -> Vec<RawEvent> {
    let client = GitHubClient::new(cfg);
    let mut events = vec![];

    // Stale PRs — weekly fingerprint so the user gets reminded each week
    match client.get_stale_prs(cfg.stale_pr_days).await {
        Ok(prs) => {
            for pr in prs {
                let days = (Utc::now() - pr.updated_at).num_days();
                events.push(RawEvent {
                    integration: "github".into(),
                    event_type: "stale_pr".into(),
                    fingerprint: format!(
                        "github_stale_pr_{}_{}_{}", cfg.repo, pr.number, week_key()
                    ),
                    occurred_at: pr.updated_at,
                    payload: serde_json::json!({
                        "pr_number": pr.number,
                        "title":     pr.title,
                        "author":    pr.user.login,
                    }),
                    severity: "warning".into(),
                    title: format!("PR #{} stale for {} day(s)", pr.number, days),
                    detail: format!(
                        "\"{}\" by @{} — no activity for {} day(s)",
                        pr.title, pr.user.login, days
                    ),
                    url: Some(pr.html_url),
                });
            }
        }
        Err(e) => eprintln!("  GitHub stale PRs: {}", e),
    }

    // CI failures — one-time fingerprint per run ID
    match client.get_recent_failures(5).await {
        Ok(runs) => {
            for run in runs {
                let workflow = run.name.as_deref().unwrap_or("Workflow");
                let branch = run.head_branch.as_deref().unwrap_or("unknown");
                let commit = run
                    .head_commit
                    .as_ref()
                    .and_then(|c| c.message.lines().next())
                    .unwrap_or("")
                    .to_string();
                events.push(RawEvent {
                    integration: "github".into(),
                    event_type: "ci_failure".into(),
                    fingerprint: format!("github_ci_{}_{}", cfg.repo, run.id),
                    occurred_at: run.created_at,
                    payload: serde_json::json!({
                        "run_id":   run.id,
                        "workflow": workflow,
                        "branch":   branch,
                    }),
                    severity: "critical".into(),
                    title: format!("{} failed on {}", workflow, branch),
                    detail: format!("Branch: {}\nCommit: {}", branch, commit),
                    url: Some(run.html_url),
                });
            }
        }
        Err(e) => eprintln!("  GitHub CI: {}", e),
    }

    events
}

async fn collect_vercel(cfg: &config::VercelConfig) -> Vec<RawEvent> {
    let client = VercelClient::new(cfg);
    let mut events = vec![];

    match client.get_failed_deployments(&cfg.project_id, 6).await {
        Ok(deployments) => {
            for d in deployments {
                let meta = d.meta.as_ref();
                let branch = meta.and_then(|m| m.branch.as_deref()).unwrap_or("unknown").to_string();
                let author = meta.and_then(|m| m.author.as_deref()).unwrap_or("unknown").to_string();
                let commit = meta
                    .and_then(|m| m.commit_message.as_deref())
                    .and_then(|msg| msg.lines().next())
                    .unwrap_or("")
                    .to_string();

                events.push(RawEvent {
                    integration: "vercel".into(),
                    event_type: "deploy_error".into(),
                    fingerprint: format!("vercel_deploy_{}", d.uid),
                    occurred_at: d.created_at(),
                    payload: serde_json::json!({
                        "uid":    d.uid,
                        "name":   d.name,
                        "branch": branch,
                        "author": author,
                    }),
                    severity: "critical".into(),
                    title: format!("Deploy failed — {}", d.name),
                    detail: format!("Branch: {}  Author: {}\nCommit: {}", branch, author, commit),
                    url: d.url.as_deref().map(|u| format!("https://{}", u)),
                });
            }
        }
        Err(e) => eprintln!("  Vercel: {}", e),
    }

    events
}

async fn collect_sentry(cfg: &config::SentryConfig) -> Vec<RawEvent> {
    let client = SentryClient::new(cfg);
    let mut events = vec![];

    // New issues (first seen in the last 6 hours) — one-time fingerprint
    match client.get_new_issues(6).await {
        Ok(issues) => {
            for issue in issues {
                let location = issue
                    .metadata
                    .as_ref()
                    .and_then(|m| m.filename.as_deref())
                    .unwrap_or(&issue.culprit.clone().unwrap_or_default())
                    .to_string();
                let error_type = issue
                    .metadata
                    .as_ref()
                    .and_then(|m| m.error_type.as_deref())
                    .unwrap_or("")
                    .to_string();
                let detail_value = issue
                    .metadata
                    .as_ref()
                    .and_then(|m| m.value.as_deref())
                    .unwrap_or("")
                    .to_string();

                events.push(RawEvent {
                    integration: "sentry".into(),
                    event_type: "new_issue".into(),
                    fingerprint: format!("sentry_new_issue_{}", issue.id),
                    occurred_at: issue.first_seen,
                    payload: serde_json::json!({
                        "id":         issue.id,
                        "level":      issue.level,
                        "user_count": issue.user_count,
                    }),
                    severity: issue.severity().to_string(),
                    title: format!("New {}: {}", issue.level, truncate(&issue.title, 60)),
                    detail: format!(
                        "{}{}\n{} user(s) affected — {}",
                        if error_type.is_empty() { String::new() } else { format!("{}: ", error_type) },
                        detail_value,
                        issue.user_count,
                        location,
                    ),
                    url: Some(issue.permalink),
                });
            }
        }
        Err(e) => eprintln!("  Sentry new issues: {}", e),
    }

    // Spiking issues — daily fingerprint (re-alert each day while spiking)
    match client.get_spiking_issues(1, 50).await {
        Ok(issues) => {
            for issue in issues {
                events.push(RawEvent {
                    integration: "sentry".into(),
                    event_type: "spiking_issue".into(),
                    fingerprint: format!("sentry_spike_{}_{}", issue.id, day_key()),
                    occurred_at: issue.last_seen,
                    payload: serde_json::json!({
                        "id":          issue.id,
                        "event_count": issue.count,
                        "user_count":  issue.user_count,
                    }),
                    severity: issue.severity().to_string(),
                    title: format!("Sentry spike: {}", truncate(&issue.title, 55)),
                    detail: format!(
                        "{} events, {} user(s) in the last hour",
                        issue.event_count(),
                        issue.user_count,
                    ),
                    url: Some(issue.permalink),
                });
            }
        }
        Err(e) => eprintln!("  Sentry spikes: {}", e),
    }

    events
}

fn collect_git(cfg: &config::GitConfig, repo_path: &str) -> Vec<RawEvent> {
    let mut events = vec![];

    let branches = match git_local::list_branches(repo_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("  Git: {}", e);
            return events;
        }
    };

    let threshold_unpushed =
        Utc::now() - chrono::Duration::days(cfg.unpushed_days as i64);
    let threshold_stale =
        Utc::now() - chrono::Duration::days(cfg.stale_branch_days as i64);

    for branch in &branches {
        // Skip ignored patterns (simple glob: only "*" at the end supported)
        if cfg.ignore_branches.iter().any(|pat| glob_match(pat, &branch.name)) {
            continue;
        }

        // Unpushed commits older than N days
        if branch.has_upstream && branch.ahead > 0 && branch.last_commit < threshold_unpushed {
            events.push(RawEvent {
                integration: "git".into(),
                event_type: "unpushed_commits".into(),
                // Weekly fingerprint — remind once a week if still unpushed
                fingerprint: format!(
                    "git_unpushed_{}_{}_{}",
                    repo_path, branch.name, week_key()
                ),
                occurred_at: branch.last_commit,
                payload: serde_json::json!({
                    "branch": branch.name,
                    "ahead":  branch.ahead,
                }),
                severity: "warning".into(),
                title: format!("{} commit(s) unpushed on {}", branch.ahead, branch.name),
                detail: format!(
                    "Branch '{}' has {} unpushed commit(s). Last commit: {} day(s) ago.",
                    branch.name,
                    branch.ahead,
                    (Utc::now() - branch.last_commit).num_days(),
                ),
                url: None,
            });
        }

        // Stale branch: no commits in N days, not the current branch
        if !branch.is_current && branch.last_commit < threshold_stale {
            events.push(RawEvent {
                integration: "git".into(),
                event_type: "stale_branch".into(),
                fingerprint: format!(
                    "git_stale_{}_{}_{}",
                    repo_path, branch.name, week_key()
                ),
                occurred_at: branch.last_commit,
                payload: serde_json::json!({ "branch": branch.name }),
                severity: "info".into(),
                title: format!("Stale branch: {}", branch.name),
                detail: format!(
                    "No commits in {} day(s). Consider merging or deleting it.",
                    (Utc::now() - branch.last_commit).num_days(),
                ),
                url: None,
            });
        }
    }

    events
}

// ── Utilities ─────────────────────────────────────────────────────────────────

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}

/// Very simple glob: supports only a trailing `*` wildcard.
fn glob_match(pattern: &str, name: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix('*') {
        name.starts_with(prefix)
    } else {
        pattern == name
    }
}
