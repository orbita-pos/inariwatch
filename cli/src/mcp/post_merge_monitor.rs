use chrono::Utc;

use crate::config::ProjectConfig;
use crate::db;
use crate::integrations::github::GitHubClient;
use crate::integrations::sentry::SentryClient;

pub enum PostMergeResult {
    Passed,
    Reverted { revert_pr_url: String },
    RevertFailed { error: String },
}

pub struct PostMergeParams<'a> {
    pub project: &'a ProjectConfig,
    pub gh: &'a GitHubClient,
    pub merged_sha: String,
    pub alert_title: String,
    pub default_branch: String,
    pub memory_id: Option<String>,
    /// Error fingerprint for extended outcome tracking
    pub alert_fingerprint: Option<String>,
    /// Original alert ID (to exclude from recurrence checks)
    pub alert_id: Option<String>,
    /// Fix Replay web API URL (for reporting outcomes)
    pub fix_replay_url: Option<String>,
}

pub async fn run(params: PostMergeParams<'_>) -> PostMergeResult {
    let PostMergeParams {
        project,
        gh,
        merged_sha,
        alert_title,
        default_branch,
        memory_id,
        alert_fingerprint,
        alert_id,
        fix_replay_url,
    } = params;

    let merge_time = Utc::now();
    let total_secs: u64 = 600;
    let poll_secs: u64 = 60;

    // Normalize the alert title for regression matching (strip "[...]" prefix, lowercase)
    let normalized_title = {
        let stripped = alert_title
            .trim_start_matches(|c: char| c == '[')
            .to_string();
        let stripped = if let Some(pos) = stripped.find(']') {
            stripped[pos + 1..].trim().to_string()
        } else {
            stripped
        };
        stripped.to_lowercase()
    };
    let match_prefix: String = normalized_title.chars().take(40).collect();

    let mut elapsed: u64 = 0;

    while elapsed < total_secs {
        tokio::time::sleep(tokio::time::Duration::from_secs(poll_secs)).await;
        elapsed += poll_secs;

        println!(
            "  \u{1F50D} Post-merge monitor: {}s / 600s \u{2014} no regressions",
            elapsed
        );

        // Check Sentry for regressions if configured
        if let Some(sentry_cfg) = &project.integrations.sentry {
            let client = SentryClient::new(sentry_cfg);
            match client.get_issues_since(merge_time).await {
                Ok(issues) => {
                    let regression_found = issues.iter().any(|i| {
                        i.title.to_lowercase().contains(&match_prefix)
                    });

                    if regression_found {
                        // Regression detected — create a revert branch and PR
                        let revert_branch = format!("revert-{}", &merged_sha[..8.min(merged_sha.len())]);
                        let commit_message = format!(
                            "revert: auto-revert fix for \"{}\"",
                            alert_title.chars().take(50).collect::<String>()
                        );
                        let pr_body = format!(
                            "## Auto-revert by Inari AI\n\n\
                             The auto-merged fix ({}) caused a regression:\n\
                             - Sentry: Same error pattern reappeared after merge\n\n\
                             This PR reverts the changes.\n\n\
                             *Auto-reverted by Inari AI post-merge monitoring*",
                            &merged_sha[..7.min(merged_sha.len())]
                        );

                        match gh
                            .create_revert_branch(&merged_sha, &revert_branch, &commit_message)
                            .await
                        {
                            Ok(_revert_sha) => {
                                match gh
                                    .create_pr(
                                        &format!(
                                            "revert: auto-revert fix for \"{}\"",
                                            alert_title.chars().take(50).collect::<String>()
                                        ),
                                        &pr_body,
                                        &revert_branch,
                                        &default_branch,
                                        false,
                                    )
                                    .await
                                {
                                    Ok((pr_url, pr_number)) => {
                                        // Try to merge the revert PR immediately
                                        let _ = gh.merge_pr(pr_number).await;
                                        return PostMergeResult::Reverted {
                                            revert_pr_url: pr_url,
                                        };
                                    }
                                    Err(e) => {
                                        return PostMergeResult::RevertFailed {
                                            error: format!("Failed to create revert PR: {}", e),
                                        };
                                    }
                                }
                            }
                            Err(e) => {
                                return PostMergeResult::RevertFailed {
                                    error: format!("Failed to create revert branch: {}", e),
                                };
                            }
                        }
                    }
                }
                Err(_) => {
                    // If we can't reach Sentry, keep polling
                }
            }
        }
    }

    // 10-min active monitoring passed — spawn extended 20-min background check
    if let (Some(mem_id), Some(fp), Some(a_id)) =
        (memory_id, alert_fingerprint, alert_id)
    {
        let replay_url = fix_replay_url;
        tokio::spawn(async move {
            run_extended_monitor(mem_id, fp, a_id, replay_url).await;
        });
    }

    PostMergeResult::Passed
}

/// Extended outcome monitor — runs as a fire-and-forget background task.
/// Waits an additional 20 minutes after the 10-min active monitor (total 30 min from merge).
/// Checks if the same error fingerprint recurred. If yes, marks fix as failed. If not, boosts confidence.
async fn run_extended_monitor(
    memory_id: String,
    alert_fingerprint: String,
    alert_id: String,
    fix_replay_url: Option<String>,
) {
    // Wait 20 more minutes (10 already passed in the active monitor)
    tokio::time::sleep(tokio::time::Duration::from_secs(1200)).await;

    let conn = match db::open() {
        Ok(c) => c,
        Err(_) => return,
    };

    let since = Utc::now() - chrono::Duration::minutes(30);
    match db::has_alert_with_fingerprint_since(&conn, &alert_fingerprint, since, &alert_id) {
        Ok(true) => {
            // Recurrence detected — mark fix as failed, decrease confidence
            let _ = db::mark_memory_failed(&conn, &memory_id);
            let _ = db::update_memory_confidence(&conn, &memory_id, -20);
            // Look up community_fix_id before dropping conn
            let cfi = get_community_fix_id(&conn, &memory_id);
            drop(conn);
            report_outcome(cfi.as_deref(), false, &fix_replay_url).await;
            println!("  \u{26A0} Extended monitor: alert recurred \u{2014} fix marked as failed");
        }
        Ok(false) => {
            // Clean — boost confidence
            let _ = db::update_memory_confidence(&conn, &memory_id, 5);
            let cfi = get_community_fix_id(&conn, &memory_id);
            drop(conn);
            report_outcome(cfi.as_deref(), true, &fix_replay_url).await;
            println!("  \u{2713} Extended monitor: 30 min clean \u{2014} fix confirmed");
        }
        Err(_) => {}
    }
}

/// Look up the community_fix_id from an incident memory record.
fn get_community_fix_id(conn: &rusqlite::Connection, memory_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT community_fix_id FROM incident_memory WHERE id = ?1",
        rusqlite::params![memory_id],
        |row| row.get(0),
    )
    .ok()
    .flatten()
}

/// Report fix outcome to the web API via /api/patterns/rate.
async fn report_outcome(
    fix_id: Option<&str>,
    worked: bool,
    fix_replay_url: &Option<String>,
) {
    let base_url = match fix_replay_url {
        Some(url) => url,
        None => return,
    };

    let fix_id = match fix_id {
        Some(id) => id,
        None => return,
    };

    let url = format!("{}/api/patterns/rate", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let _ = client
        .post(&url)
        .json(&serde_json::json!({
            "fixId": fix_id,
            "worked": worked,
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
}
