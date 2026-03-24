use serde_json::{json, Value};

use crate::ai;
use crate::ai::prompts::RemediationContext;
use crate::config;
use crate::db;
use crate::integrations::github::GitHubClient;
use crate::integrations::sentry::SentryClient;
use crate::integrations::vercel::VercelClient;

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let alert_id = args["alert_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("alert_id is required"))?;
    let include_context = args["include_context"].as_bool().unwrap_or(true);

    // Load alert
    let conn = db::open()?;
    let alert = db::get_alert_by_id(&conn, alert_id)?
        .ok_or_else(|| anyhow::anyhow!("Alert not found: {}", alert_id))?;

    // Load config
    let cfg = config::load()?;
    let ai_key = cfg
        .global
        .ai_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No AI key configured. Run `inariwatch config --ai-key <key>`"))?;

    // Find the project config
    let project = cfg
        .projects
        .iter()
        .find(|p| p.slug == alert.project || p.name == alert.project);

    // Gather context from integrations in parallel
    let mut context = RemediationContext::default();

    if include_context {
        if let Some(proj) = project {
            let sentry_fut = async {
                if let Some(sentry_cfg) = &proj.integrations.sentry {
                    let client = SentryClient::new(sentry_cfg);
                    // Try to get recent issues and find one matching the alert
                    if let Ok(issues) = client.get_new_issues(24).await {
                        for issue in &issues {
                            if alert.title.contains(&issue.title)
                                || issue.title.contains(&alert.title)
                            {
                                if let Ok(Some(trace)) =
                                    client.get_issue_latest_event(&issue.id).await
                                {
                                    return Some(trace);
                                }
                            }
                        }
                    }
                }
                None
            };

            let vercel_fut = async {
                if let Some(vercel_cfg) = &proj.integrations.vercel {
                    let client = VercelClient::new(vercel_cfg);
                    if let Ok(failed) =
                        client.get_failed_deployments(&vercel_cfg.project_id, 6).await
                    {
                        if let Some(dep) = failed.first() {
                            if let Ok((_, error_summary)) =
                                client.get_deployment_events(&dep.uid).await
                            {
                                return Some(error_summary);
                            }
                        }
                    }
                }
                None
            };

            let github_fut = async {
                if let Some(gh_cfg) = &proj.integrations.github {
                    let client = GitHubClient::new(gh_cfg);
                    if let Ok(failures) = client.get_recent_failures(3).await {
                        if let Some(run) = failures.first() {
                            if let Some(branch) = &run.head_branch {
                                if let Ok(logs) = client.get_failed_check_logs(branch).await {
                                    return Some(logs);
                                }
                            }
                        }
                    }
                }
                None
            };

            let (sentry_result, vercel_result, github_result) =
                tokio::join!(sentry_fut, vercel_fut, github_fut);

            context.sentry_stack_trace = sentry_result;
            context.vercel_build_logs = vercel_result;
            context.github_ci_logs = github_result;
        }
    }

    // Build context_sources list for the response
    let mut context_sources = Vec::new();
    if context.sentry_stack_trace.is_some() {
        context_sources.push("sentry_stack_trace");
    }
    if context.vercel_build_logs.is_some() {
        context_sources.push("vercel_build_logs");
    }
    if context.github_ci_logs.is_some() {
        context_sources.push("github_ci_logs");
    }

    // Call AI for deep analysis
    let model = Some(cfg.global.ai_model.as_str());
    let result = ai::deep_analyze(
        ai_key,
        model,
        &alert.title,
        &alert.body,
        &alert.source_integrations,
        &context,
    )
    .await?;

    // Enrich the AI response with our metadata
    let mut output = result;
    output["alert_id"] = json!(alert_id);
    if !context_sources.is_empty() {
        output["context_sources"] = json!(context_sources);
    }

    Ok(serde_json::to_string_pretty(&output)?)
}
