use chrono::Utc;

use crate::config::ProjectConfig;
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
}

pub async fn run(params: PostMergeParams<'_>) -> PostMergeResult {
    let PostMergeParams {
        project,
        gh,
        merged_sha,
        alert_title,
        default_branch,
        memory_id: _,
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

    PostMergeResult::Passed
}
