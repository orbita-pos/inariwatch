use serde_json::{json, Value};

use crate::config;
use crate::integrations::vercel::VercelClient;

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let cfg = config::load()?;

    // Resolve project
    let project_name = args["project"].as_str();
    let project = if let Some(name) = project_name {
        cfg.projects
            .iter()
            .find(|p| p.slug == name || p.name == name)
            .ok_or_else(|| anyhow::anyhow!("Project not found: {}", name))?
    } else {
        config::current_project(&cfg)
            .ok_or_else(|| anyhow::anyhow!("No project found. Specify project or run from a project directory."))?
    };

    let vercel_config = project
        .integrations
        .vercel
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No Vercel integration configured for project '{}'", project.name))?;

    let client = VercelClient::new(vercel_config);

    // Resolve deployment ID
    let deployment_id = if let Some(id) = args["deployment_id"].as_str() {
        id.to_string()
    } else {
        // Find the latest failed deployment
        let failed = client
            .get_failed_deployments(&vercel_config.project_id, 24)
            .await?;
        let dep = failed
            .first()
            .ok_or_else(|| anyhow::anyhow!("No failed deployments found in the last 24 hours"))?;
        dep.uid.clone()
    };

    // Fetch build logs
    let (logs, error_summary) = client.get_deployment_events(&deployment_id).await?;

    // Get deployment metadata
    let deployments = client
        .get_recent_ready_deployments(&vercel_config.project_id, 1)
        .await
        .ok();

    let branch = deployments
        .as_ref()
        .and_then(|d| d.first())
        .and_then(|d| d.meta.as_ref())
        .and_then(|m| m.branch.clone())
        .unwrap_or_default();

    let commit = deployments
        .as_ref()
        .and_then(|d| d.first())
        .and_then(|d| d.meta.as_ref())
        .and_then(|m| m.commit_sha.clone())
        .unwrap_or_default();

    Ok(serde_json::to_string_pretty(&json!({
        "deployment_id": deployment_id,
        "status": "ERROR",
        "logs": logs,
        "error_summary": error_summary,
        "branch": branch,
        "commit": commit
    }))?)
}
