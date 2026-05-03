//! Anthropic `/v1/messages` adapter.
//!
//! Mirrors `cli/src/ai/mod.rs::call_claude_raw`. Distinct from OpenAI:
//! - Auth header is `x-api-key`, not `Authorization: Bearer`.
//! - Requires `anthropic-version: 2023-06-01`.
//! - Body shape uses `system` as a top-level field rather than a
//!   `role: "system"` message.
//! - Response shape is `{ content: [{ text: ... }] }`.
//!
//! ## Lockdown boundary
//!
//! The `https://api.anthropic.com` URL string lives ONLY in this file.
//! See `super::openai_compat` for the matching boundary on the
//! OpenAI-compatible URLs.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::openai_compat::ProviderError;
use super::types::{AIMessage, AIResponse, AIUsage, Role};
use crate::rules::AIProvider;

#[derive(Debug, Clone)]
pub struct AnthropicAdapter {
    pub base_url: String,
    pub api_path: &'static str,
    pub default_model: &'static str,
}

impl Default for AnthropicAdapter {
    fn default() -> Self {
        AnthropicAdapter {
            base_url: "https://api.anthropic.com".to_string(),
            api_path: "/v1/messages",
            default_model: "claude-haiku-4-5-20251001",
        }
    }
}

impl AnthropicAdapter {
    /// Override the base URL so callers can point the adapter at a
    /// mock server. Reachable from production code via
    /// [`crate::dispatch::DispatchInput::base_url_override`].
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    fn url(&self) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), self.api_path)
    }

    pub async fn complete(
        &self,
        api_key: &str,
        system_prompt: &str,
        messages: &[AIMessage],
        model: Option<&str>,
        max_tokens: u32,
        temperature: Option<f32>,
        timeout: Option<Duration>,
    ) -> Result<AIResponse, ProviderError> {
        if api_key.is_empty() {
            return Err(ProviderError::NoKey);
        }
        let body = build_body(
            system_prompt,
            messages,
            model.unwrap_or(self.default_model),
            max_tokens,
            temperature,
        );

        let mut builder = reqwest::Client::builder();
        builder = builder.timeout(timeout.unwrap_or(Duration::from_secs(60)));
        let client = builder.build().map_err(ProviderError::Http)?;

        let resp = client
            .post(self.url())
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api {
                status,
                body: redact(&body, api_key),
            });
        }

        let parsed: ClaudeResponse = resp.json().await?;
        let text = parsed
            .content
            .into_iter()
            .filter_map(|b| b.text)
            .collect::<Vec<_>>()
            .join("");

        let usage = parsed.usage.unwrap_or_default();
        Ok(AIResponse {
            text,
            usage: AIUsage {
                input_tokens: usage.input_tokens.unwrap_or(0) as i64,
                output_tokens: usage.output_tokens.unwrap_or(0) as i64,
                cached_input_tokens: usage.cache_read_input_tokens.unwrap_or(0) as i64,
            },
            model: parsed.model.unwrap_or_else(|| {
                model.unwrap_or(self.default_model).to_string()
            }),
            provider: AIProvider::Claude,
        })
    }
}

fn build_body(
    system_prompt: &str,
    messages: &[AIMessage],
    model: &str,
    max_tokens: u32,
    temperature: Option<f32>,
) -> Value {
    // Anthropic does not accept a system role inside `messages`. We
    // surface it as a top-level field. If callers passed a system
    // message we promote its content to the system slot — keeps surface
    // code symmetric with the OpenAI-compat path even though the wire
    // shape diverges.
    let mut effective_system = system_prompt.to_string();
    let mut user_msgs: Vec<Value> = Vec::with_capacity(messages.len());
    for m in messages {
        match m.role {
            Role::System => {
                if !effective_system.is_empty() {
                    effective_system.push_str("\n\n");
                }
                effective_system.push_str(&m.content);
            }
            Role::User | Role::Assistant => {
                user_msgs.push(json!({ "role": m.role.as_str(), "content": m.content }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": user_msgs,
    });
    if !effective_system.is_empty() {
        body["system"] = json!(effective_system);
    }
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    body
}

fn redact(body: &str, key: &str) -> String {
    if key.is_empty() {
        return body.to_string();
    }
    body.replace(key, "<redacted>")
}

// ── Wire types ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ClaudeResponse {
    #[serde(default)]
    content: Vec<ClaudeBlock>,
    #[serde(default)]
    usage: Option<ClaudeUsage>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeBlock {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Default, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: Option<u32>,
    #[serde(default)]
    output_tokens: Option<u32>,
    #[serde(default)]
    cache_read_input_tokens: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_body_promotes_system_message_to_top_level() {
        let body = build_body(
            "be terse",
            &[
                AIMessage::system("also be polite"),
                AIMessage::user("hi"),
            ],
            "claude-haiku-4-5",
            256,
            None,
        );
        assert_eq!(body["system"], "be terse\n\nalso be polite");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "hi");
    }

    #[test]
    fn build_body_omits_system_when_no_system_prompt() {
        let body = build_body("", &[AIMessage::user("hi")], "claude-haiku-4-5", 256, None);
        assert!(body.get("system").is_none());
    }

    #[test]
    fn build_body_includes_temperature() {
        let body = build_body("s", &[AIMessage::user("u")], "x", 256, Some(0.7));
        let t = body["temperature"].as_f64().expect("number");
        assert!((t - 0.7).abs() < 1e-3, "got {t}");
    }

    #[tokio::test]
    async fn complete_round_trips_against_mockito() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-ant-test")
            .match_header("anthropic-version", "2023-06-01")
            .with_status(200)
            .with_body(
                r#"{"content":[{"text":"hi"}, {"text":" back"}],"usage":{"input_tokens":12,"output_tokens":4},"model":"claude-haiku-4-5-20251001"}"#,
            )
            .create_async()
            .await;

        let adapter = AnthropicAdapter::default().with_base_url(server.url());
        let resp = adapter
            .complete(
                "sk-ant-test",
                "be terse",
                &[AIMessage::user("hi")],
                None,
                64,
                None,
                Some(Duration::from_secs(5)),
            )
            .await
            .expect("complete");
        assert_eq!(resp.text, "hi back");
        assert_eq!(resp.usage.input_tokens, 12);
        assert_eq!(resp.usage.output_tokens, 4);
        assert_eq!(resp.model, "claude-haiku-4-5-20251001");
        assert_eq!(resp.provider, AIProvider::Claude);
        m.assert_async().await;
    }

    #[tokio::test]
    async fn complete_redacts_key_in_error() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/messages")
            .with_status(401)
            .with_body("auth: sk-ant-leaked")
            .create_async()
            .await;
        let adapter = AnthropicAdapter::default().with_base_url(server.url());
        let err = adapter
            .complete(
                "sk-ant-leaked",
                "",
                &[AIMessage::user("hi")],
                None,
                64,
                None,
                Some(Duration::from_secs(2)),
            )
            .await
            .unwrap_err();
        match err {
            ProviderError::Api { status, body } => {
                assert_eq!(status, 401);
                assert!(body.contains("<redacted>"));
                assert!(!body.contains("sk-ant-leaked"));
            }
            other => panic!("unexpected error {other:?}"),
        }
    }
}
