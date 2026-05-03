//! Public dispatch entry points. Mirror of
//! `packages/ai-router/src/dispatch.ts`.
//!
//! Surfaces (cli/, desktop/src-tauri/) MUST go through [`dispatch`] /
//! [`dispatch_stream`]. The lockdown integration test (`tests/lockdown.rs`)
//! enforces that no Rust source outside this crate contains a provider
//! URL string.
//!
//! v0.3 S7 wires two dispatch modes:
//!
//! - **complete** — single-shot non-streaming response. Used by every
//!   `cli/` AI call and by desktop's `chat_complete` path.
//! - **stream** — token-by-token streaming. Used exclusively by desktop's
//!   `chat_stream` (Sesión 18 dock chat).
//!
//! Tool-use, vision, and embed are intentionally not wired — neither
//! `cli/` nor `desktop/src-tauri/` currently dispatch those through the
//! cloud (desktop's `embeddings` already delegates to local fastembed).

use std::time::Duration;

use futures_util::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::adapters::cloud_proxy::{self, CloudCallInput, CloudError, CloudMode};
use crate::adapters::llamacpp::{self, LocalSidecarError};
use crate::providers::types::{AIMessage, AIResponse, ChatChunk};
use crate::receipts::{emit_receipt, RelayPath, RouterReceipt};
use crate::rules::{
    get_rule, resolve_primary, AIProvider, FallbackTrigger, Rule, Substrate, Target,
    WorkspacePreferences,
};
use crate::tasks::{namespace_of, TaskName};

// ── Public input/output ───────────────────────────────────────────────────

/// Workspace + identity context. Mirrors the relevant fields of the TS
/// `WorkspaceContext`. Optional everywhere because cli/ standalone has
/// no cloud workspace.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceContext {
    pub user_id: Option<String>,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub alert_id: Option<String>,
    pub remediation_session_id: Option<String>,
    /// True when `api_key` is the platform-funded key (PLATFORM_AI_KEY).
    /// Mirrors `isPlatformKey` in the TS receipt.
    pub is_platform_key: bool,
    pub preferences: Option<WorkspacePreferences>,
}

/// Single-call dispatch payload. Borrowed for zero-copy when the caller
/// already owns the prompts + messages (the common case from
/// cli/src/ai/mod.rs).
#[derive(Debug, Clone)]
pub struct DispatchInput<'a> {
    pub task: TaskName,
    pub api_key: &'a str,
    pub system_prompt: &'a str,
    pub messages: &'a [AIMessage],
    pub max_tokens: u32,

    pub model: Option<&'a str>,
    pub timeout: Option<Duration>,
    pub temperature: Option<f32>,
    pub json_mode: bool,
    /// Caller-explicit provider override. Wins over `detect_provider`
    /// and the rule's hint (matches TS `pickProvider` precedence).
    pub provider: Option<AIProvider>,
    pub workspace: Option<&'a WorkspaceContext>,
    /// Test-only override. Production callers leave this `None` and the
    /// dispatcher reads env vars via [`CloudMode::from_env`].
    pub cloud_mode_override: Option<CloudMode>,
    /// Test-only override that points the direct-mode HTTP call at a
    /// different host (e.g. `http://127.0.0.1:1234` from a mockito
    /// fixture). Ignored in proxy mode and on local substrates.
    /// Production callers leave this `None` so the adapter uses the
    /// pinned provider URL from `providers/*::default()`.
    pub base_url_override: Option<&'a str>,
}

impl<'a> DispatchInput<'a> {
    /// Construct a minimal input. Convenience for cli/ callers that
    /// always pass system + messages and want defaults for the rest.
    pub fn new(
        task: TaskName,
        api_key: &'a str,
        system_prompt: &'a str,
        messages: &'a [AIMessage],
        max_tokens: u32,
    ) -> DispatchInput<'a> {
        DispatchInput {
            task,
            api_key,
            system_prompt,
            messages,
            max_tokens,
            model: None,
            timeout: None,
            temperature: None,
            json_mode: false,
            provider: None,
            workspace: None,
            cloud_mode_override: None,
            base_url_override: None,
        }
    }
}

/// Optional helper struct surfaces can use when they want a "config
/// bag" instead of building [`DispatchInput`] inline. Pure ergonomics —
/// the dispatcher reads from [`DispatchInput`] only.
#[derive(Debug, Clone, Default)]
pub struct CallOpts {
    pub task: Option<TaskName>,
    pub max_tokens: Option<u32>,
    pub model: Option<String>,
    pub timeout: Option<Duration>,
    pub temperature: Option<f32>,
    pub json_mode: bool,
    pub provider: Option<AIProvider>,
}

/// Ergonomic alias retained so future modes (tool-use, vision, embed)
/// can be added without breaking imports.
pub type DispatchOutput = AIResponse;

/// Future-proofing tags so consumers that already imported these from
/// `lib.rs` still compile after we wire the missing modes. v0.3 S7
/// leaves these as type aliases — no behavior.
pub type ToolUseInput<'a> = DispatchInput<'a>;
pub type VisionInput<'a> = DispatchInput<'a>;
pub type EmbedInput<'a> = DispatchInput<'a>;
pub type DispatchStreamChunk = ChatChunk;

#[derive(Debug, Error)]
pub enum DispatchError {
    #[error("cloud dispatch: {0}")]
    Cloud(#[from] CloudError),
    #[error("sidecar dispatch: {0}")]
    Sidecar(#[from] LocalSidecarError),
    #[error("substrate {0:?} not implemented in v0.3")]
    SubstrateNotImplemented(Substrate),
}

impl DispatchError {
    fn fallback_trigger(&self) -> Option<FallbackTrigger> {
        match self {
            DispatchError::Sidecar(e) => match e {
                LocalSidecarError::Offline(_) => Some(FallbackTrigger::SidecarOffline),
                LocalSidecarError::Timeout(_) => Some(FallbackTrigger::SidecarTimeout),
                LocalSidecarError::Disconnect(_) => Some(FallbackTrigger::SidecarOffline),
                LocalSidecarError::Other(_) => Some(FallbackTrigger::SidecarOffline),
            },
            DispatchError::Cloud(e) => match e.http_status() {
                Some(429) => Some(FallbackTrigger::CloudRateLimit),
                Some(s) if (500..=599).contains(&s) => Some(FallbackTrigger::CloudError),
                _ => None,
            },
            DispatchError::SubstrateNotImplemented(_) => None,
        }
    }
}

fn should_fallback(err: &DispatchError, triggers: &Option<Vec<FallbackTrigger>>) -> bool {
    let triggers = match triggers {
        Some(t) if !t.is_empty() => t,
        _ => return false,
    };
    let observed = match err.fallback_trigger() {
        Some(t) => t,
        None => return false,
    };
    triggers.contains(&observed)
}

// ── Internal target runners ───────────────────────────────────────────────

struct RunResult {
    output: AIResponse,
    substrate: Substrate,
    provider_label: String,
    relay_path: RelayPath,
}

async fn run_on_target_complete(
    input: &DispatchInput<'_>,
    target: &Target,
) -> Result<RunResult, DispatchError> {
    match target {
        Target::Cloud { .. } => {
            let mode = input
                .cloud_mode_override
                .clone()
                .unwrap_or_else(CloudMode::from_env);
            let relay_path = match &mode {
                CloudMode::Direct => RelayPath::Direct,
                CloudMode::Proxy { .. } => RelayPath::Relay,
            };
            let call = CloudCallInput {
                task: input.task,
                api_key: input.api_key,
                system_prompt: input.system_prompt,
                messages: input.messages,
                model: input.model,
                max_tokens: input.max_tokens,
                temperature: input.temperature,
                timeout: input.timeout,
                json_mode: input.json_mode,
                provider_override: input.provider,
                base_url_override: input.base_url_override,
            };
            let resp = cloud_proxy::run_complete(call, target, &mode).await?;
            let provider_label = resp.provider.as_str().to_string();
            Ok(RunResult {
                output: resp,
                substrate: Substrate::Cloud,
                provider_label,
                relay_path,
            })
        }
        Target::UserSidecar { model } => {
            let resp = llamacpp::run_complete(
                input.task,
                input.system_prompt,
                input.messages,
                Some(model.as_str()),
                input.max_tokens,
            )
            .await?;
            Ok(RunResult {
                output: resp,
                substrate: Substrate::UserSidecar,
                provider_label: "user-sidecar".to_string(),
                relay_path: RelayPath::Relay,
            })
        }
        Target::CaptureEmbedded { .. } => Err(DispatchError::SubstrateNotImplemented(
            Substrate::CaptureEmbedded,
        )),
        Target::CliLinked { .. } => Err(DispatchError::SubstrateNotImplemented(
            Substrate::CliLinked,
        )),
    }
}

async fn run_on_target_stream(
    input: &DispatchInput<'_>,
    target: &Target,
) -> Result<
    (
        std::pin::Pin<Box<dyn Stream<Item = Result<ChatChunk, DispatchError>> + Send>>,
        Substrate,
        String,
        RelayPath,
    ),
    DispatchError,
> {
    match target {
        Target::Cloud { .. } => {
            let mode = input
                .cloud_mode_override
                .clone()
                .unwrap_or_else(CloudMode::from_env);
            let relay_path = match &mode {
                CloudMode::Direct => RelayPath::Direct,
                CloudMode::Proxy { .. } => RelayPath::Relay,
            };
            let call = CloudCallInput {
                task: input.task,
                api_key: input.api_key,
                system_prompt: input.system_prompt,
                messages: input.messages,
                model: input.model,
                max_tokens: input.max_tokens,
                temperature: input.temperature,
                timeout: input.timeout,
                json_mode: false,
                provider_override: input.provider,
                base_url_override: input.base_url_override,
            };
            let inner = cloud_proxy::run_stream(call, target, &mode).await?;
            let provider_label = input
                .provider
                .map(|p| p.as_str().to_string())
                .unwrap_or_else(|| AIProvider::Openai.as_str().to_string());
            let mapped = inner.map(|r| r.map_err(DispatchError::Cloud));
            Ok((
                Box::pin(mapped),
                Substrate::Cloud,
                provider_label,
                relay_path,
            ))
        }
        Target::UserSidecar { .. }
        | Target::CaptureEmbedded { .. }
        | Target::CliLinked { .. } => {
            // Streaming on local substrates rides their own protocol;
            // surfaces should call the sidecar directly when they want
            // streamed local output (Inari Live S18 frontend already
            // does this for chat). Surface a clear error so the
            // dispatcher's fallback machinery can route to cloud.
            Err(DispatchError::Sidecar(LocalSidecarError::Offline(
                "streaming on local substrates is not routed through ai-router-rs in v0.3"
                    .to_string(),
            )))
        }
    }
}

// ── Public entry: complete ────────────────────────────────────────────────

/// Dispatch a complete (non-streaming) AI call. Returns the assembled
/// [`AIResponse`] including text, model, provider, and token usage.
///
/// This function is the **only** path through which `cli/src/ai/*` and
/// `desktop/src-tauri/src/ai/*` should reach a cloud LLM. The lockdown
/// integration test enforces that the URL strings live only inside this
/// crate.
pub async fn dispatch(input: DispatchInput<'_>) -> Result<AIResponse, DispatchError> {
    let ts_start = unix_ms_now();
    let rule: Rule = get_rule(input.task);
    let prefs = input.workspace.and_then(|w| w.preferences.as_ref());
    let primary = resolve_primary(input.task, prefs);

    let mut used_fallback = false;
    let result = match run_on_target_complete(&input, &primary).await {
        Ok(r) => r,
        Err(e) => {
            if let Some(fallback) = rule.fallback.as_ref() {
                if should_fallback(&e, &rule.fallback_triggers) {
                    used_fallback = true;
                    run_on_target_complete(&input, fallback).await?
                } else {
                    return Err(e);
                }
            } else {
                return Err(e);
            }
        }
    };

    emit_dispatch_receipt(
        input.task,
        ts_start,
        &result,
        used_fallback,
        input.workspace,
    );

    Ok(result.output)
}

// ── Public entry: stream ──────────────────────────────────────────────────

/// Dispatch a streaming AI call. The returned stream yields [`ChatChunk`]s;
/// the terminal chunk carries `finish_reason: Some(_)` (and, when the
/// provider exposes it, `usage`). A receipt is emitted exactly once
/// after the stream completes.
pub async fn dispatch_stream(
    input: DispatchInput<'_>,
) -> Result<
    std::pin::Pin<Box<dyn Stream<Item = Result<ChatChunk, DispatchError>> + Send>>,
    DispatchError,
> {
    let ts_start = unix_ms_now();
    let rule = get_rule(input.task);
    let prefs = input.workspace.and_then(|w| w.preferences.as_ref());
    let primary = resolve_primary(input.task, prefs);

    let workspace_snapshot = input.workspace.cloned();
    let task = input.task;

    let stream_result = run_on_target_stream(&input, &primary).await;

    let (inner_stream, substrate, provider_label, relay_path, used_fallback) = match stream_result {
        Ok((s, sub, prov, rp)) => (s, sub, prov, rp, false),
        Err(e) => {
            if let Some(fallback) = rule.fallback.as_ref() {
                if should_fallback(&e, &rule.fallback_triggers) {
                    let (s, sub, prov, rp) =
                        run_on_target_stream(&input, fallback).await?;
                    (s, sub, prov, rp, true)
                } else {
                    return Err(e);
                }
            } else {
                return Err(e);
            }
        }
    };

    // Wrap the stream so we can emit the receipt after the terminal
    // chunk passes through. We track usage + model across chunks and
    // fire emit_receipt exactly once on stream completion.
    let wrapped = stream_completion_receipt(
        inner_stream,
        ReceiptCarry {
            task,
            ts_start,
            substrate,
            provider_label,
            relay_path,
            used_fallback,
            workspace: workspace_snapshot,
        },
    );

    Ok(Box::pin(wrapped))
}

// ── Receipts ──────────────────────────────────────────────────────────────

fn emit_dispatch_receipt(
    task: TaskName,
    ts_start: u64,
    result: &RunResult,
    fallback_used: bool,
    workspace: Option<&WorkspaceContext>,
) {
    let usage = result.output.usage;
    emit_receipt(RouterReceipt {
        task,
        namespace: namespace_of(task),
        substrate: result.substrate,
        provider: result.provider_label.clone(),
        model: result.output.model.clone(),
        ts_start,
        ts_end: unix_ms_now(),
        workspace_id: workspace.and_then(|w| w.workspace_id.clone()),
        user_id: workspace.and_then(|w| w.user_id.clone()),
        project_id: workspace.and_then(|w| w.project_id.clone()),
        alert_id: workspace.and_then(|w| w.alert_id.clone()),
        remediation_session_id: workspace.and_then(|w| w.remediation_session_id.clone()),
        is_platform_key: workspace.map(|w| w.is_platform_key).unwrap_or(false),
        fallback_used,
        // null-vs-zero policy mirrors persist-receipt.ts:53-55.
        input_tokens: if usage.input_tokens > 0 {
            Some(usage.input_tokens)
        } else {
            None
        },
        output_tokens: if usage.output_tokens > 0 {
            Some(usage.output_tokens)
        } else {
            None
        },
        cached_input_tokens: if usage.cached_input_tokens > 0 {
            Some(usage.cached_input_tokens)
        } else {
            None
        },
        payload_hash: None,
        response_hash: None,
        relay_path: Some(result.relay_path),
        signature: None,
        user_sidecar_receipt: None,
    });
}

struct ReceiptCarry {
    task: TaskName,
    ts_start: u64,
    substrate: Substrate,
    provider_label: String,
    relay_path: RelayPath,
    used_fallback: bool,
    workspace: Option<WorkspaceContext>,
}

fn stream_completion_receipt<S>(
    inner: S,
    carry: ReceiptCarry,
) -> impl Stream<Item = Result<ChatChunk, DispatchError>> + Send
where
    S: Stream<Item = Result<ChatChunk, DispatchError>> + Send + Unpin + 'static,
{
    use futures_util::stream;
    let state = (
        Box::pin(inner),
        carry,
        // accumulators
        crate::providers::types::AIUsage::default(),
        String::new(),
        false, // emitted
    );
    stream::unfold(state, |(mut inner, carry, mut usage, model, mut emitted)| async move {
        // `model` is currently never assigned because OpenAI-style SSE
        // chunks do not carry the model id (it appears only on the
        // initial `chat.completion.chunk` we ignore + on the JSON
        // response). Phase 4+ may grow ChatChunk to expose it; until
        // then receipts for streamed dispatches record `model = ""` —
        // /admin/ops shows "—" for those rows, matching TS behavior.
        match inner.next().await {
            Some(Ok(chunk)) => {
                if let Some(u) = chunk.usage {
                    usage = u;
                }
                let is_terminal = chunk.finish_reason.is_some();
                if is_terminal && !emitted {
                    emit_stream_receipt(&carry, &usage, &model);
                    emitted = true;
                }
                Some((Ok(chunk), (inner, carry, usage, model, emitted)))
            }
            Some(Err(e)) => {
                if !emitted {
                    emit_stream_receipt(&carry, &usage, &model);
                    emitted = true;
                }
                Some((Err(e), (inner, carry, usage, model, emitted)))
            }
            None => {
                if !emitted {
                    emit_stream_receipt(&carry, &usage, &model);
                }
                None
            }
        }
    })
}

fn emit_stream_receipt(
    carry: &ReceiptCarry,
    usage: &crate::providers::types::AIUsage,
    model: &str,
) {
    emit_receipt(RouterReceipt {
        task: carry.task,
        namespace: namespace_of(carry.task),
        substrate: carry.substrate,
        provider: carry.provider_label.clone(),
        model: model.to_string(),
        ts_start: carry.ts_start,
        ts_end: unix_ms_now(),
        workspace_id: carry.workspace.as_ref().and_then(|w| w.workspace_id.clone()),
        user_id: carry.workspace.as_ref().and_then(|w| w.user_id.clone()),
        project_id: carry.workspace.as_ref().and_then(|w| w.project_id.clone()),
        alert_id: carry.workspace.as_ref().and_then(|w| w.alert_id.clone()),
        remediation_session_id: carry
            .workspace
            .as_ref()
            .and_then(|w| w.remediation_session_id.clone()),
        is_platform_key: carry
            .workspace
            .as_ref()
            .map(|w| w.is_platform_key)
            .unwrap_or(false),
        fallback_used: carry.used_fallback,
        input_tokens: if usage.input_tokens > 0 {
            Some(usage.input_tokens)
        } else {
            None
        },
        output_tokens: if usage.output_tokens > 0 {
            Some(usage.output_tokens)
        } else {
            None
        },
        cached_input_tokens: if usage.cached_input_tokens > 0 {
            Some(usage.cached_input_tokens)
        } else {
            None
        },
        payload_hash: None,
        response_hash: None,
        relay_path: Some(carry.relay_path),
        signature: None,
        user_sidecar_receipt: None,
    });
}

fn unix_ms_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::llamacpp::{install_local_sidecar, uninstall_local_sidecar, LocalSidecar};
    use crate::providers::types::AIUsage;
    use crate::receipts::{clear_receipt_sinks, register_receipt_sink};
    use crate::rules::WorkspacePreferences;
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    fn drain_receipts() -> Arc<Mutex<Vec<RouterReceipt>>> {
        clear_receipt_sinks();
        let log = Arc::new(Mutex::new(Vec::new()));
        let l2 = log.clone();
        register_receipt_sink(move |r| l2.lock().unwrap().push(r.clone()));
        log
    }

    #[tokio::test]
    async fn dispatch_routes_cloud_proxy_when_mode_set() {
        let log = drain_receipts();
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/api/ai/dispatch")
            .with_status(200)
            .with_body(
                r#"{"text":"prose","model":"gpt-4o-mini","provider":"openai","usage":{"input_tokens":4,"output_tokens":2,"cached_input_tokens":0}}"#,
            )
            .create_async()
            .await;

        let messages = vec![AIMessage::user("hi")];
        let mode = CloudMode::Proxy {
            url: server.url(),
            token: "tk".to_string(),
        };
        let mut input = DispatchInput::new(
            TaskName::AlertAutoAnalyze,
            "",
            "be terse",
            &messages,
            128,
        );
        input.cloud_mode_override = Some(mode);
        let resp = dispatch(input).await.expect("dispatch ok");
        assert_eq!(resp.text, "prose");
        assert_eq!(resp.provider, AIProvider::Openai);
        assert_eq!(resp.usage.input_tokens, 4);

        let receipts = log.lock().unwrap();
        assert_eq!(receipts.len(), 1);
        let r = &receipts[0];
        assert_eq!(r.task, TaskName::AlertAutoAnalyze);
        assert_eq!(r.substrate, Substrate::Cloud);
        assert_eq!(r.relay_path, Some(RelayPath::Relay));
        assert_eq!(r.input_tokens, Some(4));
        assert_eq!(r.fallback_used, false);
        assert!(r.signature.is_none());
    }

    struct EchoSidecar;
    #[async_trait]
    impl LocalSidecar for EchoSidecar {
        async fn complete(
            &self,
            _task: TaskName,
            _system_prompt: &str,
            messages: &[AIMessage],
            _model_hint: Option<&str>,
            _max_tokens: u32,
        ) -> Result<AIResponse, LocalSidecarError> {
            Ok(AIResponse {
                text: format!("local: {}", messages.last().map(|m| m.content.as_str()).unwrap_or("")),
                usage: AIUsage::default(),
                model: "qwen2.5-coder-1.5b".to_string(),
                provider: AIProvider::Openai,
            })
        }
    }

    #[tokio::test]
    async fn dispatch_routes_to_user_sidecar_when_flag_on() {
        let _log = drain_receipts();
        install_local_sidecar(EchoSidecar);
        let messages = vec![AIMessage::user("compose this")];
        let prefs = WorkspacePreferences {
            local_notify_enabled: Some(true),
            ..Default::default()
        };
        let workspace = WorkspaceContext {
            preferences: Some(prefs),
            ..Default::default()
        };
        let mut input = DispatchInput::new(
            TaskName::NotifyComposeEmail,
            "",
            "compose",
            &messages,
            128,
        );
        input.workspace = Some(&workspace);
        let resp = dispatch(input).await.expect("dispatch ok");
        assert_eq!(resp.text, "local: compose this");
        uninstall_local_sidecar();
    }

    struct OfflineSidecar;
    #[async_trait]
    impl LocalSidecar for OfflineSidecar {
        async fn complete(
            &self,
            _t: TaskName,
            _s: &str,
            _m: &[AIMessage],
            _h: Option<&str>,
            _x: u32,
        ) -> Result<AIResponse, LocalSidecarError> {
            Err(LocalSidecarError::Offline("simulated offline".to_string()))
        }
    }

    #[tokio::test]
    async fn dispatch_falls_back_from_sidecar_to_cloud() {
        let log = drain_receipts();
        install_local_sidecar(OfflineSidecar);
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/api/ai/dispatch")
            .with_status(200)
            .with_body(
                r#"{"text":"cloud-fallback","model":"gpt-4o-mini","provider":"openai","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}"#,
            )
            .expect(1)
            .create_async()
            .await;

        let messages = vec![AIMessage::user("compose me")];
        let prefs = WorkspacePreferences {
            local_notify_enabled: Some(true),
            ..Default::default()
        };
        let workspace = WorkspaceContext {
            preferences: Some(prefs),
            ..Default::default()
        };
        let mut input = DispatchInput::new(
            TaskName::NotifyComposeEmail,
            "",
            "",
            &messages,
            64,
        );
        input.workspace = Some(&workspace);
        input.cloud_mode_override = Some(CloudMode::Proxy {
            url: server.url(),
            token: "t".to_string(),
        });
        let resp = dispatch(input).await.expect("fallback ok");
        assert_eq!(resp.text, "cloud-fallback");

        let receipts = log.lock().unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].fallback_used, true);
        assert_eq!(receipts[0].substrate, Substrate::Cloud);
        uninstall_local_sidecar();
    }

    #[test]
    fn should_fallback_matches_429_to_rate_limit() {
        let err = DispatchError::Cloud(CloudError::Provider(
            crate::providers::openai_compat::ProviderError::Api {
                status: 429,
                body: "x".to_string(),
            },
        ));
        let triggers = Some(vec![FallbackTrigger::CloudRateLimit]);
        assert!(should_fallback(&err, &triggers));
    }

    #[test]
    fn should_fallback_matches_500_range_to_cloud_error() {
        let err = DispatchError::Cloud(CloudError::Provider(
            crate::providers::openai_compat::ProviderError::Api {
                status: 503,
                body: "x".to_string(),
            },
        ));
        let triggers = Some(vec![FallbackTrigger::CloudError]);
        assert!(should_fallback(&err, &triggers));
    }

    #[test]
    fn should_fallback_misses_unrelated_trigger() {
        let err = DispatchError::Cloud(CloudError::Provider(
            crate::providers::openai_compat::ProviderError::Api {
                status: 401,
                body: "x".to_string(),
            },
        ));
        let triggers = Some(vec![FallbackTrigger::CloudError]);
        assert!(!should_fallback(&err, &triggers));
    }

    #[test]
    fn should_fallback_matches_sidecar_offline() {
        let err = DispatchError::Sidecar(LocalSidecarError::Offline("x".to_string()));
        let triggers = Some(vec![FallbackTrigger::SidecarOffline]);
        assert!(should_fallback(&err, &triggers));
    }
}
