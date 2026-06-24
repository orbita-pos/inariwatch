use serde::Serialize;

/// A single step in the trigger_fix pipeline (or any multi-step tool).
#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub step: &'static str,
    pub status: StepStatus,
    pub message: String,
    /// Optional numeric value (e.g. confidence score, self-review score)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Completed,
    Failed,
    Skipped,
}

impl Step {
    pub fn ok(step: &'static str, message: impl Into<String>) -> Self {
        Self { step, status: StepStatus::Completed, message: message.into(), score: None }
    }

    pub fn fail(step: &'static str, message: impl Into<String>) -> Self {
        Self { step, status: StepStatus::Failed, message: message.into(), score: None }
    }

    pub fn skipped(step: &'static str, message: impl Into<String>) -> Self {
        Self { step, status: StepStatus::Skipped, message: message.into(), score: None }
    }

    pub fn with_score(mut self, score: u32) -> Self {
        self.score = Some(score);
        self
    }
}
