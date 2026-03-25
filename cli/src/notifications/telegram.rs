use anyhow::Result;
use serde_json::Value;

use crate::config::TelegramConfig;

pub struct TelegramClient {
    client: reqwest::Client,
    token: String,
}

impl TelegramClient {
    pub fn new(config: &TelegramConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: config.bot_token.clone(),
        }
    }

    pub fn with_token(token: &str) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: token.to_string(),
        }
    }

    pub async fn send_message(&self, chat_id: &str, text: &str) -> Result<()> {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", self.token);
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML"
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            anyhow::bail!("Telegram send error: HTTP {}", resp.status());
        }
        Ok(())
    }

    /// Poll getUpdates and return chat IDs from any received messages.
    pub async fn detect_chat_id(&self) -> Result<Option<String>> {
        let url = format!("https://api.telegram.org/bot{}/getUpdates", self.token);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            anyhow::bail!("Telegram getUpdates error: HTTP {}", resp.status());
        }

        let data: Value = resp.json().await?;
        let chat_id = data["result"]
            .as_array()
            .and_then(|updates| {
                updates.iter().find_map(|u| {
                    u.get("message")
                        .and_then(|m| m.get("chat"))
                        .and_then(|c| c.get("id"))
                        .and_then(|id| id.as_i64())
                        .map(|id| id.to_string())
                })
            });

        Ok(chat_id)
    }
}
