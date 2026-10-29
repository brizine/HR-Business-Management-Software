import type { NotificationLink } from "@crewdesk/shared";

/** Maps a notification's link to a page in the web app. */
export function hrefFor(link: NotificationLink | null | undefined): string | null {
  switch (link?.screen) {
    case "pto": return "/time-off";
    case "time": return "/time";
    case "schedule": return "/schedule";
    case "tasks": return "/work-orders?mine=true";
    case "documents": return "/documents";
    case "onboarding": return "/onboarding";
    case "hiring": return "/hiring";
    case "asset": return `/fleet/${link.id}`;
    case "work-order": return `/work-orders?highlight=${link.id}`;
    default: return null;
  }
}
