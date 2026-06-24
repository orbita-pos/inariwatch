//! Channel attribution for the dock chat surface.
//!
//! `ChatMessage` rows carrying `source: { messenger: "wa", paired_id, identifier }`
//! render with a `<ChannelAttributionChip>` indicating the messenger,
//! a redacted identifier (last 4 digits for phones), and the paired
//! display name. The wire shape lives here so the IPC layer (S8) and
//! the chat surface (S6) consume the same type.
//!
//! Identifier redaction lives here too — the audit log (which persists
//! these payloads via Witness) MUST never see the full phone. The dock
//! UI gets a redacted preview; full identifiers live in
//! `paired_entities.identifier` and are scoped per workspace.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::channel::ChannelKind;

/// Carried on a `ChatMessage` to indicate "this came from messenger X
/// for paired entity Y". The dock surface uses it to render the
/// attribution chip; the audit log uses it to scope the session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAttribution {
    pub channel: ChannelKind,
    pub paired_id: Uuid,
    /// Already redacted by the gateway. NEVER the raw phone — see
    /// [`redact_identifier`].
    pub redacted_identifier: String,
    pub display_name: String,
}

/// Redact a phone E.164 / device pubkey for the chat surface. Phones
/// keep their `+CC` prefix and the last 4 digits, with the middle
/// replaced by `••••`. Device pubkeys keep the first 6 + last 4 chars.
/// Anything else is rendered as-is for safety (e.g. `@username` is a
/// public handle and not sensitive).
pub fn redact_identifier(channel: ChannelKind, identifier: &str) -> String {
    match channel {
        ChannelKind::WhatsApp => redact_phone(identifier),
        ChannelKind::Telegram | ChannelKind::Slack => {
            // These channels surface @-handles or workspace ids that
            // are already public-shaped. Pass through.
            identifier.to_string()
        }
        // S12 — device pubkey. 64 hex chars; show first 6 + last 4.
        ChannelKind::MobileDevice => redact_device_pubkey(identifier),
    }
}

fn redact_device_pubkey(pubkey: &str) -> String {
    if pubkey.len() <= 12 {
        return pubkey.to_string();
    }
    let head = &pubkey[..6];
    let tail = &pubkey[pubkey.len() - 4..];
    format!("{head}…{tail}")
}

fn redact_phone(phone: &str) -> String {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 7 {
        // Too short to redact safely — pass through. (Should not happen
        // for valid E.164 but we don't want to leak via a degenerate
        // path either.)
        return phone.to_string();
    }
    // Heuristic country-code length. Real ITU-T E.164 has 1-3 digit
    // country codes — we don't ship libphonenumber so this approximation
    // covers the major cases:
    //   - 10-11 total digits → US/CA-style (cc = 1, e.g. "+15551234567")
    //   - 12-13 total digits → cc = 2 (e.g. "+5215551234567" Mexico,
    //                           "+447911123456" UK)
    //   - 14+ total digits  → cc = 3 (e.g. "+216555123456" Tunisia
    //                           edge case, longest E.164 is 15 digits)
    //
    // Wrong by one digit on a few edge-case countries — fine for a
    // redacted display string. The trailing 4 digits matter more (the
    // user uses them to recognise the line).
    let cc_len = match digits.len() {
        0..=11 => 1,
        12..=13 => 2,
        _ => 3,
    };
    let cc = &digits[..cc_len];
    let last4 = &digits[digits.len() - 4..];
    format!("+{cc} ••••{last4}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_phone_keeps_cc_and_last_four() {
        let r = redact_identifier(ChannelKind::WhatsApp, "+5215551234567");
        assert_eq!(r, "+52 ••••4567");

        let r = redact_identifier(ChannelKind::WhatsApp, "+15551234567");
        assert_eq!(r, "+1 ••••4567");
    }

    #[test]
    fn redact_short_phone_passes_through() {
        let r = redact_identifier(ChannelKind::WhatsApp, "+12345");
        assert_eq!(r, "+12345");
    }

    #[test]
    fn redact_telegram_handle_passes_through() {
        let r = redact_identifier(ChannelKind::Telegram, "@alerts");
        assert_eq!(r, "@alerts");
    }

    #[test]
    fn redact_slack_channel_passes_through() {
        let r = redact_identifier(ChannelKind::Slack, "#alerts");
        assert_eq!(r, "#alerts");
    }

    #[test]
    fn channel_attribution_round_trips_through_serde() {
        let payload = ChannelAttribution {
            channel: ChannelKind::WhatsApp,
            paired_id: Uuid::nil(),
            redacted_identifier: "+52 ••••4567".to_string(),
            display_name: "Jesus Phone".to_string(),
        };
        let raw = serde_json::to_string(&payload).unwrap();
        let back: ChannelAttribution = serde_json::from_str(&raw).unwrap();
        assert_eq!(payload, back);
        // Camel-case keys for the wire.
        assert!(raw.contains("\"redactedIdentifier\""));
        assert!(raw.contains("\"pairedId\""));
        assert!(raw.contains("\"displayName\""));
    }
}
