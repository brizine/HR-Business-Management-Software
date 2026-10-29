import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { NotificationLink } from "@crewdesk/shared";
import { api } from "./api";

// Show alerts even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

let registeredToken: string | null = null;

/**
 * Asks for permission (once), gets this device's Expo push token and
 * registers it with the API. Returns null when push isn't available, e.g.
 * on a simulator, when the user declines, or without an EAS project ID.
 */
export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  if (!Device.isDevice) return null;

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== "granted") return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) {
    console.warn("Push disabled: no EAS projectId. Run `eas init` in apps/mobile.");
    return null;
  }
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await api("/notifications/devices", { body: { token, platform: Platform.OS } });
  registeredToken = token;
  return token;
}

/** Stops this device receiving the signed-in user's alerts. Call before clearing the session. */
export async function unregisterForPush() {
  if (!registeredToken) return;
  await api("/notifications/devices/remove", { body: { token: registeredToken } }).catch(() => {});
  registeredToken = null;
  await Notifications.setBadgeCountAsync(0).catch(() => {});
}

/** Maps a notification's link to a screen in this app. */
export function routeFor(link: NotificationLink | null | undefined): string | null {
  switch (link?.screen) {
    case "pto": return "/time-off";
    case "time": return "/";
    case "schedule": return "/schedule";
    case "tasks":
    case "onboarding": return "/tasks";
    case "documents": return "/profile";
    case "asset": return `/asset/${link.id}`;
    case "wiki": return `/wiki/${link.id}`;
    case "work-order": return `/asset/${link.assetId}`;
    default: return "/notifications";
  }
}
