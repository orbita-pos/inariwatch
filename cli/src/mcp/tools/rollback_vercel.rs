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
            .ok_or_else(|| anyhow::anyhow!("No project found. Specify --project or run from a project directory."))?
    };

    let vercel_config = project
        .integrations
        .vercel
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No Vercel integration configured for project '{}'", project.name))?;

    let client = VercelClient::new(vercel_config);
    let deployment_id = args["deployment_id"].as_str();

    // Resolve target deployment
    let target = if let Some(id) = deployment_id {
        // Use the specified deployment directly
        let deployments = client
            .get_recent_ready_deployments(&vercel_config.project_id, 20)
            .await?;
        deployments
            .into_iter()
            .find(|d| d.uid == id)
            .ok_or_else(|| anyhow::anyhow!("Deployment {} not found or not in READY state", id))?
    } else {
        // Auto-select last successful production deployment
        let deployments = client
            .get_recent_ready_deployments(&vercel_config.project_id, 10)
            .await?;
        deployments
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No successful production deployments found to roll back to"))?
    };

    let target_id = target.uid.clone();
    let branch = target.meta.as_ref().and_then(|m| m.branch.clone()).unwrap_or_default();
    let commit_sha = target
        .meta
        .as_ref()
        .and_then(|m| m.commit_sha.clone())
        .unwrap_or_default();
    let url = target.url.clone().unwrap_or_default();
    let created_at = target.created_at().to_rfc3339();

    // Perform rollback
    client
        .rollback_to(&vercel_config.project_id, &target_id)
        .await?;

    Ok(serde_json::to_string_pretty(&json!({
        "status": "success",
        "rolled_back_to": {
            "deployment_id": target_id,
            "branch": branch,
            "commit_sha": commit_sha,
            "created_at": created_at,
            "url": format!("https://{}", url)
        }
    }))?)
}
