import { z } from "zod";

/**
 * To-dos: one-off or repeating jobs for the office or the crew, like Homeworks' to-dos. Each has a
 * date (optionally running over several days, optionally with a time), can be tied to a customer and
 * property or a free-text location, carries budgeted hours, and goes to one or more people.
 */

export const TODO_COLORS = [
  { key: "#2563eb", label: "Blue" },
  { key: "#16a34a", label: "Green" },
  { key: "#d97706", label: "Orange" },
  { key: "#dc2626", label: "Red" },
  { key: "#7c3aed", label: "Purple" },
  { key: "#0d9488", label: "Teal" },
  { key: "#db2777", label: "Pink" },
  { key: "#6b7280", label: "Gray" },
] as const;
export const DEFAULT_TODO_COLOR = TODO_COLORS[0].key;

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
/** Repeating to-dos are made up front, up to a year ahead. */
export const TODO_REPEAT_MAX_DAYS = 366;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const todoFields = z.object({
  title: z.string().trim().min(1, "Give the to-do a title or description").max(300),
  notes: z.preprocess(blankToNull, z.string().trim().max(5000).nullable()).optional(),
  customerId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  propertyId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  location: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color").default(DEFAULT_TODO_COLOR),
  date: isoDate,
  /** Multi-day to-dos: the last day (inclusive). */
  endDate: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  startTime: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  endTime: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0, "Hours can't be negative").max(999).nullable()).optional(),
  /** Who it's for; empty means nobody in particular (it shows to managers). */
  assigneeIds: z.array(z.string().uuid()).max(50).default([]),
  repeat: z.enum(TODO_REPEATS).default("none"),
  repeatUntil: z.preprocess(blankToNull, isoDate.nullable()).optional(),
});

type TodoFields = z.infer<typeof todoFields>;
function checkTodo(v: Partial<TodoFields>, ctx: z.RefinementCtx) {
  if (v.propertyId && !v.customerId) ctx.addIssue({ code: "custom", path: ["propertyId"], message: "Pick the customer first" });
  if (v.endDate && v.date && v.endDate < v.date) ctx.addIssue({ code: "custom", path: ["endDate"], message: "The last day can't be before the first" });
  if (v.endTime && !v.startTime) ctx.addIssue({ code: "custom", path: ["startTime"], message: "Add a start time too" });
  if (v.startTime && v.endTime && (!v.endDate || v.endDate === v.date) && v.endTime <= v.startTime) {
    ctx.addIssue({ code: "custom", path: ["endTime"], message: "The end time must be after the start time" });
  }
  if (v.repeat && v.repeat !== "none") {
    if (v.endDate && v.endDate !== v.date) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Repeating to-dos are one day each" });
    if (!v.repeatUntil) ctx.addIssue({ code: "custom", path: ["repeatUntil"], message: "Pick the last date it repeats" });
    else if (v.date && v.repeatUntil < v.date) ctx.addIssue({ code: "custom", path: ["repeatUntil"], message: "Pick a date after the first one" });
    else if (v.date && daysBetween(v.date, v.repeatUntil) > TODO_REPEAT_MAX_DAYS) ctx.addIssue({ code: "custom", path: ["repeatUntil"], message: "Repeats can go up to a year ahead" });
  }
}

export const todoSchema = todoFields.superRefine(checkTodo);
export type TodoInput = z.infer<typeof todoSchema>;
/** Editing changes that one to-do (a repeating series isn't re-made). */
export const todoUpdateSchema = todoFields.omit({ repeat: true, repeatUntil: true }).superRefine(checkTodo);
export type TodoUpdate = z.infer<typeof todoUpdateSchema>;

const dayMs = 86_400_000;
const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * dayMs);
const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / dayMs);

/** The dates a to-do falls on: just `start`, or every repeat from `start` through `until`. */
export function todoDates(start: string, repeat: TodoRepeat, until: string | null | undefined): string[] {
  if (repeat === "none" || !until || until < start) return [start];
  const last = daysBetween(start, until) > TODO_REPEAT_MAX_DAYS ? addDays(start, TODO_REPEAT_MAX_DAYS) : until;
  const out: string[] = [];
  if (repeat === "monthly") {
    // Same day each month; short months use their last day (Jan 31 → Feb 28 → Mar 31).
    const [y, m, d] = start.split("-").map(Number);
    for (let i = 0; ; i++) {
      const month = new Date(Date.UTC(y, m - 1 + i, 1));
      const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
      const date = fromUtc(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(d, lastDay)));
      if (date > last) break;
      out.push(date);
    }
    return out;
  }
  const step = repeat === "weekly" ? 7 : repeat === "biweekly" ? 14 : 1;
  for (let date = start; date <= last; date = addDays(date, step)) {
    if (repeat === "weekdays") {
      const dow = new Date(toUtc(date)).getUTCDay();
      if (dow === 0 || dow === 6) continue;
    }
    out.push(date);
  }
  return out;
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
