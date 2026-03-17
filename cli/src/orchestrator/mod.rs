pub mod correlator;

use chrono::{DateTime, Utc};
use serde_json::Value;

/// A normalized event collected from any integration, before dedup or storage.
#[derive(Debug, Clone)]
pub struct RawEvent {
    pub integration: String,
    pub event_type: String,
    pub fingerprint: String,
    pub occurred_at: DateTime<Utc>,
    pub payload: Value,
    pub severity: String,
    /// Short title shown in alert header
    pub title: String,
    /// Full human-readable description for the alert body
    pub detail: String,
    pub url: Option<String>,
}

/// One or more related events that will produce a single alert.
#[derive(Debug)]
pub struct EventGroup {
    pub events: Vec<RawEvent>,
    pub severity: String,
}

impl EventGroup {
    pub fn is_correlated(&self) -> bool {
        let integrations: std::collections::HashSet<_> =
            self.events.iter().map(|e| e.integration.as_str()).collect();
        integrations.len() > 1
    }

    /// Build a plain-text alert body when AI is not available.
    pub fn format_body(&self) -> String {
        if self.events.len() == 1 {
            return self.events[0].detail.clone();
        }

        self.events
            .iter()
            .map(|e| {
                let url_part = e
                    .url
                    .as_deref()
                    .map(|u| format!("\n  {}", u))
                    .unwrap_or_default();
                format!("[{}] {}{}", e.integration.to_uppercase(), e.detail, url_part)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub fn format_title(&self) -> String {
        if self.events.len() == 1 {
            return self.events[0].title.clone();
        }
        let integrations: Vec<_> = {
            let mut seen = std::collections::HashSet::new();
            self.events
                .iter()
                .filter(|e| seen.insert(e.integration.clone()))
                .map(|e| e.integration.as_str())
                .collect()
        };
        format!("{} events across {}", self.events.len(), integrations.join(" + "))
    }
}
