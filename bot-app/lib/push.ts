import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { router } from "expo-router";
import { registerPushToken } from "./api";

/**
 * Set up push notifications:
 * 1. Request permissions
 * 2. Get Expo push token
 * 3. Register with backend
 * 4. Set up tap handler (deep link to alert)
 */
export async function setupPush(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log("Push requires physical device");
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

  // Android channel
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("alerts", {
      name: "Alerts",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#7c3aed",
    });
  }

  // Get token — must use the real EAS project UUID, not the slug
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) {
    console.error("Missing EAS projectId — push tokens unavailable");
    return null;
  }
  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId,
  });
  const token = tokenData.data;

  // Register with backend
  try {
    await registerPushToken(token);
  } catch (e) {
    console.error("Push registration failed:", e);
  }

  return token;
}

/**
 * Handle notification tap → navigate to alert detail
 */
export function setupNotificationHandler(): void {
  // Foreground: show as banner
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  // Tap handler: deep link to alert
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (data?.alertId) {
      router.push(`/alert/${data.alertId}`);
    }
  });
}
