/**
 * S12 — relay-side notifications for mobile pairing.
 *
 * Two events get pushed from web → desktop via the relay:
 *   1. `pair:sas-shown` — when mobile redeems, emit the SAS digits so
 *      the desktop's SasConfirmModal pops up.
 *   2. (future) `pair:device-revoked` — when desktop confirms revoke
 *      from the web UI, push to the desktop so the local cache
 *      invalidates.
 *
 * The relay's reverse-direction publish endpoint
 * (`POST /relay/publish`) lands in S12.5. Until then this module
 * captures the call shape so the relay-side code path is testable +
 * the desktop's listener has a contract to subscribe against.
 *
 * Capture: when `MOBILE_RELAY_PUBLISH_URL` is set, we POST a JSON body
 * with the event. When unset (default in dev / current prod) we log
 * structured info for manual verification. Test mode swaps the
 * publisher via `setMobileRelayPublisher`.
 */

interface SasShownEvent {
  workspaceId:       string;
  challengeId:       string;
  sasDigits:         string;
  deviceDisplayName: string;
}

export type MobileRelayPublisher = (
  event: { kind: "pair:sas-shown" } & SasShownEvent,
) => Promise<void> | void;

let publisher: MobileRelayPublisher = defaultPublisher;

export function setMobileRelayPublisher(p: MobileRelayPublisher | null) {
  publisher = p ?? defaultPublisher;
}

async function defaultPublisher(event: { kind: string } & SasShownEvent): Promise<void> {
  const url = process.env.MOBILE_RELAY_PUBLISH_URL;
  const auth = process.env.CRON_SECRET;
  if (!url || !auth) {
    // Dev / pre-S12.5 path. Log so the desktop dev can simulate the
    // event manually via `tauri-plugin-event` / Settings UI.
    console.log("[mobile-relay] would publish", JSON.stringify(event));
    return;
  }
  try {
    await fetch(url, {
      method:  "POST",
      headers: {
        "content-type": "application/json",
        authorization:  `Bearer ${auth}`,
      },
      body: JSON.stringify(event),
    });
  } catch (e) {
    console.warn("[mobile-relay] publish failed", e);
  }
}

export async function notifyDesktopSasShown(event: SasShownEvent): Promise<void> {
  await publisher({ kind: "pair:sas-shown", ...event });
}
