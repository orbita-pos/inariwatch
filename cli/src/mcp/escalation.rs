/// CLI escalation — sends Telegram notification with AI context when trigger_fix fails.
use crate::config;
use crate::notifications::telegram::{esc, TelegramClient};

pub struct EscalationContext {
    pub alert_title: String,
    pub project: String,
    pub reason: String,
    pub diagnosis: Option<String>,
    pub confidence: Option<u32>,
    pub attempts: Option<usize>,
    pub max_attempts: Option<usize>,
    pub ci_error: Option<String>,
    pub pr_url: Option<String>,
    pub branch: Option<String>,
}

/// Try to send escalation via Telegram. Returns Ok(true) if sent, Ok(false) if no config.
pub async fn escalate(ctx: &EscalationContext) -> anyhow::Result<bool> {
    let cfg = config::load()?;

    // Find the project's Telegram config
    let tg_config = cfg
        .projects
        .iter()
        .find(|p| p.name == ctx.project || p.slug == ctx.project)
        .and_then(|p| p.notifications.telegram.as_ref());

    let tg_config = match tg_config {
        Some(c) => c,
        None => return Ok(false),
    };

    let client = TelegramClient::new(tg_config);
    let message = build_message(ctx);
    client.send_message(&tg_config.chat_id, &message).await?;
    Ok(true)
}

fn build_message(ctx: &EscalationContext) -> String {
    let mut lines = vec![
        format!("🚨 <b>[AI Escalation]</b> {}", esc(&ctx.alert_title)),
        String::new(),
        format!("<b>Project:</b> {}", esc(&ctx.project)),
        format!("<b>Reason:</b> {}", esc(&ctx.reason)),
    ];

    if let Some(diag) = &ctx.diagnosis {
        lines.push(format!("<b>Diagnosis:</b> {}", esc(&truncate(diag, 200))));
    }

    if let Some(conf) = ctx.confidence {
        lines.push(format!("<b>Confidence:</b> {}%", conf));
    }

    if let (Some(att), Some(max)) = (ctx.attempts, ctx.max_attempts) {
        lines.push(format!("<b>Attempts:</b> {}/{}", att, max));
    }

    if let Some(ci) = &ctx.ci_error {
        lines.push(format!("<b>CI error:</b> {}", esc(&truncate(ci, 150))));
    }

    if let Some(pr) = &ctx.pr_url {
        lines.push(format!("<b>PR:</b> {}", esc(pr)));
    }

    if let Some(branch) = &ctx.branch {
        lines.push(format!("<b>Branch:</b> {}", esc(branch)));
    }

    lines.push(String::new());
    lines.push("Manual investigation needed.".to_string());

    lines.join("\n")
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Find a valid UTF-8 character boundary to avoid panic on multi-byte chars
    let boundary = s
        .char_indices()
        .take_while(|(i, _)| *i < max)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    format!("{}…", &s[..boundary])
}
