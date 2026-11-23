/**
 * The Calendar page (like Homeworks'): every dated thing in one place. Each kind of event has a
 * label, an icon, a default color and whether it shows before you change anything.
 */

export const CALENDAR_TYPES = ["visit", "todo", "repair", "timeoff", "holiday", "shift"] as const;
export type CalendarType = (typeof CALENDAR_TYPES)[number];

export const CALENDAR_TYPE_INFO: Record<CalendarType, { label: string; color: string; icon: string; defaultOn: boolean }> = {
  visit: { label: "Work orders", color: "#2563eb", icon: "clipboard", defaultOn: true },
  todo: { label: "To-dos", color: "#7c3aed", icon: "todo", defaultOn: true },
  repair: { label: "Repair orders", color: "#78716c", icon: "truck", defaultOn: true },
  timeoff: { label: "Time off", color: "#0d9488", icon: "calendar", defaultOn: true },
  holiday: { label: "Holidays", color: "#db2777", icon: "sun", defaultOn: true },
  // Every shift for everyone fills the calendar fast, so they start hidden.
  shift: { label: "Shifts", color: "#0891b2", icon: "clock", defaultOn: false },
};

/** Colors to pick from for an event type (plus any custom color). */
export const CALENDAR_COLORS = ["#16a34a", "#0d9488", "#0891b2", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#d97706", "#78716c"] as const;

export interface CalendarEvent {
  /** `${type}:${id}`, unique across types. */
  key: string;
  type: CalendarType;
  id: string;
  title: string;
  date: string;
  /** Last day (inclusive) when it runs over several days. */
  endDate: string | null;
  /** "HH:MM" in the company's time zone, when it has a time. */
  startTime: string | null;
  endTime: string | null;
  /** Its own color (to-dos have one); otherwise the type's color is used. */
  color: string | null;
  status: "open" | "done";
  /** The record's own word for where it stands ("In progress", "Approved"…). */
  statusLabel: string;
  recurring: boolean;
  customer: { id: string; name: string } | null;
  property: { id: string; address: string } | null;
  location: string | null;
  people: { id: string; name: string }[];
  /** Budgeted hours (to-dos), labor hours (repair orders), hours off or shift length. */
  hours: number | null;
  notes: string | null;
  /** The customer's tags, for the Tag filter. */
  tagIds: string[];
  /** Work orders: what it bills (null when you can't see prices or it isn't billed). */
  amountCents: number | null;
  /** Work orders: whether it's on an invoice (null when it isn't billed). */
  invoiced: boolean | null;
  /** Work orders: the crew is there now. */
  onSite: boolean;
  /** Work orders: minutes from arriving to finishing (null when not tracked). */
  trackedMinutes: number | null;
  /** Work orders: the price list services on it, for the Item/Service filter. */
  serviceIds: string[];
  /** Work orders: the crew it's for. */
  crew: { id: string; name: string; color: string } | null;
  /** Work orders: how many photos and documents it has. */
  mediaCount: number;
  href: string | null;
  /** Whether you can drag it to another day. */
  canMove: boolean;
  /** Whether you can check it off from the calendar. */
  canComplete: boolean;
}

export const CALENDAR_SORTS = {
  time: "Time, earliest first",
  timeDesc: "Time, latest first",
  revenueDesc: "Revenue, high to low",
  revenueAsc: "Revenue, low to high",
  hoursDesc: "Budgeted hours, high to low",
  hoursAsc: "Budgeted hours, low to high",
  customer: "Customer A-Z",
  status: "Status (Open → Done)",
  type: "Event type",
} as const;
export type CalendarSort = keyof typeof CALENDAR_SORTS;

/** Orders a day's events the way the Sort menu says (all-day ones first when sorting by time). */
export function sortEvents(list: CalendarEvent[], sort: CalendarSort): CalendarEvent[] {
  const time = (e: CalendarEvent) => e.startTime ?? "";
  const byTitle = (a: CalendarEvent, b: CalendarEvent) => a.title.localeCompare(b.title);
  const order = CALENDAR_TYPES as readonly string[];
  const cmp: Record<CalendarSort, (a: CalendarEvent, b: CalendarEvent) => number> = {
    time: (a, b) => time(a).localeCompare(time(b)) || byTitle(a, b),
    timeDesc: (a, b) => time(b).localeCompare(time(a)) || byTitle(a, b),
    revenueDesc: (a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0) || byTitle(a, b),
    revenueAsc: (a, b) => (a.amountCents ?? 0) - (b.amountCents ?? 0) || byTitle(a, b),
    hoursDesc: (a, b) => (b.hours ?? 0) - (a.hours ?? 0) || byTitle(a, b),
    hoursAsc: (a, b) => (a.hours ?? 0) - (b.hours ?? 0) || byTitle(a, b),
    customer: (a, b) => (a.customer?.name ?? "￿").localeCompare(b.customer?.name ?? "￿") || byTitle(a, b),
    status: (a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) || time(a).localeCompare(time(b)) || byTitle(a, b),
    type: (a, b) => order.indexOf(a.type) - order.indexOf(b.type) || time(a).localeCompare(time(b)) || byTitle(a, b),
  };
  return [...list].sort(cmp[sort]);
}

/** Whether an event is on a day (multi-day ones are on every day they run). */
export const eventOnDay = (e: Pick<CalendarEvent, "date" | "endDate">, day: string) => e.date <= day && day <= (e.endDate ?? e.date);

/** One line per event for the Export button (opens in Excel or Google Sheets). */
export function eventsCsv(list: CalendarEvent[]): string {
  const q = (v: unknown) => {
    const s = v == null ? "" : String(v);
    // Keep spreadsheet formulas from running when the file is opened.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["Date", "End date", "Start", "End", "Type", "Title", "Status", "Customer", "Address or location", "People", "Hours", "Amount", "Notes"];
  const rows = list.map((e) => [
    e.date, e.endDate ?? "", e.startTime ?? "", e.endTime ?? "", CALENDAR_TYPE_INFO[e.type].label, e.title, e.statusLabel,
    e.customer?.name ?? "", e.property?.address ?? e.location ?? "", e.people.map((p) => p.name).join("; "), e.hours ?? "",
    e.amountCents != null ? (e.amountCents / 100).toFixed(2) : "", e.notes ?? "",
  ].map(q).join(","));
  return [head.join(","), ...rows].join("\n");
}
