import { z } from "zod";

/** Texting customers from the company's own number: what can be sent, and how replies are read. */

/** Ten segments' worth, the most Homeworks lets a text be. */
export const TEXT_MAX = 1600;
export const textBodySchema = z.object({
  body: z.string().trim().min(1, "Write the text").max(TEXT_MAX, `Keep it under ${TEXT_MAX} characters`),
});

// The GSM-7 alphabet (plus its extension table, which counts double). Anything else makes the text UCS-2.
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** How many text messages (segments) this body is sent as, and its length as the carrier counts it. */
export function textSegments(body: string): { segments: number; length: number; unicode: boolean } {
  const chars = [...body];
  const unicode = chars.some((c) => !GSM.includes(c) && !GSM_EXT.includes(c));
  const length = unicode ? chars.reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0) : chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
  if (!length) return { segments: 0, length, unicode };
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return { segments: length <= single ? 1 : Math.ceil(length / multi), length, unicode };
}

/** Replies that mean "stop texting me" and "start again" (carriers' standard words). */
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT-OUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES", "OPTIN", "OPT-IN"]);
export function textKeyword(body: string): "stop" | "start" | null {
  const w = body.trim().toUpperCase().replace(/[.!]+$/, "");
  return STOP_WORDS.has(w) ? "stop" : START_WORDS.has(w) && w !== "YES" ? "start" : null;
}

/** Words in a text, as the box under it counts them. */
export const textWords = (body: string) => (body.trim() ? body.trim().split(/\s+/).length : 0);

/** The Text Messages list: every conversation, the unread ones, or those still open / marked done. */
export const TEXT_FILTERS = ["all", "unread", "mine", "open", "done"] as const;
export type TextFilter = (typeof TEXT_FILTERS)[number];
export const TEXT_THREAD_STATUSES = ["open", "done"] as const;
export type TextThreadStatus = (typeof TEXT_THREAD_STATUSES)[number];

/** Two letters for the round badge beside a name ("John Example" → "JE"); a phone number gets "#". */
export function textInitials(name: string | null | undefined): string {
  const parts = (name ?? "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length || /^\d/.test(parts[0])) return "#";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export const TEXT_GROUP_NAME_MAX = 80;
export const textGroupSchema = z.object({ name: z.string().trim().min(1, "Give the group a name").max(TEXT_GROUP_NAME_MAX) });

/** Who a text goes to from the Send Text Messages tab: any mix of customers, employees, groups, crews and typed numbers. */
export const textSendSchema = z.object({
  body: z.string().trim().min(1, "Write the text").max(TEXT_MAX, `Keep it under ${TEXT_MAX} characters`),
  customerIds: z.array(z.string().uuid()).max(5000).default([]),
  employeeIds: z.array(z.string().uuid()).max(1000).default([]),
  groupIds: z.array(z.string().uuid()).max(100).default([]),
  crewIds: z.array(z.string().uuid()).max(100).default([]),
  phones: z.array(z.string().trim().min(7).max(30)).max(100).default([]),
  /** To go later rather than now. */
  sendAt: z.string().datetime({ offset: true }).nullish(),
});
export type TextSend = z.infer<typeof textSendSchema>;

/** Why someone on a send was left out. */
export const TEXT_SKIP_REASONS = { no_number: "No mobile number", opted_out: "Replied STOP", sample: "Sample customer", duplicate: "Same number as someone else on the list" } as const;
export type TextSkipReason = keyof typeof TEXT_SKIP_REASONS;

/* ───────────── The office's texting choices ───────────── */

export const TEXT_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type TextDay = (typeof TEXT_DAYS)[number];
export const TEXT_DAY_LABELS: Record<TextDay, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time");
/** A day's open hours ("08:00" to "17:00"), or null when closed. */
const dayHours = z.object({ open: clock, close: clock }).refine((h) => h.open < h.close, "Closing has to be after opening").nullable();

export const textingOptionsSchema = z.object({
  /** A text sent back by itself when someone texts outside office hours. */
  autoReply: z.object({
    enabled: z.boolean(),
    message: z.string().trim().max(480),
    hours: z.object({ sun: dayHours, mon: dayHours, tue: dayHours, wed: dayHours, thu: dayHours, fri: dayHours, sat: dayHours }),
  }).refine((a) => !a.enabled || a.message.length > 0, "Write the after-hours reply"),
  /** A text sent by itself to someone whose call was missed. */
  missedCall: z.object({ enabled: z.boolean(), message: z.string().trim().max(480) }).refine((m) => !m.enabled || m.message.length > 0, "Write the missed-call text"),
});
export type TextingChoices = z.infer<typeof textingOptionsSchema>;

/** How a long job (bringing in past texts, copying customers to the phone service) is going. */
export interface TextingJob { startedAt: string; finishedAt?: string | null; done: number; total: number; added: number; error?: string | null }
export interface TextingOptions extends Partial<TextingChoices> { history?: TextingJob | null; contacts?: TextingJob | null }

const weekdays = { open: "08:00", close: "17:00" };
export const DEFAULT_TEXTING_CHOICES: TextingChoices = {
  autoReply: { enabled: false, message: "Thanks for your text! Our office is closed right now. We'll get back to you when we open.", hours: { sun: null, mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays, sat: null } },
  missedCall: { enabled: false, message: "Sorry we missed your call! This is {{COMPANY_NAME}}. Text us here and we'll get right back to you." },
};
export const textingChoices = (o: TextingOptions | null | undefined): TextingChoices => ({ autoReply: o?.autoReply ?? DEFAULT_TEXTING_CHOICES.autoReply, missedCall: o?.missedCall ?? DEFAULT_TEXTING_CHOICES.missedCall });

/** A wall clock time in a time zone, as { day, minutes since midnight }. */
export function clockIn(at: Date, timeZone: string): { day: TextDay; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: get("weekday").toLowerCase().slice(0, 3) as TextDay, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether the office is open at this moment, by its texting hours. */
export function officeOpen(hours: TextingChoices["autoReply"]["hours"], at: Date, timeZone: string): boolean {
  const { day, minutes } = clockIn(at, timeZone);
  const h = hours[day];
  return !!h && minutes >= mins(h.open) && minutes < mins(h.close);
}

export const textQuietSchema = z.object({ start: clock, end: clock }).refine((q) => q.start !== q.end, "Pick two different times").nullable();
export type TextQuiet = z.infer<typeof textQuietSchema>;
/** Whether it's inside someone's quiet hours (which may run past midnight: 21:00 to 07:00). */
export function inQuietHours(q: { start: string; end: string } | null | undefined, at: Date, timeZone: string): boolean {
  if (!q) return false;
  const { minutes } = clockIn(at, timeZone);
  const s = mins(q.start), e = mins(q.end);
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

export const textQuickReplySchema = z.object({ title: z.string().trim().min(1, "Give it a short name").max(60), body: z.string().trim().min(1, "Write the reply").max(TEXT_MAX) });

/** Pictures on a text: what can be sent, and how big (carriers turn away large ones). */
export const TEXT_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif"] as const;
export const TEXT_MEDIA_MAX_BYTES = 1_500_000;
/** How far back past conversations can be brought in. */
export const TEXT_HISTORY_DAYS = [30, 90, 365] as const;
