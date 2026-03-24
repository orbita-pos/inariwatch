mod ai;
mod banner;
mod commands;
mod config;
mod db;
mod integrations;
mod mcp;
mod notifications;
mod orchestrator;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "inariwatch", about = "Proactive developer monitoring orchestrator", version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new project
    Init,

    /// Add an integration (github, vercel, sentry, git)
    Add { integration: String },

    /// Connect a notification channel (telegram)
    Connect { channel: String },

    /// Start the monitoring loop
    Watch {
        #[arg(short, long)]
        project: Option<String>,
        /// Shadow mode: diagnose alerts without acting. Saves predictions for comparison.
        #[arg(long)]
        shadow: bool,
    },

    /// Show status of all integrations
    Status {
        #[arg(short, long)]
        project: Option<String>,
    },

    /// Show recent alerts
    Logs {
        #[arg(short, long, default_value = "20")]
        limit: usize,
        #[arg(short, long)]
        project: Option<String>,
    },

    /// Configure AI key, model, and daemon behaviour
    Config {
        #[arg(long = "ai-key")]
        ai_key: Option<String>,
        #[arg(long)]
        model: Option<String>,
        /// Enable autonomous AI fix pipeline on critical alerts
        #[arg(long)]
        auto_fix: Option<bool>,
        /// Auto-merge generated PRs when all safety gates pass (requires --auto-fix true)
        #[arg(long)]
        auto_merge: Option<bool>,
        /// Query shared community fix patterns before AI diagnosis (opt-in)
        #[arg(long)]
        fix_replay: Option<bool>,
        /// InariWatch web API URL for Fix Replay (e.g. "https://app.inariwatch.com")
        #[arg(long)]
        fix_replay_url: Option<String>,
        #[arg(long)]
        show: bool,
    },

    /// Generate or view a post-mortem for a resolved alert
    Postmortem {
        /// The alert ID to generate the post-mortem for
        alert_id: String,
    },

    /// Start an MCP server over stdio (for Claude Code, Cursor, etc.)
    ServeMcp,

    /// Show AI agent track record and trust level
    AgentStats {
        #[arg(short, long)]
        project: Option<String>,
    },

    /// Manage the background monitoring daemon
    Daemon {
        /// Action: install | uninstall | start | stop | status
        action: String,
    },

    /// Review pending fix outcomes and provide feedback
    Feedback {
        #[arg(short, long)]
        project: Option<String>,
    },

    /// Roll back a deployment (vercel)
    Rollback {
        /// Service to roll back: vercel
        service: String,
        #[arg(short, long)]
        project: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init => commands::init::run().await,
        Commands::Add { integration } => commands::add::run(&integration).await,
        Commands::Connect { channel } => commands::connect::run(&channel).await,
        Commands::Watch { project, shadow } => commands::watch::run(project, shadow).await,
        Commands::Status { project } => commands::status::run(project).await,
        Commands::Logs { limit, project } => commands::logs::run(limit, project).await,
        Commands::Config { ai_key, model, auto_fix, auto_merge, fix_replay, fix_replay_url, show } => {
            commands::config_cmd::run(ai_key, model, auto_fix, auto_merge, fix_replay, fix_replay_url, show).await
        }
        Commands::Postmortem { alert_id } => commands::postmortem::run(&alert_id).await,
        Commands::Feedback { project } => commands::feedback::run(project).await,
        Commands::AgentStats { project } => commands::agent_stats::run(project).await,
        Commands::Daemon { action } => commands::daemon::run(&action).await,
        Commands::ServeMcp => commands::serve_mcp::run().await,
        Commands::Rollback { service, project } => {
            commands::rollback::run(&service, project).await
        }
    }
}
