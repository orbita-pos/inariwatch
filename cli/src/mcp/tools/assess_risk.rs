use serde_json::{json, Value};

use crate::ai;
use crate::ai::prompts::{RiskAlert, RiskContext, RiskFile};
use crate::config;
use crate::db;
use crate::integrations::github::GitHubClient;

const MARKER: &str = "<!-- inariwatch-risk-assessment -->";

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let pr_number = args["pr_number"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("pr_number is required"))?;

    let cfg = config::load()?;
    let project = if let Some(name) = args["project"].as_str() {
        cfg.projects
            .iter()
            .find(|p| p.name == name || p.slug == name)
            .ok_or_else(|| anyhow::anyhow!("Project '{}' not found", name))?
            .clone()
    } else {
        config::current_project(&cfg)
            .ok_or_else(|| anyhow::anyhow!("No project. Run inariwatch init."))?
            .clone()
    };

    let gh_cfg = project
        .integrations
        .github
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No GitHub integration configured"))?;
    let gh = GitHubClient::new(gh_cfg);

    let ai_key = cfg
        .global
        .ai_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("No AI key configured"))?;

    // Fetch PR data in parallel
    let (pr_info, pr_files, diff) = tokio::try_join!(
        gh.get_pr_info(pr_number),
        gh.get_pr_files(pr_number),
        gh.get_pr_diff(pr_number),
    )?;

    // Skip tiny PRs
    let total_changes: u64 = pr_files.iter().map(|f| f.additions + f.deletions).sum();
    if total_changes < 5 {
        return Ok(json!({
            "status": "skipped",
            "reason": "PR is too small to assess (< 5 lines changed)",
            "pr_number": pr_number,
        })
        .to_string());
    }

    // Get historical context from local incident memory
    let conn = db::open()?;
    let memories = db::get_relevant_memories(&conn, &project.slug, &pr_info.title, None, 10)
        .unwrap_or_default();

    let recent_alerts: Vec<RiskAlert> = memories
        .iter()
        .map(|m| RiskAlert {
            title: m.alert_title.clone(),
            severity: if m.confidence >= 80 {
                "critical".to_string()
            } else {
                "warning".to_string()
            },
            created_at: m.created_at.format("%Y-%m-%d").to_string(),
        })
        .collect();

    // Cross-reference PR files with past incident files
    let pr_filenames: Vec<&str> = pr_files.iter().map(|f| f.filename.as_str()).collect();
    let incident_files: Vec<String> = memories
        .iter()
        .flat_map(|m| m.files_fixed.iter())
        .filter(|f| pr_filenames.contains(&f.as_str()))
        .cloned()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    let risk_ctx = RiskContext {
        pr_title: pr_info.title.clone(),
        pr_body: pr_info.body.clone(),
        files: pr_files
            .iter()
            .map(|f| RiskFile {
                filename: f.filename.clone(),
                status: f.status.clone(),
                additions: f.additions,
                deletions: f.deletions,
            })
            .collect(),
        diff,
        recent_alerts,
        incident_files,
    };

    let model = Some(cfg.global.ai_model.as_str());
    let assessment = ai::assess_risk(ai_key, model, &risk_ctx).await?;

    if assessment.trim().is_empty() {
        return Ok(json!({
            "status": "failed",
            "reason": "AI returned empty assessment",
        })
        .to_string());
    }

    // Post/update comment on the PR
    let comment_body = format!("{}\n{}", MARKER, assessment);
    let post = args["post_comment"].as_bool().unwrap_or(true);

    if post {
        match gh.find_bot_comment(pr_number, MARKER).await? {
            Some(comment_id) => gh.update_pr_comment(comment_id, &comment_body).await?,
            None => gh.comment_on_pr(pr_number, &comment_body).await?,
        }
    }

    Ok(json!({
        "status": "completed",
        "pr_number": pr_number,
        "assessment": assessment,
        "posted_comment": post,
    })
    .to_string())
}
