pub mod add;
pub mod agent_stats;
pub mod config_cmd;
pub mod daemon;
pub mod connect;
pub mod init;
pub mod logs;
pub mod postmortem;
pub mod rollback;
pub mod serve_mcp;
pub mod status;
pub mod watch;

use anyhow::Result;
use crate::config::Config;

/// Pick the right project index from the config.
/// - If only one project, return it automatically.
/// - If multiple, try to match current directory, else show a selector.
pub fn pick_project(cfg: &Config) -> Result<usize> {
    if cfg.projects.is_empty() {
        anyhow::bail!("No projects found. Run `inariwatch init` first.");
    }

    if cfg.projects.len() == 1 {
        return Ok(0);
    }

    // Try current directory
    let cwd = std::env::current_dir().ok();
    if let Some(cwd) = &cwd {
        for (i, p) in cfg.projects.iter().enumerate() {
            if p.path
                .as_ref()
                .map(|path| std::path::PathBuf::from(path) == *cwd)
                .unwrap_or(false)
            {
                return Ok(i);
            }
        }
    }

    // Prompt user
    let names: Vec<&str> = cfg.projects.iter().map(|p| p.name.as_str()).collect();
    let selection = dialoguer::Select::new()
        .with_prompt("Select project")
        .items(&names)
        .interact()?;

    Ok(selection)
}
