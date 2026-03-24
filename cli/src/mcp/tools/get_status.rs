use serde_json::Value;

use crate::config;

pub async fn execute(_args: &Value) -> anyhow::Result<String> {
    let cfg = config::load()?;
    if cfg.projects.is_empty() {
        return Ok(
            "No projects configured. Run `inariwatch init` to get started.".to_string(),
        );
    }
    let mut out = format!("{} project(s):\n\n", cfg.projects.len());
    for p in &cfg.projects {
        out.push_str(&format!("• {} ({})\n", p.name, p.slug));
        let i = &p.integrations;
        if i.github.is_some() {
            out.push_str("  ✓ GitHub\n");
        }
        if i.vercel.is_some() {
            out.push_str("  ✓ Vercel\n");
        }
        if i.sentry.is_some() {
            out.push_str("  ✓ Sentry\n");
        }
        if i.git.is_some() {
            out.push_str("  ✓ Git (local)\n");
        }
        out.push('\n');
    }
    let ai = if cfg.global.ai_key.is_some() {
        format!("AI: enabled ({})", cfg.global.ai_model)
    } else {
        "AI: not configured (run `inariwatch config --ai-key <key>`)".to_string()
    };
    out.push_str(&ai);
    Ok(out)
}
