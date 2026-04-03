import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { router } from "expo-router";
import { registerPushToken, ackAlert, resolveAlert } from "./api";

// ── Notification channels (Android) ─────────────────────────────────────────

const CHANNELS = [
  {
    id: "critical-alerts",
    name: "Alertas Criticas",
    importance: 5, // MAX
    sound: "critical",
    vibrationPattern: [0, 500, 200, 500],
    lightColor: "#ef4444",
    bypassDnd: true,
  },
  {
    id: "warning-alerts",
    name: "Alertas Warning",
    importance: 4, // HIGH
    sound: "default",
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#f59e0b",
    bypassDnd: false,
  },
  {
    id: "info-alerts",
    name: "Alertas Info",
    importance: 2, // LOW
    sound: null,
    vibrationPattern: undefined,
    lightColor: "#3b82f6",
    bypassDnd: false,
  },
] as const;

// ── Notification categories (action buttons) ────────────────────────────────

const CATEGORIES = [
  {
    identifier: "CRITICAL_ALERT",
    actions: [
      { identifier: "ACK", title: "Reconocer", options: { isDestructive: false, isAuthenticationRequired: false } },
      { identifier: "RESOLVE", title: "Resolver", options: { isDestructive: false, isAuthenticationRequired: false } },
    ],
  },
  {
    identifier: "WARNING_ALERT",
    actions: [
      { identifier: "ACK", title: "Reconocer", options: { isDestructive: false, isAuthenticationRequired: false } },
    ],
  },
  {
    identifier: "INFO_ALERT",
    actions: [],
  },
];

// ── Setup ───────────────────────────────────────────────────────────────────

export async function setupPush(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log("Push requires physical device");
    return null;
  }

  // expo-notifications not available in Expo Go (SDK 53+)
  if (!Notifications.getPermissionsAsync) {
    console.log("Push not available in Expo Go — use a dev build");
    return null;
  }

  // Request permission
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return null;

  // Android channels (3 severity levels)
  if (Platform.OS === "android") {
    for (const ch of CHANNELS) {
      await Notifications.setNotificationChannelAsync(ch.id, {
        name: ch.name,
        importance: ch.importance as Notifications.AndroidImportance,
        vibrationPattern: ch.vibrationPattern as number[] | undefined,
        lightColor: ch.lightColor,
        bypassDnd: ch.bypassDnd,
        ...(ch.sound ? { sound: ch.sound } : {}),
      });
    }
    // Remove old single channel
    await Notifications.deleteNotificationChannelAsync("alerts").catch(() => {});
  }

  // iOS notification categories (action buttons)
  if (Platform.OS === "ios" && Notifications.setNotificationCategoryAsync) {
    for (const cat of CATEGORIES) {
      await Notifications.setNotificationCategoryAsync(
        cat.identifier,
        cat.actions.map((a) => ({
          identifier: a.identifier,
          buttonTitle: a.title,
          options: {
            isDestructive: a.options.isDestructive,
            isAuthenticationRequired: a.options.isAuthenticationRequired,
          },
        }))
      );
    }
  }

  // Get token
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) {
    console.error("Missing EAS projectId — push tokens unavailable");
    return null;
  }
  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = tokenData.data;

  // Register with backend
  try {
    await registerPushToken(token);
  } catch (e) {
    console.error("Push registration failed:", e);
  }

  return token;
}

// ── Handlers ────────────────────────────────────────────────────────────────

export function setupNotificationHandler(): void {
  // expo-notifications not available in Expo Go (SDK 53+)
  if (!Notifications.setNotificationHandler) return;

  // Foreground: show as banner
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const severity = notification.request.content.data?.severity as string | undefined;
      return {
        shouldShowAlert: true,
        shouldPlaySound: severity === "critical" || severity === "warning",
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      };
    },
  });

  // Tap handler: deep link to alert
  if (!Notifications.addNotificationResponseReceivedListener) return;
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    const alertId = data?.alertId as string | undefined;
    if (!alertId) return;

    const actionId = response.actionIdentifier;

    // Quick actions (without opening alert detail)
    if (actionId === "ACK") {
      ackAlert(alertId).catch(() => {});
      return;
    }
    if (actionId === "RESOLVE") {
      resolveAlert(alertId).catch(() => {});
      return;
    }

    // Default tap → open alert detail
    router.push(`/alert/${alertId}`);
  });
}

// ── Badge count ─────────────────────────────────────────────────────────────

export async function updateBadgeCount(unreadCount: number): Promise<void> {
  if (!Notifications.setBadgeCountAsync) return;
  try {
    await Notifications.setBadgeCountAsync(unreadCount);
  } catch {}
}

export async function clearBadge(): Promise<void> {
  await updateBadgeCount(0);
}
