//! Routing rules. Mirror of `packages/ai-router/src/rules.ts`.
//!
//! Per `INARI_AI_ARCHITECTURE.md` §6 (LOCKED 2026-05-02).
//!
//! Phase 1 (S1): every task routes to cloud, behavior identical to
//! pre-refactor.
//! Phase 3 (S3): first task flipped to local (`notify.compose.email`)
//! behind the `localNotifyEnabled` workspace flag — DEFAULT OFF so
//! existing workspaces remain on cloud until they opt in.
//!
//! Adding a new AI task: 1) define it in [`crate::tasks`], 2) add a rule
//! in [`get_rule`] / [`RULES`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::tasks::TaskName;

/// Cloud provider taxonomy. Mirrors the TS `AIProvider` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AIProvider {
    Openai,
    Claude,
    Groq,
    Grok,
    Deepseek,
    Gemini,
}

impl AIProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            AIProvider::Openai => "openai",
            AIProvider::Claude => "claude",
            AIProvider::Groq => "groq",
            AIProvider::Grok => "grok",
            AIProvider::Deepseek => "deepseek",
            AIProvider::Gemini => "gemini",
        }
    }
}

/// Substrate taxonomy. Mirrors the TS `Substrate` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Substrate {
    #[serde(rename = "cloud")]
    Cloud,
    #[serde(rename = "user-sidecar")]
    UserSidecar,
    #[serde(rename = "capture-embedded")]
    CaptureEmbedded,
    #[serde(rename = "cli-linked")]
    CliLinked,
}

impl Substrate {
    pub const fn as_str(self) -> &'static str {
        match self {
            Substrate::Cloud => "cloud",
            Substrate::UserSidecar => "user-sidecar",
            Substrate::CaptureEmbedded => "capture-embedded",
            Substrate::CliLinked => "cli-linked",
        }
    }
}

/// Mirrors the TS `FallbackTrigger` union. Used by [`crate::dispatch`]'s
/// `should_fallback` to decide whether an error qualifies for trying the
/// rule's fallback target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FallbackTrigger {
    #[serde(rename = "sidecar-offline")]
    SidecarOffline,
    #[serde(rename = "sidecar-timeout")]
    SidecarTimeout,
    #[serde(rename = "workspace-flag-cloud-only")]
    WorkspaceFlagCloudOnly,
    #[serde(rename = "cloud-error")]
    CloudError,
    #[serde(rename = "cloud-rate-limit")]
    CloudRateLimit,
    #[serde(rename = "cloud-budget-exceeded")]
    CloudBudgetExceeded,
}

/// Mirrors the TS `Target` discriminated union. The cloud variant's
/// `provider` and `model` fields are advisory hints in Phase 1 — caller
/// intent wins. Phase 3+ pins them on substrate-locked tasks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "substrate", rename_all = "kebab-case")]
pub enum Target {
    #[serde(rename = "cloud")]
    Cloud {
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<AIProvider>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    #[serde(rename = "user-sidecar")]
    UserSidecar { model: String },
    #[serde(rename = "capture-embedded")]
    CaptureEmbedded { model: String },
    #[serde(rename = "cli-linked")]
    CliLinked { model: String },
}

impl Target {
    pub fn substrate(&self) -> Substrate {
        match self {
            Target::Cloud { .. } => Substrate::Cloud,
            Target::UserSidecar { .. } => Substrate::UserSidecar,
            Target::CaptureEmbedded { .. } => Substrate::CaptureEmbedded,
            Target::CliLinked { .. } => Substrate::CliLinked,
        }
    }
}

/// Mirrors the TS `WorkspaceFlag` union. Each variant maps to a boolean
/// field on [`WorkspacePreferences`]; [`resolve_primary`] requires the
/// flag truthy before honoring a substrate-locked rule's primary target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkspaceFlag {
    LocalNotifyEnabled,
    LocalChatEnabled,
    CaptureRedactEnabled,
}

/// Mirrors the TS `Rule` interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub primary: Target,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Target>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_triggers: Option<Vec<FallbackTrigger>>,
    /// v0.3 S3 — when set, the workspace pref of the same name MUST be
    /// `true` for `primary` to be honored. If the flag is missing or
    /// false, [`resolve_primary`] returns `fallback` (or `Cloud` when
    /// no fallback is defined).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_flag: Option<WorkspaceFlag>,
}

/// Mirrors the TS `WorkspacePreferences` interface.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspacePreferences {
    /// Force cloud routing even when local substrate is available
    /// (architecture §6.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_cloud_only: Option<bool>,
    /// Per-task substrate override the workspace explicitly set in
    /// /settings.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub task_overrides: HashMap<TaskName, Target>,
    /// v0.3 S3 — opt in to running `notify.compose.email` on Inari Live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_notify_enabled: Option<bool>,
    /// Reserved for S4: gates `chat.conversational` on user-sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_chat_enabled: Option<bool>,
    /// Reserved for S6: gates `redact.pii.*` on capture-embedded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_redact_enabled: Option<bool>,
}

impl WorkspacePreferences {
    fn flag_value(&self, flag: WorkspaceFlag) -> bool {
        match flag {
            WorkspaceFlag::LocalNotifyEnabled => self.local_notify_enabled.unwrap_or(false),
            WorkspaceFlag::LocalChatEnabled => self.local_chat_enabled.unwrap_or(false),
            WorkspaceFlag::CaptureRedactEnabled => self.capture_redact_enabled.unwrap_or(false),
        }
    }
}

// ── Targets used in the rule table ─────────────────────────────────────────

const CLOUD: Target = Target::Cloud {
    provider: None,
    model: None,
};
const CLOUD_OPENAI: Target = Target::Cloud {
    provider: Some(AIProvider::Openai),
    model: None,
};
const CLOUD_GROQ: Target = Target::Cloud {
    provider: Some(AIProvider::Groq),
    model: None,
};

fn cloud_claude() -> Target {
    Target::Cloud {
        provider: Some(AIProvider::Claude),
        model: None,
    }
}

fn rule_simple(primary: Target) -> Rule {
    Rule {
        primary,
        fallback: None,
        fallback_triggers: None,
        workspace_flag: None,
    }
}

fn rule_with_cloud_fallback(primary: Target) -> Rule {
    Rule {
        primary,
        fallback: Some(cloud_claude()),
        fallback_triggers: Some(vec![
            FallbackTrigger::CloudError,
            FallbackTrigger::CloudRateLimit,
        ]),
        workspace_flag: None,
    }
}

/// Returns the static rule for a task. Mirror of the `RULES` object
/// literal in `packages/ai-router/src/rules.ts`. We use a `match` instead
/// of a `HashMap` so the compiler enforces exhaustiveness — if a new
/// task is added to [`TaskName`], the build fails until a rule is wired
/// here.
pub fn get_rule(task: TaskName) -> Rule {
    match task {
        // 5.1 code.* — cloud only, locked. Provider hints reflect current
        // behavior (TS rules.ts lines 89-101).
        TaskName::CodeFixSingleShot | TaskName::CodeFixAgentLoop => {
            rule_with_cloud_fallback(CLOUD_OPENAI)
        }
        TaskName::CodeReviewSelf
        | TaskName::CodeReviewSecurity
        | TaskName::CodeRiskAssess
        | TaskName::CodeFingerprint
        | TaskName::CodeFimCompletion
        | TaskName::CodeApplyDiff
        | TaskName::CodeEmbed => rule_simple(CLOUD_OPENAI),

        // 5.2 alert.* — TS rules.ts lines 104-108.
        TaskName::AlertAutoAnalyze | TaskName::AlertCorrelate => rule_simple(CLOUD_OPENAI),
        TaskName::AlertClassify => Rule {
            primary: CLOUD_GROQ,
            fallback: Some(CLOUD_OPENAI),
            fallback_triggers: Some(vec![FallbackTrigger::CloudError]),
            workspace_flag: None,
        },

        // 5.3 notify.* — S3 flips notify.compose.email behind localNotifyEnabled.
        // TS rules.ts lines 114-130.
        TaskName::NotifyComposeEmail => Rule {
            primary: Target::UserSidecar {
                model: "qwen2.5-coder-1.5b".to_string(),
            },
            fallback: Some(CLOUD),
            fallback_triggers: Some(vec![
                FallbackTrigger::SidecarOffline,
                FallbackTrigger::SidecarTimeout,
                FallbackTrigger::WorkspaceFlagCloudOnly,
            ]),
            workspace_flag: Some(WorkspaceFlag::LocalNotifyEnabled),
        },
        TaskName::NotifyComposeSlack
        | TaskName::NotifyComposeTelegram
        | TaskName::NotifyComposeWhatsapp
        | TaskName::NotifyComposePush
        | TaskName::NotifyComposeDigest
        | TaskName::NotifyComposeStatusPage
        | TaskName::NotifyComposePostmortemProse => rule_simple(CLOUD),

        // 5.4 voice.* — Phase 1 cloud stub. TS rules.ts lines 133-134.
        TaskName::VoiceTtsAlert | TaskName::VoiceTtsDigest => rule_simple(CLOUD),

        // 5.5 chat.* — TS rules.ts lines 137-139.
        TaskName::ChatConversational => rule_simple(CLOUD),
        TaskName::ChatCode => rule_simple(CLOUD_OPENAI),
        TaskName::ChatIntentClassify => Rule {
            primary: CLOUD_GROQ,
            fallback: Some(CLOUD_OPENAI),
            fallback_triggers: Some(vec![FallbackTrigger::CloudError]),
            workspace_flag: None,
        },

        // 5.6 redact.* — Phase 5 enables capture-embedded. TS lines 142-143.
        TaskName::RedactPiiBreadcrumbs | TaskName::RedactPiiStacktrace => rule_simple(CLOUD),

        // 5.7 gate.* — cloud, always. TS lines 146-148.
        TaskName::GatePrediction
        | TaskName::GateSubstrateReplay
        | TaskName::GateCommunityFixMatch => rule_simple(CLOUD_OPENAI),
    }
}

/// Returns a snapshot of all 30 rules keyed by task. Provided for
/// callers that need the full table (e.g., the lockdown audit, eval
/// harness configuration). Allocates on every call — prefer [`get_rule`]
/// for hot paths.
pub fn rules() -> HashMap<TaskName, Rule> {
    let mut m = HashMap::with_capacity(crate::tasks::ALL_TASKS.len());
    for &task in crate::tasks::ALL_TASKS {
        m.insert(task, get_rule(task));
    }
    m
}

/// Resolve the effective primary target for a task given workspace
/// prefs. Mirror of `resolvePrimary(task, prefs)` in
/// `packages/ai-router/src/rules.ts`.
///
/// Order of precedence (S3):
/// 1. `task_overrides[task]` — wins outright (admin/debug escape hatch).
/// 2. `force_cloud_only` — demotes any non-cloud primary to plain cloud.
/// 3. `workspace_flag` — if the rule pins a flag and the workspace pref
///    is missing/false, return the rule's fallback (or `Cloud` if absent).
/// 4. `rule.primary` — default.
pub fn resolve_primary(task: TaskName, prefs: Option<&WorkspacePreferences>) -> Target {
    let rule = get_rule(task);
    if let Some(prefs) = prefs {
        if let Some(override_target) = prefs.task_overrides.get(&task) {
            return override_target.clone();
        }
        if prefs.force_cloud_only.unwrap_or(false) && rule.primary.substrate() != Substrate::Cloud {
            return CLOUD.clone();
        }
        if let Some(flag) = rule.workspace_flag {
            if !prefs.flag_value(flag) {
                return rule.fallback.clone().unwrap_or(CLOUD);
            }
        }
    } else if let Some(flag) = rule.workspace_flag {
        // No prefs supplied — flag defaults to false, fall back.
        let _ = flag;
        return rule.fallback.clone().unwrap_or(CLOUD);
    }
    rule.primary
}

/// Mirror of `detectProvider(key)` in
/// `packages/ai-router/src/dispatch.ts`. Kept here so the router is
/// self-contained — surfaces hand us an api_key + (optional) hint, and
/// we do the right thing without coupling back into web.
pub fn detect_provider(key: &str) -> AIProvider {
    if key.starts_with("sk-ant-") {
        AIProvider::Claude
    } else if key.starts_with("xai-") {
        AIProvider::Grok
    } else if key.starts_with("gsk_") {
        AIProvider::Groq
    } else if key.starts_with("AIza") {
        AIProvider::Gemini
    } else {
        AIProvider::Openai
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::ALL_TASKS;

    #[test]
    fn rules_table_covers_all_tasks() {
        let table = rules();
        assert_eq!(table.len(), 30);
        for &task in ALL_TASKS {
            assert!(table.contains_key(&task), "missing rule for {:?}", task);
        }
    }

    #[test]
    fn phase_1_cloud_only_for_every_non_notify_email_task() {
        // Per TS rules.ts: in Phase 1 every task except NotifyComposeEmail
        // resolves to cloud. NotifyComposeEmail's primary is user-sidecar
        // but the workspace_flag gates it off by default.
        for &task in ALL_TASKS {
            let target = resolve_primary(task, None);
            assert_eq!(
                target.substrate(),
                Substrate::Cloud,
                "task {:?} did not resolve to cloud with default prefs",
                task,
            );
        }
    }

    #[test]
    fn notify_email_with_flag_off_falls_back_to_cloud() {
        let prefs = WorkspacePreferences {
            local_notify_enabled: Some(false),
            ..Default::default()
        };
        let target = resolve_primary(TaskName::NotifyComposeEmail, Some(&prefs));
        assert_eq!(target.substrate(), Substrate::Cloud);
    }

    #[test]
    fn notify_email_with_flag_on_routes_to_user_sidecar() {
        let prefs = WorkspacePreferences {
            local_notify_enabled: Some(true),
            ..Default::default()
        };
        let target = resolve_primary(TaskName::NotifyComposeEmail, Some(&prefs));
        match target {
            Target::UserSidecar { ref model } => {
                assert_eq!(model, "qwen2.5-coder-1.5b");
            }
            other => panic!("expected user-sidecar, got {:?}", other),
        }
    }

    #[test]
    fn force_cloud_only_demotes_user_sidecar_to_cloud() {
        let prefs = WorkspacePreferences {
            local_notify_enabled: Some(true),
            force_cloud_only: Some(true),
            ..Default::default()
        };
        let target = resolve_primary(TaskName::NotifyComposeEmail, Some(&prefs));
        assert_eq!(target.substrate(), Substrate::Cloud);
    }

    #[test]
    fn task_override_wins_over_everything() {
        let mut overrides = HashMap::new();
        overrides.insert(
            TaskName::CodeFixSingleShot,
            Target::Cloud {
                provider: Some(AIProvider::Claude),
                model: Some("claude-sonnet-4-6".to_string()),
            },
        );
        let prefs = WorkspacePreferences {
            task_overrides: overrides,
            ..Default::default()
        };
        let target = resolve_primary(TaskName::CodeFixSingleShot, Some(&prefs));
        match target {
            Target::Cloud { provider, model } => {
                assert_eq!(provider, Some(AIProvider::Claude));
                assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
            }
            other => panic!("expected cloud override, got {:?}", other),
        }
    }

    #[test]
    fn detect_provider_matches_ts() {
        assert_eq!(detect_provider("sk-ant-foo"), AIProvider::Claude);
        assert_eq!(detect_provider("xai-foo"), AIProvider::Grok);
        assert_eq!(detect_provider("gsk_foo"), AIProvider::Groq);
        assert_eq!(detect_provider("AIzaSyFoo"), AIProvider::Gemini);
        assert_eq!(detect_provider("sk-fooBarBaz"), AIProvider::Openai);
        assert_eq!(detect_provider(""), AIProvider::Openai);
    }

    #[test]
    fn fallback_triggers_match_ts_for_code_fix() {
        let rule = get_rule(TaskName::CodeFixSingleShot);
        assert_eq!(
            rule.fallback_triggers.as_deref(),
            Some(
                vec![FallbackTrigger::CloudError, FallbackTrigger::CloudRateLimit].as_slice()
            ),
        );
        assert_eq!(rule.fallback.unwrap().substrate(), Substrate::Cloud);
    }

    #[test]
    fn alert_classify_uses_groq_primary_with_openai_fallback() {
        // Mirrors TS rules.ts line 108: classifier tier is Groq Llama-8B.
        let rule = get_rule(TaskName::AlertClassify);
        match rule.primary {
            Target::Cloud { provider, .. } => {
                assert_eq!(provider, Some(AIProvider::Groq));
            }
            other => panic!("expected cloud groq primary, got {:?}", other),
        }
        match rule.fallback {
            Some(Target::Cloud { provider, .. }) => {
                assert_eq!(provider, Some(AIProvider::Openai));
            }
            other => panic!("expected cloud openai fallback, got {:?}", other),
        }
    }
}
