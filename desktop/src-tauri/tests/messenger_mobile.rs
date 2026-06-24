//! S12 — mobile-channel integration test.
//!
//! Drives the MobileChannel + relay-pair-event bridge through the
//! same `agent-test-utils` gate the rest of the messenger suite
//! uses. We don't drive a real Gateway round-trip here because the
//! MobileChannel is intentionally inbound-empty + send-Offline (the
//! mobile path is web-driven; the channel exists to occupy
//! `ChannelKind::MobileDevice` in the gateway dispatch and to give
//! the relay listener a stable home).

#![cfg(feature = "agent-test-utils")]

use futures_util::StreamExt;
use tokio::sync::broadcast;
use uuid::Uuid;

use inariwatch_desktop_lib::messenger::channel::{
    Channel, ChannelError, ChannelKind, DmPolicy, OutboundMessage,
};
use inariwatch_desktop_lib::messenger::events::{MessengerEvent, MESSENGER_BUS_CAPACITY};
use inariwatch_desktop_lib::messenger::{handle_relay_pair_event, MobileChannel, MobileSasShownPayload};

#[test]
fn channel_kind_is_mobile_device() {
    let m = MobileChannel::new();
    assert_eq!(m.kind(), ChannelKind::MobileDevice);
}

#[test]
fn channel_dm_policy_is_pairing() {
    let m = MobileChannel::new();
    assert_eq!(m.dm_policy(), DmPolicy::Pairing);
}

#[tokio::test]
async fn channel_subscribe_returns_empty_stream() {
    let m = MobileChannel::new();
    let stream = m.subscribe().await;
    let collected: Vec<_> = stream.collect().await;
    assert!(
        collected.is_empty(),
        "MobileChannel inbound is empty by design (web-driven path)"
    );
}

#[tokio::test]
async fn channel_send_returns_offline_for_mobile() {
    let m = MobileChannel::new();
    let r = m
        .send(
            "abcdef0123456789abcdef0123456789",
            &OutboundMessage {
                text:    "hello".to_string(),
                buttons: Vec::new(),
                thread_id: None,
            },
            "messenger:mobile:abc",
        )
        .await;
    match r {
        Err(ChannelError::Offline { kind, reason }) => {
            assert_eq!(kind, "mobile");
            assert!(reason.contains("server-side"));
        }
        other => panic!("expected Offline, got {other:?}"),
    }
}

#[test]
fn relay_event_dispatches_sas_pending_to_bus() {
    let (tx, mut rx) = broadcast::channel::<MessengerEvent>(MESSENGER_BUS_CAPACITY);
    let payload = MobileSasShownPayload {
        challenge_id:        Uuid::nil(),
        sas_digits:          "482619".to_string(),
        device_display_name: "Pixel 7".to_string(),
        device_pubkey:       Some("abcdef0123456789abcdef0123456789".to_string()),
    };
    let ok = handle_relay_pair_event(&tx, payload);
    assert!(ok, "subscriber alive — send must succeed");

    match rx.try_recv().expect("event published") {
        MessengerEvent::SasPending {
            channel,
            challenge_id,
            sas_digits,
            display_name,
            identifier_redacted,
        } => {
            assert_eq!(channel, ChannelKind::MobileDevice);
            assert_eq!(challenge_id, Uuid::nil());
            assert_eq!(sas_digits, "482619");
            assert_eq!(display_name, "Pixel 7");
            assert!(identifier_redacted.starts_with("abcdef"));
            assert!(identifier_redacted.ends_with("6789"));
            assert!(identifier_redacted.contains('…'));
        }
        other => panic!("expected SasPending, got {other:?}"),
    }
}

#[test]
fn relay_event_falls_back_to_placeholder_when_no_pubkey() {
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
        MessengerEvent::SasPending {
            identifier_redacted,
            ..
        } => {
            assert_eq!(identifier_redacted, "(mobile device)");
        }
        other => panic!("expected SasPending, got {other:?}"),
    }
}

#[test]
fn relay_event_returns_false_when_no_subscriber() {
    let (tx, _rx) = broadcast::channel::<MessengerEvent>(MESSENGER_BUS_CAPACITY);
    drop(_rx);
    let ok = handle_relay_pair_event(
        &tx,
        MobileSasShownPayload {
            challenge_id:        Uuid::nil(),
            sas_digits:          "000000".to_string(),
            device_display_name: "Anon".to_string(),
            device_pubkey:       None,
        },
    );
    assert!(!ok, "no subscribers — broadcast::send returns Err");
}

#[test]
fn channel_kind_serdes_to_mobile_string() {
    let raw = serde_json::to_string(&ChannelKind::MobileDevice).unwrap();
    assert_eq!(raw, "\"mobile\"");
    let back: ChannelKind = serde_json::from_str("\"mobile\"").unwrap();
    assert_eq!(back, ChannelKind::MobileDevice);
}

#[test]
fn channel_kind_session_prefix_is_mobile() {
    assert_eq!(ChannelKind::MobileDevice.session_prefix(), "mobile");
    assert_eq!(ChannelKind::MobileDevice.as_str(), "mobile");
}
