import webpush from "web-push";

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface PushPayload {
  title: string;
  body: string;
  severity: string;
  alertId: string;
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_EMAIL = process.env.VAPID_EMAIL ?? "mailto:hello@inariwatch.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export async function sendPushNotification(
  subscription: PushSubscriptionJSON,
  payload: PushPayload
): Promise<{ ok: boolean; error?: string }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { ok: false, error: "VAPID keys not configured." };
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
      },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // 410 Gone or 404 means the subscription is no longer valid
    if (
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      ((err as { statusCode: number }).statusCode === 410 ||
        (err as { statusCode: number }).statusCode === 404)
    ) {
      return { ok: false, error: "Subscription expired or unsubscribed." };
    }

    return { ok: false, error: message };
  }
}
