/**
 * Where a notification leads. Each client maps these to its own routes, so
 * the same notification opens the right screen on web and mobile.
 */
export type NotificationLink =
  | { screen: "pto" }
  | { screen: "time" }
  | { screen: "schedule" }
  | { screen: "tasks" }
  | { screen: "documents" }
  | { screen: "onboarding" }
  | { screen: "hiring" }
  | { screen: "tax-forms" }
  | { screen: "asset"; id: string }
  | { screen: "work-order"; id: string; assetId: string };

export const NOTIFICATION_CATEGORIES = ["pto", "time", "schedule", "fleet", "documents", "onboarding", "hiring", "payroll"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Expo push tokens look like ExponentPushToken[xxxx] or ExpoPushToken[xxxx]. */
export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export const NOTIFICATION_CATEGORY_INFO: Record<NotificationCategory, { label: string; description: string }> = {
  pto: { label: "Time off", description: "Requests to approve and decisions on yours" },
  time: { label: "Time clock", description: "Forgotten clock-outs" },
  schedule: { label: "Schedule", description: "Published schedules, shift changes, open shifts, reminders" },
  fleet: { label: "Fleet & equipment", description: "Work orders, failed inspections, maintenance due, expiring registrations" },
  documents: { label: "Documents", description: "Documents waiting for your signature" },
  onboarding: { label: "Onboarding", description: "Your new-hire checklist" },
  hiring: { label: "Hiring", description: "New job applicants" },
  payroll: { label: "Payroll & tax forms", description: "New or updated W-4s and direct deposit details to enter in payroll (admins)" },
};

/**
 * Email/text delivery per category: never, only when the person has no
 * phone with the app signed in ("no_app"), or always.
 */
export const DELIVERY_MODES = ["never", "no_app", "always"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export interface NotificationPreference {
  category: NotificationCategory;
  /** In-app inbox and push notifications. */
  app: boolean;
  email: DeliveryMode;
  sms: DeliveryMode;
}

/** What a person gets before they change anything: app on, email if they don't use the app, no texts. */
export function defaultPreference(category: NotificationCategory): NotificationPreference {
  return { category, app: true, email: "no_app", sms: "never" };
}

/** Maps a notification's link to a page in the web app (also used for links in emails and texts). */
export function webPathFor(link: NotificationLink | null | undefined): string | null {
  switch (link?.screen) {
    case "pto": return "/time-off";
    case "time": return "/time";
    case "schedule": return "/schedule";
    case "tasks": return "/work-orders?mine=true";
    case "documents": return "/documents";
    case "onboarding": return "/onboarding";
    case "hiring": return "/hiring";
    case "tax-forms": return "/tax-forms";
    case "asset": return `/fleet/${link.id}`;
    case "work-order": return `/work-orders?highlight=${link.id}`;
    default: return null;
  }
}

/**
 * Best-effort conversion of a typed phone number to E.164 for texting.
 * Ten-digit numbers are assumed to be US/Canada. Returns null if it can't tell.
 */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
