//! Local-sidecar adapter trait. Implemented out-of-crate by Inari Live
//! (`desktop/src-tauri/src/ai/...`) so the runtime selection (`llama.cpp`
//! Sesión 21, Piper Sesión 5 voice, etc.) lives where the OS-specific
//! integration already exists.
//!
//! ## Why a trait, not a concrete struct
//!
//! `crates/ai-router-rs/` deliberately depends on **zero** Tauri / Tokio
//! plugin / OS-keychain crates. Making this crate "know how to spawn a
//! local llama-server" would drag the desktop dep tree
//! (window-vibrancy, tauri-plugin-*, fastembed, etc.) into `cli/`,
//! which is a 35 MB static musl binary today. The trait keeps the
//! crate substrate-agnostic.
//!
//! Inari Live registers an implementation by calling
//! [`install_local_sidecar`] at boot. From the dispatch core, when a
//! rule resolves to [`crate::rules::Substrate::UserSidecar`] AND a
//! sidecar is installed, we delegate to it. Otherwise the dispatch
//! core surfaces a `sidecar-offline` error so the rule's fallback
//! (cloud) wins transparently — same contract as the TS user-sidecar
//! provider.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::providers::types::{AIMessage, AIResponse};
use crate::tasks::TaskName;

/// Errors a local sidecar may raise. The dispatch core inspects the
/// kind to decide whether to fall back (per
/// `packages/ai-router/src/providers/user-sidecar.ts`).
#[derive(Debug, Clone, thiserror::Error)]
pub enum LocalSidecarError {
    #[error("sidecar-offline: {0}")]
    Offline(String),
    #[error("sidecar-timeout: {0}")]
    Timeout(String),
    #[error("sidecar-disconnect: {0}")]
    Disconnect(String),
    #[error("sidecar error: {0}")]
    Other(String),
}

/// A local model runner. Implementations live outside this crate
/// (typically in `desktop/src-tauri/src/ai/local_sidecar.rs`).
#[async_trait]
pub trait LocalSidecar: Send + Sync + 'static {
    async fn complete(
        &self,
        task: TaskName,
        system_prompt: &str,
        messages: &[AIMessage],
        model_hint: Option<&str>,
        max_tokens: u32,
    ) -> Result<AIResponse, LocalSidecarError>;
}

// `Arc<dyn Trait>` lets `run_complete` clone a stable handle inside the
// read-lock and drop the guard before awaiting. A `Box<dyn Trait>` would
// not work — the borrow is tied to the lock guard's lifetime.
static SIDECAR: Lazy<RwLock<Option<Arc<dyn LocalSidecar>>>> =
    Lazy::new(|| RwLock::new(None));

/// Install a local sidecar implementation. Replaces any previously
/// installed sidecar — only one is active at a time. The previous
/// sidecar (if any) lives until its last outstanding reference is
/// dropped.
pub fn install_local_sidecar<S: LocalSidecar>(sidecar: S) {
    let mut slot = SIDECAR.write().expect("SIDECAR poisoned");
    *slot = Some(Arc::new(sidecar));
}

/// Drop the installed sidecar. Visible for tests + clean shutdown.
pub fn uninstall_local_sidecar() {
    let mut slot = SIDECAR.write().expect("SIDECAR poisoned");
    *slot = None;
}

/// Returns true when an implementation is currently installed.
pub fn local_sidecar_installed() -> bool {
    SIDECAR
        .read()
        .map(|s| s.is_some())
        .unwrap_or(false)
}

/// Run a complete on the installed local sidecar, returning
/// [`LocalSidecarError::Offline`] if no sidecar is installed (mirrors
/// the TS `sidecar-offline: no active user_id` semantic).
pub async fn run_complete(
    task: TaskName,
    system_prompt: &str,
    messages: &[AIMessage],
    model_hint: Option<&str>,
    max_tokens: u32,
) -> Result<AIResponse, LocalSidecarError> {
    // Clone the Arc inside the read lock and drop the guard before the
    // await — keeping the lock across an await would block other reads
    // for the entire model invocation.
    let runner = {
        let slot = SIDECAR.read().expect("SIDECAR poisoned");
        match slot.as_ref() {
            Some(s) => Arc::clone(s),
            None => {
                return Err(LocalSidecarError::Offline(
                    "no local sidecar installed".to_string(),
                ));
            }
        }
    };
    runner
        .complete(task, system_prompt, messages, model_hint, max_tokens)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::types::AIUsage;
    use crate::rules::AIProvider;

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
            let last = messages.last().map(|m| m.content.clone()).unwrap_or_default();
            Ok(AIResponse {
                text: format!("echo: {last}"),
                usage: AIUsage::default(),
                model: "echo".to_string(),
                provider: AIProvider::Openai,
            })
        }
    }

    #[tokio::test]
    async fn run_complete_returns_offline_when_no_sidecar() {
        uninstall_local_sidecar();
        let err = run_complete(
            TaskName::NotifyComposeEmail,
            "",
            &[AIMessage::user("hi")],
            None,
            64,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, LocalSidecarError::Offline(_)));
    }

    #[tokio::test]
    async fn install_then_run_dispatches_to_sidecar() {
        install_local_sidecar(EchoSidecar);
        assert!(local_sidecar_installed());
        let resp = run_complete(
            TaskName::NotifyComposeEmail,
            "",
            &[AIMessage::user("ping")],
            None,
            64,
        )
        .await
        .expect("sidecar runs");
        assert_eq!(resp.text, "echo: ping");
        uninstall_local_sidecar();
        assert!(!local_sidecar_installed());
    }
}
