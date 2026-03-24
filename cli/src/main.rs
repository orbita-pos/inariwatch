mod ai;
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

    /// Configure AI key and model
    Config {
        #[arg(long = "ai-key")]
        ai_key: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        show: bool,
    },

    /// Start an MCP server over stdio (for Claude Code, Cursor, etc.)
    ServeMcp,

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
        Commands::Watch { project } => commands::watch::run(project).await,
        Commands::Status { project } => commands::status::run(project).await,
        Commands::Logs { limit, project } => commands::logs::run(limit, project).await,
        Commands::Config { ai_key, model, show } => {
            commands::config_cmd::run(ai_key, model, show).await
        }
        Commands::ServeMcp => commands::serve_mcp::run().await,
        Commands::Rollback { service, project } => {
            commands::rollback::run(&service, project).await
        }
    }
}
