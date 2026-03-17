use anyhow::Result;
use colored::Colorize;
use dialoguer::Input;

use crate::config::{self, TelegramConfig};
use crate::notifications::telegram::TelegramClient;

pub async fn run(channel: &str) -> Result<()> {
    match channel.to_lowercase().as_str() {
        "telegram" => connect_telegram().await,
        "whatsapp" => {
            println!("WhatsApp — coming soon! Use Telegram for now.");
            Ok(())
        }
        other => {
            println!("{} Unknown channel: {}", "✗".red(), other);
            println!("Available: {}", "telegram".cyan());
            Ok(())
        }
    }
}

async fn connect_telegram() -> Result<()> {
    println!("{}", "kairo connect telegram".bold());
    println!("Connect your Telegram bot\n");

    let mut cfg = config::load()?;
    let idx = super::pick_project(&cfg)?;

    println!("Setup steps:");
    println!("  1. Open Telegram and message {}", "@BotFather".cyan());
    println!("  2. Send {} → follow the prompts → copy the token", "/newbot".cyan());
    println!();

    let bot_token: String = Input::new()
        .with_prompt("Bot token (123456:ABC-DEF...)")
        .interact_text()?;

    // Validate token format before hitting the API
    if !bot_token.contains(':') {
        println!("{} Token looks wrong — it should contain a colon.", "✗".red());
        return Ok(());
    }

    println!();
    println!(
        "Now open Telegram, find your bot, and send it any message (e.g. {}).",
        "/start".cyan()
    );
    println!("Press Enter here when you've done that...");

    let mut buf = String::new();
    std::io::stdin().read_line(&mut buf)?;

    print!("Auto-detecting your chat ID... ");

    let client = TelegramClient::with_token(&bot_token);
    let chat_id = client.detect_chat_id().await?;

    let chat_id = match chat_id {
        Some(id) => {
            println!("{} found ({})", "✓".green(), id.cyan());
            id
        }
        None => {
            println!("{} not found.", "✗".red());
            println!(
                "You can get your chat ID from {} — then enter it below.",
                "@userinfobot".cyan()
            );
            Input::new()
                .with_prompt("Chat ID")
                .interact_text()?
        }
    };

    let tg_cfg = TelegramConfig {
        bot_token: bot_token.clone(),
        chat_id: chat_id.clone(),
    };

    print!("Sending test message... ");
    let project_name = cfg.projects[idx].name.clone();
    match client.send_message(
        &chat_id,
        &format!(
            "👁 <b>Kairo is watching <code>{}</code></b>\n\nYou'll get alerts here when something needs your attention.",
            project_name
        ),
    ).await {
        Ok(_) => println!("{}", "✓ sent!".green()),
        Err(e) => {
            println!("{} {}", "✗".red(), e);
            return Ok(());
        }
    }

    cfg.projects[idx].notifications.telegram = Some(tg_cfg);
    config::save(&cfg)?;

    println!(
        "\n{} Telegram connected to project {}.",
        "✓".green(),
        cfg.projects[idx].name.bold()
    );

    Ok(())
}
