use anyhow::Result;
use chrono::{DateTime, Utc};
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

// ── Incident Storm Detection ────────────────────────────────────────────────

const STORM_THRESHOLD: usize = 5;
const STORM_WINDOW_MINUTES: i64 = 5;

struct StormDetector {
    recent_timestamps: Vec<DateTime<Utc>>,
    active: bool,
}

impl StormDetector {
    fn new() -> Self {
        Self {
            recent_timestamps: Vec::new(),
            active: false,
        }
    }

    /// Record new alerts and check if we're in a storm.
    /// Returns true if these alerts should be batched (storm active).
    fn record(&mut self, count: usize) -> bool {
        let now = Utc::now();
        for _ in 0..count {
            self.recent_timestamps.push(now);
        }
        // Prune timestamps older than the storm window
        let cutoff = now - chrono::Duration::minutes(STORM_WINDOW_MINUTES);
        self.recent_timestamps.retain(|t| *t > cutoff);

        let was_active = self.active;
        self.active = self.recent_timestamps.len() >= STORM_THRESHOLD;

        // Return true if storm just started or is ongoing
        if self.active && !was_active {
            true // Storm just triggered
        } else {
            self.active // Ongoing storm suppresses individual notifications
        }
    }

    fn alert_count_in_window(&self) -> usize {
        self.recent_timestamps.len()
    }
}

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

        let fp = crate::mcp::fingerprint::compute_error_fingerprint(&title, &body);
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
            fingerprint: Some(fp),
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

pub async fn run(project_name: Option<String>, shadow: bool) -> Result<()> {
    crate::banner::print_banner().await;
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

    let capture_enabled = project.integrations.capture.as_ref().map(|c| c.enabled).unwrap_or(false);

    let has_any = project.integrations.github.is_some()
        || project.integrations.vercel.is_some()
        || project.integrations.sentry.is_some()
        || project.integrations.git.is_some()
        || capture_enabled
        || project.integrations.uptime.is_some();

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
        if cfg.global.auto_fix {
            let merge_note = if cfg.global.auto_merge { " + auto-merge" } else { "" };
            format!("AI {} | auto-fix {}", "ON".green(), format!("ON{}", merge_note).green())
        } else {
            format!("AI {}", "ON".green())
        }
    } else {
        format!("AI {} (set with `inariwatch config --ai-key`)", "OFF".dimmed())
    };

    println!(
        "{} Watching {} — {}",
        "◉".cyan(),
        project.name.bold(),
        ai_status
    );
    if shadow {
        println!("  {} Shadow mode — diagnose without acting", "\u{1F441}".dimmed());
    }
    println!("  Polling every {}s. {}\n", POLL_SECS, "Ctrl+C to stop.".dimmed());

    // Start capture server if enabled
    let mut capture_rx = if capture_enabled {
        let port = project.integrations.capture.as_ref().map(|c| c.port).unwrap_or(9111);
        let (_handle, rx) = crate::capture_server::start_capture_server(port);
        println!("  {} Capture listening on :{}\n", "◉".cyan(), port);
        Some(rx)
    } else {
        None
    };

    let mut storm = StormDetector::new();

    loop {
        let ts = chrono::Local::now().format("%H:%M:%S").to_string();
        let conn = db::open()?;

        match run_cycle(&project, &conn, &cfg.global, &mut storm, &mut capture_rx).await {
            Ok((0, _)) => println!("{}  {} all clear", ts.dimmed(), "✓".green()),
            Ok((n, new_alerts)) => {
                if storm.active {
                    println!(
                        "{}  {} INCIDENT STORM — {} alerts in {} min (batched)",
                        ts.dimmed(),
                        "🌩️".bold(),
                        storm.alert_count_in_window(),
                        STORM_WINDOW_MINUTES
                    );
                } else {
                    println!("{}  {} {} alert(s) sent", ts.dimmed(), "📨".bold(), n);
                }
                if shadow && cfg.global.ai_key.is_some() {
                    // Shadow mode: diagnose without acting, save predictions
                    for alert in new_alerts.into_iter().filter(|a| a.severity == "critical") {
                        let alert_id = alert.id.clone();
                        let project_slug = project.slug.clone();
                        println!("  {} Shadow: analyzing \"{}\"", "\u{1F441}".dimmed(), alert.title.dimmed());
                        tokio::spawn(async move {
                            if let Err(e) = run_shadow_prediction(&alert_id, &project_slug).await {
                                println!("  Shadow prediction failed: {}", e);
                            }
                        });
                    }
                } else if !shadow && cfg.global.auto_fix && cfg.global.ai_key.is_some() {
                    // Auto-fix: spawn a background task for each critical alert
                    for alert in new_alerts.into_iter().filter(|a| a.severity == "critical") {
                        let alert_id = alert.id.clone();
                        let auto_merge = cfg.global.auto_merge;
                        println!("  {} Queuing auto-fix for: {}", "🤖".bold(), alert.title.dimmed());
                        tokio::spawn(async move {
                            let args = serde_json::json!({
                                "alert_id": alert_id,
                                "auto_merge": auto_merge,
                            });
                            match crate::mcp::tools::trigger_fix::execute(&args).await {
                                Ok(result) => {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&result) {
                                        let status = v["status"].as_str().unwrap_or("unknown");
                                        let pr = v["pr_url"].as_str().unwrap_or("");
                                        if pr.is_empty() {
                                            println!("  {} Auto-fix [{}]: {}", "🤖".bold(), &alert_id[..8], status);
                                        } else {
                                            println!("  {} Auto-fix [{}]: {} → {}", "🤖".bold(), &alert_id[..8], status, pr);
                                        }
                                    }
                                }
                                Err(e) => {
                                    println!("  {} Auto-fix [{}] failed: {}", "✗".red(), &alert_id[..8], e);
                                }
                            }
                        });
                    }
                }
            }
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
    storm: &mut StormDetector,
    capture_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<RawEvent>>,
) -> Result<(usize, Vec<Alert>)> {
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

    // Uptime health checks
    if let Some(up) = &project.integrations.uptime {
        all_events.extend(collect_uptime(up).await);
    }

    // Drain events from the capture server (errors + logs + deploys)
    if let Some(rx) = capture_rx.as_mut() {
        while let Ok(event) = rx.try_recv() {
            all_events.push(event);
        }
    }

    // 2. Dedup
    let new_events: Vec<RawEvent> = all_events
        .into_iter()
        .filter(|e| !db::fingerprint_exists(conn, &e.fingerprint).unwrap_or(false))
        .collect();

    if new_events.is_empty() {
        return Ok((0, vec![]));
    }

    // 3. Group by time proximity → one alert per group
    let groups = group_by_time(new_events, CORRELATION_WINDOW_MINUTES);
    let mut sent = 0;
    let mut new_alerts: Vec<Alert> = vec![];

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

        let fp = crate::mcp::fingerprint::compute_error_fingerprint(&title, &body);
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
            fingerprint: Some(fp),
        };

        db::insert_alert(conn, &alert)?;
        new_alerts.push(alert);
    }

    // 5. Storm detection + send notifications
    let is_storm = storm.record(new_alerts.len());

    if is_storm && new_alerts.len() > 1 {
        // Batch all alerts into a single storm notification
        let storm_title = format!(
            "INCIDENT STORM — {} alerts in {} min",
            storm.alert_count_in_window(),
            STORM_WINDOW_MINUTES
        );
        let storm_body = new_alerts
            .iter()
            .map(|a| {
                let icon = match a.severity.as_str() {
                    "critical" => "🔴",
                    "warning" => "⚠️",
                    _ => "ℹ️",
                };
                format!("{} {}", icon, a.title)
            })
            .collect::<Vec<_>>()
            .join("\n");

        if let Some(tg) = &project.notifications.telegram {
            let msg = format!(
                "🌩️ <b>{}</b>\n\n{}\n\n<i>Individual notifications suppressed during storm.</i>\n\n<i>— Kairo</i>",
                storm_title, storm_body
            );
            TelegramClient::new(tg).send_message(&tg.chat_id, &msg).await?;
            sent += 1;
        } else {
            println!("  {} {}", "🌩️".bold(), storm_title.bold());
            for a in &new_alerts {
                println!("    {} {}", match a.severity.as_str() {
                    "critical" => "🔴",
                    "warning" => "⚠️",
                    _ => "ℹ️",
                }, a.title.dimmed());
            }
        }
    } else {
        // Normal: send each alert individually
        for alert in &new_alerts {
            let icon = match alert.severity.as_str() {
                "critical" => "🔴",
                "warning" => "⚠️",
                _ => "ℹ️",
            };

            if let Some(tg) = &project.notifications.telegram {
                let msg = format!(
                    "{} <b>{}</b>\n\n{}\n\n<i>— Kairo</i>",
                    icon, alert.title, alert.body
                );
                TelegramClient::new(tg).send_message(&tg.chat_id, &msg).await?;
                sent += 1;
            } else {
                println!("  {} {}", icon, alert.title.bold());
                for line in alert.body.lines().take(5) {
                    println!("    {}", line.dimmed());
                }
            }
        }
    }

    Ok((sent, new_alerts))
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

// ── Uptime health checks ─────────────────────────────────────────────────────

async fn collect_uptime(cfg: &config::UptimeConfig) -> Vec<RawEvent> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
        .build()
        .unwrap_or_default();

    match client.get(&cfg.url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status != cfg.expected_status {
                vec![RawEvent {
                    integration: "uptime".into(),
                    event_type: "health_check_failed".into(),
                    fingerprint: format!("uptime_status_{}_{}", cfg.url, day_key()),
                    occurred_at: Utc::now(),
                    payload: serde_json::json!({
                        "url": cfg.url,
                        "expected": cfg.expected_status,
                        "actual": status,
                    }),
                    severity: "critical".into(),
                    title: format!("Health check failed: HTTP {}", status),
                    detail: format!(
                        "{} returned HTTP {} (expected {})",
                        cfg.url, status, cfg.expected_status
                    ),
                    url: Some(cfg.url.clone()),
                }]
            } else {
                vec![]
            }
        }
        Err(e) => {
            let reason = if e.is_timeout() {
                "timeout".to_string()
            } else if e.is_connect() {
                "connection refused".to_string()
            } else {
                format!("{}", e)
            };
            vec![RawEvent {
                integration: "uptime".into(),
                event_type: "health_check_down".into(),
                fingerprint: format!("uptime_down_{}_{}", cfg.url, day_key()),
                occurred_at: Utc::now(),
                payload: serde_json::json!({
                    "url": cfg.url,
                    "error": reason,
                }),
                severity: "critical".into(),
                title: format!("App DOWN: {}", reason),
                detail: format!("{} is unreachable — {}", cfg.url, reason),
                url: Some(cfg.url.clone()),
            }]
        }
    }
}

// ── Shadow mode ──────────────────────────────────────────────────────────────

/// Run trigger_fix in dry_run mode and save the prediction to the shadow_predictions table.
async fn run_shadow_prediction(alert_id: &str, project: &str) -> anyhow::Result<()> {
    let args = serde_json::json!({
        "alert_id": alert_id,
        "dry_run": true,
    });
    let result = crate::mcp::tools::trigger_fix::execute(&args).await?;
    let parsed: serde_json::Value = serde_json::from_str(&result)?;

    let status = parsed["status"].as_str().unwrap_or("");
    if status == "aborted" || status == "error" {
        return Ok(()); // diagnosis failed, nothing to save
    }

    let conn = db::open()?;
    let prediction = db::ShadowPrediction {
        id: uuid::Uuid::new_v4().to_string(),
        project: project.to_string(),
        alert_id: alert_id.to_string(),
        alert_fingerprint: parsed["fingerprint"].as_str().map(String::from),
        alert_title: parsed["alert_title"].as_str().unwrap_or("").to_string(),
        predicted_diagnosis: parsed["diagnosis"].as_str().unwrap_or("").to_string(),
        predicted_files: parsed["files_changed"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        predicted_fix_approach: parsed["explanation"].as_str().unwrap_or("").to_string(),
        confidence: parsed["confidence"].as_i64().unwrap_or(0) as i32,
        created_at: Utc::now(),
        human_fix_detected: false,
        human_fix_matched: false,
        human_fix_files: None,
        resolved_at: None,
    };

    let title_preview: String = prediction.alert_title.chars().take(50).collect();
    let n_files = prediction.predicted_files.len();
    let conf = prediction.confidence;

    db::save_shadow_prediction(&conn, &prediction)?;
    println!(
        "  \u{1F441} Shadow: predicted fix for \"{}\" ({}% confidence, {} files)",
        title_preview, conf, n_files,
    );
    Ok(())
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
