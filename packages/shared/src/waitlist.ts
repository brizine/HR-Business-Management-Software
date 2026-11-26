import { z } from "zod";

/**
 * The waiting list (from the Crewdesk plan): every service that needs doing but has no date yet.
 * Each has a window: it's eligible from its release date (and, when its round says so, a minimum
 * number of days after the property's last service), and due by a date. Badges say what to watch.
 */

export const PRIORITIES = ["low", "normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High" };

/** How a customer wants to hear before a visit (the plan's notify-before preference). */
export const NOTIFY_BEFORE = ["none", "text", "call"] as const;
export type NotifyBefore = (typeof NOTIFY_BEFORE)[number];
export const NOTIFY_BEFORE_LABELS: Record<NotifyBefore, string> = { none: "No notice", text: "Text ahead", call: "Call ahead" };

/** Why a scheduled service went back to the waiting list. */
export const BACK_REASONS = ["rain", "wind", "no_access", "customer", "other"] as const;
export const BACK_REASON_LABELS: Record<(typeof BACK_REASONS)[number], string> = { rain: "Rain", wind: "Wind", no_access: "No access", customer: "Customer asked", other: "Other" };

/** Days before the due-by date that a service counts as closing. */
export const CLOSING_DAYS = 7;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-04-15");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 13:00");
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

/** The window fields on a work order (also on its form). */
export const waitWindowFields = {
  /** When it can first be done (its release date); empty = now. */
  releaseOn: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  /** When its window closes. */
  dueBy: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  /** At least this many days after the property's last service (e.g. 21 between rounds). */
  minDaysAfterLast: z.preprocess(blankToNull, z.coerce.number().int().min(1).max(365).nullable()).optional(),
  priority: z.enum(PRIORITIES).default("normal"),
  /** An appointment window, e.g. after 13:00 (start only) or 9:00–12:00. */
  windowStart: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  windowEnd: z.preprocess(blankToNull, hhmm.nullable()).optional(),
};

export function checkWaitWindow(v: { releaseOn?: string | null; dueBy?: string | null; windowStart?: string | null; windowEnd?: string | null }, add: (path: string, message: string) => void) {
  if (v.releaseOn && v.dueBy && v.dueBy < v.releaseOn) add("dueBy", "The due-by date can't be before it's eligible");
  if (v.windowStart && v.windowEnd && v.windowEnd <= v.windowStart) add("windowEnd", "The window must end after it starts");
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/**
 * The first date it may be done: its release date, or the property's last service plus the
 * minimum days, whichever is later (null = any time).
 */
export function eligibleFrom(o: { releaseOn: string | null; minDaysAfterLast: number | null; lastServiceOn: string | null }): string | null {
  const byGap = o.minDaysAfterLast && o.lastServiceOn ? addDays(o.lastServiceOn, o.minDaysAfterLast) : null;
  if (!o.releaseOn) return byGap;
  if (!byGap) return o.releaseOn;
  return byGap > o.releaseOn ? byGap : o.releaseOn;
}

export type WaitBadge = "missed" | "closing" | "early" | "needs_card" | "dog" | "text_ahead" | "call_ahead" | "high";
export const BADGE_LABELS: Record<WaitBadge, string> = {
  missed: "Missed", closing: "Closing", early: "Too early", needs_card: "Needs card", dog: "Dog", text_ahead: "Text ahead", call_ahead: "Call ahead", high: "High priority",
};
export const BADGE_HINTS: Record<WaitBadge, string> = {
  missed: "Its due-by date has passed", closing: `Its window closes within ${CLOSING_DAYS} days`, early: "Before its eligible-from date (minimum days since the last service)",
  needs_card: "No card or bank account on file, and one is required", dog: "There's a dog at the property", text_ahead: "Text the customer before the visit",
  call_ahead: "Call the customer before the visit", high: "High priority",
};

/** The badges for one waiting service, in the order they matter. */
export function waitBadges(o: { today: string; dueBy: string | null; eligible: string | null; needsCard: boolean; pets: string | null; notify: NotifyBefore; priority: Priority }): WaitBadge[] {
  const b: WaitBadge[] = [];
  if (o.dueBy && o.dueBy < o.today) b.push("missed");
  else if (o.dueBy && daysBetween(o.today, o.dueBy) <= CLOSING_DAYS) b.push("closing");
  if (o.eligible && o.eligible > o.today) b.push("early");
  if (o.needsCard) b.push("needs_card");
  if (o.priority === "high") b.push("high");
  if (o.pets && /\bdogs?\b/i.test(o.pets)) b.push("dog");
  if (o.notify === "text") b.push("text_ahead");
  if (o.notify === "call") b.push("call_ahead");
  return b;
}

/** Minutes from lawn size: setup plus minutes per 1,000 sq ft (e.g. 5 + 3/1,000: a 10,000 sq ft lawn ≈ 35 min). */
export function sizeMinutes(rate: { setupMinutes: number | null; minutesPer1000: number | null }, sqFt: number | null): number | null {
  if (rate.setupMinutes == null && rate.minutesPer1000 == null) return null;
  return Math.round((rate.setupMinutes ?? 0) + ((rate.minutesPer1000 ?? 0) * (sqFt ?? 0)) / 1000);
}

/**
 * Minutes from the property's own visits (newest first, each Start to Complete): an average of the
 * last 3 to 5, recent ones counting more; visits far off the usual are left out (and counted, to flag).
 * One or two visits are blended with the size estimate; from three on, the history takes over.
 */
export function historyMinutes(durations: number[], sizeEstimate: number | null): { minutes: number | null; used: number; leftOut: number } {
  const recent = durations.filter((d) => d > 0).slice(0, 8);
  if (!recent.length) return { minutes: null, used: 0, leftOut: 0 };
  const sorted = [...recent].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const kept = recent.filter((d) => recent.length < 3 || (d <= median * 2.5 && d >= median * 0.4)).slice(0, 5);
  const weights = kept.map((_, i) => kept.length - i);
  const avg = kept.reduce((s, d, i) => s + d * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
  const share = kept.length >= 3 || sizeEstimate == null ? 1 : kept.length === 2 ? 2 / 3 : 1 / 2;
  return { minutes: Math.round(avg * share + (sizeEstimate ?? 0) * (1 - share)), used: kept.length, leftOut: recent.length - kept.length };
}

const ids = z.array(z.string().uuid()).min(1, "Select at least one").max(500);

/** "Edit work orders": schedule the selection. */
export const waitScheduleSchema = z.object({
  visitIds: ids,
  date: isoDate,
  crewId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  windowStart: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  windowEnd: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  /** Make the crew the property's preferred crew. */
  makePreferred: z.boolean().default(false),
  /** Text the customers who want a text ahead (when texting is connected). */
  notify: z.boolean().default(false),
  /** Needed when any are before their eligible-from date: why it's OK. */
  earlyReason: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
});
export type WaitScheduleInput = z.infer<typeof waitScheduleSchema>;

export const waitBackSchema = z.object({
  visitIds: ids,
  reason: z.enum(BACK_REASONS),
  note: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
});

export const waitBulkSchema = z.object({
  visitIds: ids,
  action: z.enum(["skip", "delete", "priority"]),
  reason: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  priority: z.enum(PRIORITIES).optional(),
}).superRefine((v, ctx) => {
  if (v.action === "skip" && !v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Say why they're skipped" });
  if (v.action === "priority" && !v.priority) ctx.addIssue({ code: "custom", path: ["priority"], message: "Pick the priority" });
});

/** A saved view of a list: its filters, columns and sort, for everyone or just you. */
export const savedViewSchema = z.object({
  page: z.enum(["waitlist", "dispatch"]),
  name: z.string().trim().min(1, "Name the view").max(80),
  shared: z.boolean().default(false),
  config: z.object({
    filters: z.array(z.object({ key: z.string().max(40), value: z.string().max(200) })).max(30).default([]),
    columns: z.array(z.string().max(40)).max(40).default([]),
    sort: z.object({ key: z.string().max(40), dir: z.enum(["asc", "desc"]) }).nullable().default(null),
  }),
});
export type SavedViewInput = z.infer<typeof savedViewSchema>;

/** Rate fields on a service type (for time estimates). */
export const serviceRateFields = {
  setupMinutes: z.preprocess(blankToNull, z.coerce.number().int().min(0).max(600).nullable()).optional(),
  minutesPer1000: z.preprocess(blankToNull, z.coerce.number().min(0).max(120).nullable()).optional(),
};
