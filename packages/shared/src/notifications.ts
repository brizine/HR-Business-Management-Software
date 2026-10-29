/**
 * Where a notification leads. Each client maps these to its own routes, so
 * the same notification opens the right screen on web and mobile.
 */
export type NotificationLink =
  | { screen: "pto" }
  | { screen: "time" }
  | { screen: "tasks" }
  | { screen: "documents" }
  | { screen: "onboarding" }
  | { screen: "hiring" }
  | { screen: "asset"; id: string }
  | { screen: "work-order"; id: string; assetId: string };

export const NOTIFICATION_CATEGORIES = ["pto", "time", "fleet", "documents", "onboarding", "hiring"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Expo push tokens look like ExponentPushToken[xxxx] or ExpoPushToken[xxxx]. */
export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;
