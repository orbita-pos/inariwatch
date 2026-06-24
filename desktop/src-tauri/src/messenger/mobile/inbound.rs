//! S12 — relay-side bridge for the mobile pairing flow.
//!
//! The web's `/api/mobile/pair/redeem` endpoint emits a
//! `pair:sas-shown` event over the relay. The desktop's relay client
//! decodes that frame and calls [`handle_relay_pair_event`] which:
//!
//! 1. Translates the relay payload into a [`MobileSasShownPayload`].
//! 2. Publishes a [`MessengerEvent::SasPending`] on the messenger bus
//!    so the existing IPC bridge → Tauri event chain → the S8
//!    SasConfirmModal pops up with the digits.
//!
//! No state is persisted here — the SAS challenge lives in web
//! Postgres. The desktop is purely a confirmer.

use serde::Deserialize;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::messenger::attribution::redact_identifier;
use crate::messenger::channel::ChannelKind;
use crate::messenger::events::MessengerEvent;

/// Wire shape of a `pair:sas-shown` relay frame.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct MobileSasShownPayload {
    pub challenge_id:        Uuid,
    pub sas_digits:          String,
    pub device_display_name: String,
    /// Optional — when the web ALSO carries the device pubkey for
    /// audit/redaction. Omitted in S12 today (we redact via display
    /// name only); reserved for S12.5.
    #[serde(default)]
    pub device_pubkey: Option<String>,
}

/// Publish the SAS-shown event onto the messenger bus.
///
/// Returns `true` iff a subscriber was alive to receive it. The bus is
/// best-effort — losing a subscriber means the SasConfirmModal won't
/// pop up automatically, but the user can still type the digits
/// manually since the mobile UI always shows them too.
pub fn handle_relay_pair_event(
    bus: &broadcast::Sender<MessengerEvent>,
    payload: MobileSasShownPayload,
) -> bool {
    let identifier_redacted = match payload.device_pubkey.as_deref() {
        Some(pk) => redact_identifier(ChannelKind::MobileDevice, pk),
        None => "(mobile device)".to_string(),
    };
    let event = MessengerEvent::SasPending {
        challenge_id:        payload.challenge_id,
        channel:             ChannelKind::MobileDevice,
        identifier_redacted,
        display_name:        payload.device_display_name,
        sas_digits:          payload.sas_digits,
    };
    bus.send(event).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messenger::events::MESSENGER_BUS_CAPACITY;

    #[test]
    fn payload_round_trips_through_serde() {
        let raw = serde_json::json!({
            "challenge_id":        "00000000-0000-4000-8000-000000000000",
            "sas_digits":          "482619",
            "device_display_name": "Pixel 7",
            "device_pubkey":       "abcdef0123456789abcdef0123456789",
        });
        let p: MobileSasShownPayload = serde_json::from_value(raw).unwrap();
        assert_eq!(p.sas_digits, "482619");
        assert_eq!(p.device_display_name, "Pixel 7");
        assert_eq!(p.device_pubkey.as_deref(), Some("abcdef0123456789abcdef0123456789"));
    }

    #[test]
    fn payload_optional_device_pubkey() {
        let raw = serde_json::json!({
            "challenge_id":        "00000000-0000-4000-8000-000000000000",
            "sas_digits":          "000000",
            "device_display_name": "Anon",
        });
        let p: MobileSasShownPayload = serde_json::from_value(raw).unwrap();
        assert_eq!(p.device_pubkey, None);
    }

    #[test]
    fn handle_relay_pair_event_publishes_sas_pending() {
        let (tx, mut rx) = broadcast::channel::<MessengerEvent>(MESSENGER_BUS_CAPACITY);
        let payload = MobileSasShownPayload {
            challenge_id:        Uuid::nil(),
            sas_digits:          "482619".to_string(),
            device_display_name: "Pixel 7".to_string(),
            device_pubkey:       Some("abcdef0123456789abcdef0123456789".to_string()),
        };
        let ok = handle_relay_pair_event(&tx, payload);
        assert!(ok);

        match rx.try_recv().expect("event") {
            MessengerEvent::SasPending {
                channel,
                sas_digits,
                display_name,
                identifier_redacted,
                ..
            } => {
                assert_eq!(channel, ChannelKind::MobileDevice);
                assert_eq!(sas_digits, "482619");
                assert_eq!(display_name, "Pixel 7");
                // Redacted form: first 6 + last 4 with ellipsis.
                assert!(identifier_redacted.starts_with("abcdef"));
                assert!(identifier_redacted.ends_with("6789"));
            }
            _ => panic!("expected SasPending"),
        }
    }

    #[test]
    fn handle_relay_pair_event_uses_fallback_redaction_when_no_pubkey() {
        let (tx, mut rx) = broadcast::channel::<MessengerEvent>(MESSENGER_BUS_CAPACITY);
        let payload = MobileSasShownPayload {
            challenge_id:        Uuid::nil(),
            sas_digits:          "000000".to_string(),
            device_display_name: "Anon".to_string(),
            device_pubkey:       None,
        };
        let ok = handle_relay_pair_event(&tx, payload);
        assert!(ok);
        match rx.try_recv().expect("event") {
            MessengerEvent::SasPending { identifier_redacted, .. } => {
                assert_eq!(identifier_redacted, "(mobile device)");
            }
            _ => panic!("expected SasPending"),
        }
    }

    #[test]
    fn returns_false_when_no_subscribers() {
        let (tx, _) = broadcast::channel::<MessengerEvent>(MESSENGER_BUS_CAPACITY);
        // Drop the receiver immediately so `send` fails.
        let payload = MobileSasShownPayload {
            challenge_id:        Uuid::nil(),
            sas_digits:          "000000".to_string(),
            device_display_name: "Anon".to_string(),
            device_pubkey:       None,
        };
        let ok = handle_relay_pair_event(&tx, payload);
        assert!(!ok);
    }
}
