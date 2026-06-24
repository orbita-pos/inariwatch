//! Task taxonomy. Mirror of `packages/ai-router/src/tasks.ts`.
//!
//! Every AI call tags itself with one of these names. The router
//! ([`crate::rules`] + [`crate::dispatch`]) decides where the call runs
//! based on the task. Adding a new AI feature means: 1) add a variant
//! here, 2) add a rule in [`crate::rules::RULES`], 3) wire it on the TS
//! side too — the integration test `tasks_round_trip` keeps the two sides
//! aligned (string equality of every variant's `as_str()` against the TS
//! literal).
//!
//! Per `INARI_AI_ARCHITECTURE.md` §5 (LOCKED 2026-05-02).

use serde::{Deserialize, Serialize};

/// Mirror of `TaskName` in `packages/ai-router/src/tasks.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskName {
    // 5.1 code.* — code understanding & modification (CLOUD ONLY, locked)
    CodeFixSingleShot,
    CodeFixAgentLoop,
    CodeReviewSelf,
    CodeReviewSecurity,
    CodeRiskAssess,
    CodeFingerprint,
    CodeFimCompletion,
    CodeApplyDiff,
    CodeEmbed,

    // 5.2 alert.* — alert ingestion & analysis (HYBRID)
    AlertAutoAnalyze,
    AlertCorrelate,
    AlertClassify,

    // 5.3 notify.* — notification composition (LOCAL when user online, cloud fallback)
    NotifyComposeEmail,
    NotifyComposeSlack,
    NotifyComposeTelegram,
    NotifyComposeWhatsapp,
    NotifyComposePush,
    NotifyComposeDigest,
    NotifyComposeStatusPage,
    NotifyComposePostmortemProse,

    // 5.4 voice.* — voice surface (LOCAL only)
    VoiceTtsAlert,
    VoiceTtsDigest,

    // 5.5 chat.* — conversational surfaces (HYBRID with intent routing)
    ChatConversational,
    ChatCode,
    ChatIntentClassify,

    // 5.6 redact.* — privacy-sensitive transforms (LOCAL preferred)
    RedactPiiBreadcrumbs,
    RedactPiiStacktrace,

    // 5.7 gate.* — auto-merge gate evaluators (CLOUD)
    GatePrediction,
    GateSubstrateReplay,
    GateCommunityFixMatch,
}

/// Mirror of `TaskNamespace` in `packages/ai-router/src/tasks.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskNamespace {
    Code,
    Alert,
    Notify,
    Voice,
    Chat,
    Redact,
    Gate,
}

impl TaskName {
    /// Wire identity. MUST match the TS string literal byte-for-byte —
    /// `tasks_round_trip` and the inter-language eval harness depend on
    /// it.
    pub const fn as_str(self) -> &'static str {
        match self {
            // code.*
            TaskName::CodeFixSingleShot => "code.fix.single-shot",
            TaskName::CodeFixAgentLoop => "code.fix.agent-loop",
            TaskName::CodeReviewSelf => "code.review.self",
            TaskName::CodeReviewSecurity => "code.review.security",
            TaskName::CodeRiskAssess => "code.risk.assess",
            TaskName::CodeFingerprint => "code.fingerprint",
            TaskName::CodeFimCompletion => "code.fim.completion",
            TaskName::CodeApplyDiff => "code.apply.diff",
            TaskName::CodeEmbed => "code.embed",
            // alert.*
            TaskName::AlertAutoAnalyze => "alert.auto-analyze",
            TaskName::AlertCorrelate => "alert.correlate",
            TaskName::AlertClassify => "alert.classify",
            // notify.*
            TaskName::NotifyComposeEmail => "notify.compose.email",
            TaskName::NotifyComposeSlack => "notify.compose.slack",
            TaskName::NotifyComposeTelegram => "notify.compose.telegram",
            TaskName::NotifyComposeWhatsapp => "notify.compose.whatsapp",
            TaskName::NotifyComposePush => "notify.compose.push",
            TaskName::NotifyComposeDigest => "notify.compose.digest",
            TaskName::NotifyComposeStatusPage => "notify.compose.status-page",
            TaskName::NotifyComposePostmortemProse => "notify.compose.postmortem-prose",
            // voice.*
            TaskName::VoiceTtsAlert => "voice.tts.alert",
            TaskName::VoiceTtsDigest => "voice.tts.digest",
            // chat.*
            TaskName::ChatConversational => "chat.conversational",
            TaskName::ChatCode => "chat.code",
            TaskName::ChatIntentClassify => "chat.intent-classify",
            // redact.*
            TaskName::RedactPiiBreadcrumbs => "redact.pii.breadcrumbs",
            TaskName::RedactPiiStacktrace => "redact.pii.stacktrace",
            // gate.*
            TaskName::GatePrediction => "gate.prediction",
            TaskName::GateSubstrateReplay => "gate.substrate-replay",
            TaskName::GateCommunityFixMatch => "gate.community-fix-match",
        }
    }

    /// Parse a wire string back into a `TaskName`. Returns `None` for
    /// unknown values — matches the TS side, which never silently
    /// remaps.
    pub fn from_str(s: &str) -> Option<TaskName> {
        Some(match s {
            "code.fix.single-shot" => TaskName::CodeFixSingleShot,
            "code.fix.agent-loop" => TaskName::CodeFixAgentLoop,
            "code.review.self" => TaskName::CodeReviewSelf,
            "code.review.security" => TaskName::CodeReviewSecurity,
            "code.risk.assess" => TaskName::CodeRiskAssess,
            "code.fingerprint" => TaskName::CodeFingerprint,
            "code.fim.completion" => TaskName::CodeFimCompletion,
            "code.apply.diff" => TaskName::CodeApplyDiff,
            "code.embed" => TaskName::CodeEmbed,
            "alert.auto-analyze" => TaskName::AlertAutoAnalyze,
            "alert.correlate" => TaskName::AlertCorrelate,
            "alert.classify" => TaskName::AlertClassify,
            "notify.compose.email" => TaskName::NotifyComposeEmail,
            "notify.compose.slack" => TaskName::NotifyComposeSlack,
            "notify.compose.telegram" => TaskName::NotifyComposeTelegram,
            "notify.compose.whatsapp" => TaskName::NotifyComposeWhatsapp,
            "notify.compose.push" => TaskName::NotifyComposePush,
            "notify.compose.digest" => TaskName::NotifyComposeDigest,
            "notify.compose.status-page" => TaskName::NotifyComposeStatusPage,
            "notify.compose.postmortem-prose" => TaskName::NotifyComposePostmortemProse,
            "voice.tts.alert" => TaskName::VoiceTtsAlert,
            "voice.tts.digest" => TaskName::VoiceTtsDigest,
            "chat.conversational" => TaskName::ChatConversational,
            "chat.code" => TaskName::ChatCode,
            "chat.intent-classify" => TaskName::ChatIntentClassify,
            "redact.pii.breadcrumbs" => TaskName::RedactPiiBreadcrumbs,
            "redact.pii.stacktrace" => TaskName::RedactPiiStacktrace,
            "gate.prediction" => TaskName::GatePrediction,
            "gate.substrate-replay" => TaskName::GateSubstrateReplay,
            "gate.community-fix-match" => TaskName::GateCommunityFixMatch,
            _ => return None,
        })
    }
}

impl TaskNamespace {
    pub const fn as_str(self) -> &'static str {
        match self {
            TaskNamespace::Code => "code",
            TaskNamespace::Alert => "alert",
            TaskNamespace::Notify => "notify",
            TaskNamespace::Voice => "voice",
            TaskNamespace::Chat => "chat",
            TaskNamespace::Redact => "redact",
            TaskNamespace::Gate => "gate",
        }
    }
}

/// Mirror of `namespaceOf(task)` in `tasks.ts`. Splits on the first '.'
/// and returns the namespace prefix.
pub const fn namespace_of(task: TaskName) -> TaskNamespace {
    match task {
        TaskName::CodeFixSingleShot
        | TaskName::CodeFixAgentLoop
        | TaskName::CodeReviewSelf
        | TaskName::CodeReviewSecurity
        | TaskName::CodeRiskAssess
        | TaskName::CodeFingerprint
        | TaskName::CodeFimCompletion
        | TaskName::CodeApplyDiff
        | TaskName::CodeEmbed => TaskNamespace::Code,
        TaskName::AlertAutoAnalyze | TaskName::AlertCorrelate | TaskName::AlertClassify => {
            TaskNamespace::Alert
        }
        TaskName::NotifyComposeEmail
        | TaskName::NotifyComposeSlack
        | TaskName::NotifyComposeTelegram
        | TaskName::NotifyComposeWhatsapp
        | TaskName::NotifyComposePush
        | TaskName::NotifyComposeDigest
        | TaskName::NotifyComposeStatusPage
        | TaskName::NotifyComposePostmortemProse => TaskNamespace::Notify,
        TaskName::VoiceTtsAlert | TaskName::VoiceTtsDigest => TaskNamespace::Voice,
        TaskName::ChatConversational | TaskName::ChatCode | TaskName::ChatIntentClassify => {
            TaskNamespace::Chat
        }
        TaskName::RedactPiiBreadcrumbs | TaskName::RedactPiiStacktrace => TaskNamespace::Redact,
        TaskName::GatePrediction | TaskName::GateSubstrateReplay | TaskName::GateCommunityFixMatch => {
            TaskNamespace::Gate
        }
    }
}

/// Mirror of `ALL_TASKS` in `tasks.ts`. Iteration order matches the TS
/// `Object.values(TASKS)` declaration order.
pub const ALL_TASKS: &[TaskName] = &[
    TaskName::CodeFixSingleShot,
    TaskName::CodeFixAgentLoop,
    TaskName::CodeReviewSelf,
    TaskName::CodeReviewSecurity,
    TaskName::CodeRiskAssess,
    TaskName::CodeFingerprint,
    TaskName::CodeFimCompletion,
    TaskName::CodeApplyDiff,
    TaskName::CodeEmbed,
    TaskName::AlertAutoAnalyze,
    TaskName::AlertCorrelate,
    TaskName::AlertClassify,
    TaskName::NotifyComposeEmail,
    TaskName::NotifyComposeSlack,
    TaskName::NotifyComposeTelegram,
    TaskName::NotifyComposeWhatsapp,
    TaskName::NotifyComposePush,
    TaskName::NotifyComposeDigest,
    TaskName::NotifyComposeStatusPage,
    TaskName::NotifyComposePostmortemProse,
    TaskName::VoiceTtsAlert,
    TaskName::VoiceTtsDigest,
    TaskName::ChatConversational,
    TaskName::ChatCode,
    TaskName::ChatIntentClassify,
    TaskName::RedactPiiBreadcrumbs,
    TaskName::RedactPiiStacktrace,
    TaskName::GatePrediction,
    TaskName::GateSubstrateReplay,
    TaskName::GateCommunityFixMatch,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_tasks_has_thirty_entries() {
        assert_eq!(ALL_TASKS.len(), 30);
    }

    #[test]
    fn all_tasks_round_trips_through_str() {
        for &task in ALL_TASKS {
            let s = task.as_str();
            assert_eq!(
                TaskName::from_str(s),
                Some(task),
                "round-trip failed for {s}",
            );
        }
    }

    #[test]
    fn unknown_task_returns_none() {
        assert!(TaskName::from_str("does.not.exist").is_none());
        assert!(TaskName::from_str("").is_none());
    }

    #[test]
    fn ts_string_parity() {
        // Wire identity vs. packages/ai-router/src/tasks.ts. If this
        // diverges, both sides must be updated together — there is no
        // automatic cross-check.
        assert_eq!(TaskName::CodeFixSingleShot.as_str(), "code.fix.single-shot");
        assert_eq!(TaskName::AlertAutoAnalyze.as_str(), "alert.auto-analyze");
        assert_eq!(TaskName::NotifyComposeEmail.as_str(), "notify.compose.email");
        assert_eq!(
            TaskName::NotifyComposePostmortemProse.as_str(),
            "notify.compose.postmortem-prose",
        );
        assert_eq!(TaskName::VoiceTtsDigest.as_str(), "voice.tts.digest");
        assert_eq!(TaskName::ChatIntentClassify.as_str(), "chat.intent-classify");
        assert_eq!(
            TaskName::RedactPiiBreadcrumbs.as_str(),
            "redact.pii.breadcrumbs",
        );
        assert_eq!(
            TaskName::GateCommunityFixMatch.as_str(),
            "gate.community-fix-match",
        );
    }

    #[test]
    fn namespace_of_returns_first_segment() {
        for &task in ALL_TASKS {
            let s = task.as_str();
            let prefix = s.split('.').next().expect("non-empty task");
            assert_eq!(
                namespace_of(task).as_str(),
                prefix,
                "namespace mismatch for {s}",
            );
        }
    }

    #[test]
    fn task_serializes_through_serde() {
        let json = serde_json::to_string(&TaskName::NotifyComposeEmail).unwrap();
        // Variants serialize with the Rust name; the wire-format used in
        // dispatch payloads is `as_str()` — different intent, kept distinct.
        assert!(json.contains("NotifyComposeEmail"));
    }
}
