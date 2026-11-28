import { z } from "zod";
import { MONTH_NAMES, WEEKDAY_NAMES } from "./holidays";

/**
 * To-dos: one-off or repeating jobs for the office or the crew, like Homeworks' to-dos. Each has a
 * date (optionally running over several days, optionally with a time), can be tied to a customer and
 * property or a free-text location, has a category, budgeted hours, a crew and/or people, notes for
 * the dispatcher, photos and documents, and tracked work time.
 */

/** Homeworks' 15 named colors. */
export const TODO_COLORS = [
  { key: "#2563eb", label: "Default" },
  { key: "#3b8eb5", label: "Boston Blue" },
  { key: "#16a34a", label: "Green" },
  { key: "#1e40af", label: "Bold blue" },
  { key: "#60a5fa", label: "Blue" },
  { key: "#0d9488", label: "Turquoise" },
  { key: "#84cc16", label: "Light green" },
  { key: "#166534", label: "Bold green" },
  { key: "#eab308", label: "Yellow" },
  { key: "#d97706", label: "Orange" },
  { key: "#dc2626", label: "Red" },
  { key: "#991b1b", label: "Bold red" },
  { key: "#7c3aed", label: "Purple" },
  { key: "#6b7280", label: "Gray" },
  { key: "#374151", label: "Dark Gray" },
] as const;
export const DEFAULT_TODO_COLOR = TODO_COLORS[0].key;
/** "Bold green", or null for a color that isn't one of the named ones. */
export const colorName = (hex: string | null | undefined) => TODO_COLORS.find((c) => c.key === hex?.toLowerCase())?.label ?? null;

/** The older fixed repeats, still read from earlier to-dos and accepted by the API. */
export const TODO_REPEATS = ["none", "daily", "weekdays", "weekly", "biweekly", "monthly"] as const;
export type TodoRepeat = (typeof TODO_REPEATS)[number];
export const TODO_REPEAT_LABELS: Record<TodoRepeat, string> = {
  none: "Single to-do",
  daily: "Every day",
  weekdays: "Every weekday (Mon–Fri)",
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
};

// ---- Repeat rules (Homeworks' "Recurring Series of To-do")

export const TODO_FREQS = ["daily", "weekly", "monthly", "yearly"] as const;
export type TodoFreq = (typeof TODO_FREQS)[number];
export const TODO_FREQ_LABELS: Record<TodoFreq, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };
/** How a series ends: on a last date, after a number of to-dos, or never. */
export const TODO_ENDS = ["date", "count", "never"] as const;
export type TodoEnd = (typeof TODO_ENDS)[number];
/** The order weekday pickers list them in (Monday first, like Homeworks). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const NTH_OPTIONS = [[1, "First"], [2, "Second"], [3, "Third"], [4, "Fourth"], [-1, "Last"]] as const;
/** The most to-dos one series makes. */
export const TODO_SERIES_MAX = 500;
/** How far ahead repeating to-dos are made; series that run longer are topped up as time passes. */
export const TODO_HORIZON_DAYS = 366;
/** A series can end up to this many years after it starts (or never). */
export const TODO_UNTIL_MAX_YEARS = 5;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optInt = (min: number, max: number) => z.preprocess(blankToNull, z.coerce.number().int().min(min).max(max).nullable()).optional();

export const todoRuleSchema = z.object({
  freq: z.enum(TODO_FREQS),
  /** Every N days / weeks / months / years. */
  every: z.coerce.number().int().min(1, "Repeat at least every 1").max(99, "Pick 99 or less").default(1),
  /** Daily: Monday to Friday instead of every N days. */
  weekdaysOnly: z.boolean().default(false),
  /** Weekly: which days (0 = Sunday); none means the first date's day. */
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  /** Monthly and yearly: on a day of the month, or on the Nth weekday. */
  by: z.enum(["day", "nth"]).default("day"),
  day: optInt(1, 31),
  nth: z.preprocess(blankToNull, z.coerce.number().int().refine((n) => [1, 2, 3, 4, -1].includes(n), "Pick first to fourth, or last").nullable()).optional(),
  weekday: optInt(0, 6),
  /** Yearly: the month (1-12). */
  month: optInt(1, 12),
  end: z.enum(TODO_ENDS).default("date"),
  until: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  count: z.preprocess(blankToNull, z.coerce.number().int().min(1, "Make at least 1").max(TODO_SERIES_MAX, `Up to ${TODO_SERIES_MAX} at a time`).nullable()).optional(),
  /** Skip the dates that fall in this saved off-season. */
  offSeasonId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
});
export type TodoRule = z.infer<typeof todoRuleSchema>;
type RuleIn = z.input<typeof todoRuleSchema>;

const dayMs = 86_400_000;
const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * dayMs);
const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / dayMs);
const dow = (d: string) => new Date(toUtc(d)).getUTCDay();
const ymd = (y: number, m: number, d: number) => fromUtc(Date.UTC(y, m - 1, d));
const monthLength = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Day `d` of a month, or its last day when the month is shorter (31 → Feb 28). */
const clampDay = (y: number, m: number, d: number) => ymd(y, m, Math.min(d, monthLength(y, m)));
/** The Nth (1-4, or -1 for last) given weekday of a month. */
function nthWeekday(y: number, m: number, nth: number, weekday: number) {
  if (nth === -1) {
    const last = ymd(y, m, monthLength(y, m));
    return addDays(last, -((dow(last) - weekday + 7) % 7));
  }
  const first = ymd(y, m, 1);
  return addDays(first, (weekday - dow(first) + 7) % 7 + (nth - 1) * 7);
}
/** Which occurrence of its weekday a date is in its month (1-4, or -1 for a fifth, which is the last). */
const nthOf = (d: string) => { const n = Math.ceil(Number(d.slice(8)) / 7); return n > 4 ? -1 : n; };

/** The rule with the blanks filled in from the first date (its weekday, day of month, month). */
export function normalizeRule(start: string, rule: RuleIn): TodoRule {
  const r = todoRuleSchema.parse(rule);
  return {
    ...r,
    weekdays: r.weekdays.length ? [...new Set(r.weekdays)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) : [dow(start)],
    day: r.day ?? Number(start.slice(8)),
    nth: r.nth ?? nthOf(start),
    weekday: r.weekday ?? dow(start),
    month: r.month ?? Number(start.slice(5, 7)),
  };
}

/** Every date the rule gives from `start` on, in order, without end (the caller stops). */
function* candidates(start: string, r: TodoRule): Generator<string> {
  const y0 = Number(start.slice(0, 4));
  const m0 = Number(start.slice(5, 7));
  if (r.freq === "daily") {
    for (let d = start; ; d = addDays(d, r.weekdaysOnly ? 1 : r.every)) {
      if (r.weekdaysOnly && (dow(d) === 0 || dow(d) === 6)) continue;
      yield d;
    }
  }
  if (r.freq === "weekly") {
    // Weeks count from the first picked day on or after the start (a Sunday start with Monday
    // picked begins the next day, even every 2 weeks).
    const first = Array.from({ length: 7 }, (_, i) => addDays(start, i)).find((d) => r.weekdays.includes(dow(d)))!;
    const monday = addDays(first, -((dow(first) + 6) % 7));
    for (let k = 0; ; k += r.every) {
      for (const w of r.weekdays) {
        const d = addDays(monday, k * 7 + ((w + 6) % 7));
        if (d >= start) yield d;
      }
    }
  }
  if (r.freq === "monthly") {
    for (let i = 0; ; i += r.every) {
      const y = y0 + Math.floor((m0 - 1 + i) / 12);
      const m = ((m0 - 1 + i) % 12) + 1;
      const d = r.by === "nth" ? nthWeekday(y, m, r.nth!, r.weekday!) : clampDay(y, m, r.day!);
      if (d >= start) yield d;
    }
  }
  for (let i = 0; ; i += r.every) {
    const d = r.by === "nth" ? nthWeekday(y0 + i, r.month!, r.nth!, r.weekday!) : clampDay(y0 + i, r.month!, r.day!);
    if (d >= start) yield d;
  }
}

/** A saved off-season, as month-day pairs ("12-01" to "02-28" runs over New Year). */
export interface OffSeason { start: string; end: string }
export function inOffSeason(date: string, s: OffSeason) {
  const md = date.slice(5);
  return s.start <= s.end ? md >= s.start && md <= s.end : md >= s.start || md <= s.end;
}

/**
 * The dates a repeating to-do falls on, from `start`. Series ending on a date or never are made up to
 * `through` (default: a year after `start`), and later ones are topped up; `after` skips the dates
 * already made. A series of N to-dos is made all at once. Never more than TODO_SERIES_MAX.
 */
export function ruleDates(start: string, rule: RuleIn, opts: { offSeason?: OffSeason | null; through?: string; after?: string; max?: number } = {}): string[] {
  const r = normalizeRule(start, rule);
  const max = opts.max ?? TODO_SERIES_MAX;
  const horizon = r.end === "count" ? null : opts.through ?? addDays(start, TODO_HORIZON_DAYS);
  const last = r.end === "date" && r.until ? (horizon && horizon < r.until ? horizon : r.until) : horizon;
  const stop = addDays(start, 366 * 60);
  const out: string[] = [];
  let made = 0;
  for (const d of candidates(start, r)) {
    if (d > stop || (last && d > last)) break;
    if (opts.offSeason && inOffSeason(d, opts.offSeason)) continue;
    made++;
    if (opts.after && d <= opts.after) continue;
    out.push(d);
    if (r.end === "count" && made >= (r.count ?? 1)) break;
    if (out.length >= max) break;
  }
  return out;
}

/** The older fixed repeats as rules. */
export function legacyRule(repeat: TodoRepeat, start: string, until: string | null | undefined): TodoRule | null {
  if (repeat === "none") return null;
  const end = { end: "date" as const, until: until ?? null };
  const rule: RuleIn =
    repeat === "daily" ? { freq: "daily", ...end }
    : repeat === "weekdays" ? { freq: "daily", weekdaysOnly: true, ...end }
    : repeat === "weekly" ? { freq: "weekly", ...end }
    : repeat === "biweekly" ? { freq: "weekly", every: 2, ...end }
    : { freq: "monthly", ...end };
  return normalizeRule(start, rule);
}

const shortDay = (w: number) => WEEKDAY_NAMES[w].slice(0, 3);
const nthName = (n: number) => NTH_OPTIONS.find(([k]) => k === n)?.[1].toLowerCase() ?? "";
const plural = (n: number, unit: string) => (n === 1 ? unit : `${n} ${unit}s`);
export const formatDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Every 2 weeks on Mon, Wed", "The last Friday of every month", "Every year on March 15". */
export function describeTodoRule(start: string, rule: RuleIn): string {
  const r = normalizeRule(start, rule);
  if (r.freq === "daily") return r.weekdaysOnly ? "Every weekday" : `Every ${plural(r.every, "day")}`;
  if (r.freq === "weekly") return `Every ${plural(r.every, "week")} on ${r.weekdays.map(shortDay).join(", ")}`;
  if (r.freq === "monthly") {
    const each = `every ${plural(r.every, "month")}`;
    return r.by === "nth" ? `The ${nthName(r.nth!)} ${WEEKDAY_NAMES[r.weekday!]} of ${each}` : `Day ${r.day} of ${each}`;
  }
  const years = r.every === 1 ? "every year" : `every ${r.every} years`;
  return r.by === "nth"
    ? `The ${nthName(r.nth!)} ${WEEKDAY_NAMES[r.weekday!]} of ${MONTH_NAMES[r.month! - 1]}, ${years}`
    : `${years[0].toUpperCase()}${years.slice(1)} on ${MONTH_NAMES[r.month! - 1]} ${r.day}`;
}

/** The whole rule in a line: "Every week on Mon until Dec 21, 2026 · not during Winter". */
export function describeSeries(start: string, rule: RuleIn, offSeasonName?: string | null) {
  const r = normalizeRule(start, rule);
  const end = r.end === "date" && r.until ? ` until ${formatDay(r.until)}` : r.end === "count" ? `, ${r.count ?? 1} times` : ", no end date";
  return `${describeTodoRule(start, r)}${end}${offSeasonName ? ` · not during ${offSeasonName}` : ""}`;
}

/**
 * Homeworks' "Based on these settings, the first event will be on … and the last will be on …".
 * Open-ended series say so instead of naming a last date.
 */
export function previewSeries(start: string, rule: RuleIn, offSeason?: OffSeason | null) {
  const r = normalizeRule(start, rule);
  const through = r.end === "date" && r.until ? r.until : undefined;
  const dates = ruleDates(start, r, { offSeason, through, max: r.end === "never" ? 2 : TODO_SERIES_MAX + 1 });
  if (!dates.length) return { count: 0, text: "These settings don't make any to-dos. Check the dates and the off-season." };
  const first = formatDay(dates[0]);
  if (r.end === "never") return { count: null, text: `Based on these settings, the first to-do will be on ${first}, and they carry on with no end date.` };
  const too = dates.length > TODO_SERIES_MAX;
  const n = Math.min(dates.length, TODO_SERIES_MAX);
  return {
    count: n,
    text: `Based on these settings, the first to-do will be on ${first} and the last will be on ${formatDay(dates[n - 1])} (${n} to-do${n === 1 ? "" : "s"}${too ? `, the most one series can make` : ""}).`,
  };
}

// ---- The form

const todoFields = z.object({
  title: z.string().trim().min(1, "Give the to-do a title or description").max(300),
  notes: z.preprocess(blankToNull, z.string().trim().max(5000).nullable()).optional(),
  customerId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  propertyId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  location: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color").default(DEFAULT_TODO_COLOR),
  categoryId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  crewId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  date: isoDate,
  /** Multi-day to-dos: the last day (inclusive). */
  endDate: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  startTime: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  endTime: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0, "Hours can't be negative").max(999).nullable()).optional(),
  /** Who it's for; empty means nobody in particular (it shows to managers). */
  assigneeIds: z.array(z.string().uuid()).max(50).default([]),
  /** A repeating series; none for a single to-do. */
  rule: todoRuleSchema.nullable().optional(),
});

type TodoFields = z.infer<typeof todoFields>;
function checkTodo(v: Partial<TodoFields>, ctx: z.RefinementCtx) {
  if (v.propertyId && !v.customerId) ctx.addIssue({ code: "custom", path: ["propertyId"], message: "Pick the customer first" });
  if (v.endDate && v.date && v.endDate < v.date) ctx.addIssue({ code: "custom", path: ["endDate"], message: "The last day can't be before the first" });
  if (v.endTime && !v.startTime) ctx.addIssue({ code: "custom", path: ["startTime"], message: "Add a start time too" });
  if (v.startTime && v.endTime && (!v.endDate || v.endDate === v.date) && v.endTime <= v.startTime) {
    ctx.addIssue({ code: "custom", path: ["endTime"], message: "The end time must be after the start time" });
  }
  const r = v.rule;
  if (!r || !v.date) return;
  if (v.endDate && v.endDate !== v.date) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Recurring to-dos are one day each" });
  if (r.end === "date") {
    if (!r.until) return ctx.addIssue({ code: "custom", path: ["rule", "until"], message: "Pick the last date you'll make a to-do" });
    if (r.until < v.date) return ctx.addIssue({ code: "custom", path: ["rule", "until"], message: "Pick a last date after the first one" });
    if (daysBetween(v.date, r.until) > TODO_UNTIL_MAX_YEARS * 366) return ctx.addIssue({ code: "custom", path: ["rule", "until"], message: `A series can run up to ${TODO_UNTIL_MAX_YEARS} years, or pick no end date` });
  }
  if (r.end === "count" && !r.count) return ctx.addIssue({ code: "custom", path: ["rule", "count"], message: "How many to-dos?" });
  // (Zod still runs this check when a rule field failed; that's reported already.)
  const parsed = todoRuleSchema.safeParse(r);
  if (parsed.success && !ruleDates(v.date, parsed.data, { max: 1 }).length) ctx.addIssue({ code: "custom", path: ["rule"], message: "These settings don't make any to-dos. Check the dates." });
}

/** Older clients send repeat + repeatUntil: those become a rule. */
const withLegacyRepeat = (raw: unknown) => {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  if (o.rule || !o.repeat || o.repeat === "none" || !(TODO_REPEATS as readonly unknown[]).includes(o.repeat) || typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return raw;
  return { ...o, rule: legacyRule(o.repeat as TodoRepeat, o.date, typeof o.repeatUntil === "string" && o.repeatUntil ? o.repeatUntil : null) };
};

export const todoSchema = z.preprocess(withLegacyRepeat, todoFields.superRefine(checkTodo));
export type TodoInput = z.infer<typeof todoSchema>;
/** Editing changes that one to-do, or it and the later ones in its series (the repeat itself stays). */
export const todoUpdateSchema = todoFields.omit({ rule: true }).superRefine(checkTodo);
export type TodoUpdate = z.infer<typeof todoUpdateSchema>;

// ---- Categories, off-seasons, notes for the dispatcher, work tracking

export const todoCategorySchema = z.object({ name: z.string().trim().min(1, "Name the category").max(60) });

const monthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Pick a month and day")
  .refine((s) => Number(s.slice(3)) <= monthLength(2028, Number(s.slice(0, 2))), "That day isn't in that month");
/** Homeworks' "Available Seasons": a named stretch of the year (e.g. Winter, Dec 1 to Feb 28) to pause series in. */
export const offSeasonSchema = z.object({
  name: z.string().trim().min(1, "Name the off-season").max(60),
  start: monthDay,
  end: monthDay,
}).refine((s) => s.start !== s.end, { path: ["end"], message: "Pick an end after the start" });
export type OffSeasonInput = z.infer<typeof offSeasonSchema>;
/** "03-01" → "March 1". */
export const formatMonthDay = (md: string) => `${MONTH_NAMES[Number(md.slice(0, 2)) - 1]} ${Number(md.slice(3))}`;

/** A note for the dispatcher on a to-do (Homeworks' "Notes for the Dispatcher"). */
export const todoNoteSchema = z.object({ body: z.string().trim().min(1, "Write the note").max(2000) });

/** Work time on a to-do so far, in minutes, counting a timer that's still running. */
export function trackedMinutes(t: { trackedSeconds?: number | null; startedAt?: string | Date | null }, now = new Date()) {
  const running = t.startedAt ? Math.max(0, (now.getTime() - new Date(t.startedAt).getTime()) / 1000) : 0;
  return Math.floor(((t.trackedSeconds ?? 0) + running) / 60);
}
/** "1 h 05 m", "12 m". */
export function formatMinutes(m: number) {
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m` : `${m} m`;
}

// ---- Status and display

/** The dates a to-do falls on with the older fixed repeats (kept for earlier callers). */
export function todoDates(start: string, repeat: TodoRepeat, until: string | null | undefined): string[] {
  const rule = legacyRule(repeat, start, until);
  if (!rule || !until || until < start) return [start];
  return ruleDates(start, rule, { through: daysBetween(start, until) > TODO_HORIZON_DAYS ? addDays(start, TODO_HORIZON_DAYS) : until });
}

export type TodoState = "done" | "overdue" | "today" | "upcoming";
/** Where a to-do stands on `today` (the company's local date). */
export function todoState(t: { date: string; endDate?: string | null; doneAt?: string | Date | null }, today: string): TodoState {
  if (t.doneAt) return "done";
  const last = t.endDate ?? t.date;
  if (last < today) return "overdue";
  if (t.date <= today) return "today";
  return "upcoming";
}

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
/** "8:00 AM – 10:30 AM", "8:00 AM", or "" with no time. */
export function formatTodoTime(startTime?: string | null, endTime?: string | null) {
  if (!startTime) return "";
  return endTime ? `${clock(startTime)} – ${clock(endTime)}` : clock(startTime);
}
