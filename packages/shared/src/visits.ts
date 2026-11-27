import { z } from "zod";
import { taxRateSchema } from "./tax";
import { lineAmount } from "./billing";
import { DEFAULT_TODO_COLOR } from "./todos";
import { checkWaitWindow, waitWindowFields } from "./waitlist";
import { chemicalCompletionSchema } from "./chemicalRecords";
import { VISIT_FORMS_MAX } from "./visitForms";
import { lawnAreaFields } from "./lawnArea";

/**
 * Work orders: scheduled jobs at a customer's property (Homeworks calls them visits). Each has the
 * services to do (from the price list, priced for the lawn), the crew, a date (or the waitlist), and
 * goes Open → On site → Completed (or Skipped). Completed ones are invoiced. Stored as "visits" so
 * they don't clash with repair orders (which are stored as work_orders).
 */

export const VISIT_STATUSES = ["open", "on_site", "completed", "skipped"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = { open: "Open", on_site: "On site", completed: "Completed", skipped: "Skipped" };

export const VISIT_BILLING = ["invoice", "none"] as const;
export type VisitBilling = (typeof VISIT_BILLING)[number];
export const VISIT_BILLING_LABELS: Record<VisitBilling, string> = { invoice: "Invoice services", none: "Don't invoice" };

export const VISIT_SCHEDULING = ["single", "repeat", "waitlist"] as const;
export type VisitScheduling = (typeof VISIT_SCHEDULING)[number];
export const VISIT_SCHEDULING_LABELS: Record<VisitScheduling, string> = {
  single: "Single work order",
  repeat: "Repeating series of work orders",
  waitlist: "Add to the waitlist (no date yet)",
};

export const REPEAT_UNITS = ["day", "week", "month", "year"] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];
/** Made up front; a series can run up to three years and 200 work orders. */
export const VISIT_REPEAT_MAX_DAYS = 3 * 366;
export const VISIT_REPEAT_MAX = 200;
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export const visitNumber = (n: number | null | undefined) => (n ? `WO-${n}` : "WO");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const visitLineSchema = z.object({
  serviceTypeId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  description: z.string().trim().min(1, "Name the line item").max(500),
  quantity: z.coerce.number().positive("The quantity must be more than 0").max(100_000).multipleOf(0.01),
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0).max(999).nullable()).optional(),
  unitPriceCents: z.coerce.number().int().min(0, "Prices can't be negative").max(100_000_000),
  /** Sales tax on this line, in percent (0 = not taxed); invoices made from the work order keep it. */
  taxRate: taxRateSchema.default(0),
  /** The part of the lawn the line is for: its price, time and product amounts come from that size. */
  ...lawnAreaFields,
});
export type VisitLineInput = z.infer<typeof visitLineSchema>;

const visitFields = z.object({
  title: z.string().trim().min(1, "Give the work order a title or description").max(300),
  customerId: z.string({ required_error: "Pick the customer" }).uuid({ message: "Pick the customer" }),
  propertyId: z.string({ required_error: "Pick the property" }).uuid({ message: "Pick the property" }),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color").default(DEFAULT_TODO_COLOR),
  location: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  billing: z.enum(VISIT_BILLING).default("invoice"),
  lines: z.array(visitLineSchema).max(50).default([]),
  scheduling: z.enum(VISIT_SCHEDULING).default("single"),
  date: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  endDate: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  startTime: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  endTime: z.preprocess(blankToNull, hhmm.nullable()).optional(),
  /** Left empty, it's the line items' budgeted hours added up. */
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0).max(999).nullable()).optional(),
  assigneeIds: z.array(z.string().uuid()).max(50).default([]),
  /** From the company's tag list (the same tags as customers and properties). */
  tagIds: z.array(z.string().uuid()).max(30).default([]),
  /** The crew it's for (its members are usually the people above). */
  crewId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  /** For the crew (gate, where to start, what to watch for). */
  notes: z.preprocess(blankToNull, z.string().trim().max(5000).nullable()).optional(),
  /**
   * The visit forms the crew fills in on it (Resources → Visit Forms). Left out of a new work
   * order, it gets the forms set to attach automatically; left out of a change, its forms stay.
   */
  formIds: z.array(z.string().uuid()).max(VISIT_FORMS_MAX).optional(),
  repeatEvery: z.coerce.number().int().min(1).max(52).default(1),
  repeatUnit: z.enum(REPEAT_UNITS).default("week"),
  repeatUntil: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  /** Months with no work (the off-season): repeats that land in them are left out. */
  offMonths: z.array(z.number().int().min(1).max(12)).max(11).default([]),
  // The waiting list window: eligible from, due by, minimum days since the last service, priority, appointment window.
  ...waitWindowFields,
});
type VisitFields = z.infer<typeof visitFields>;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function checkVisit(v: Partial<VisitFields>, ctx: z.RefinementCtx) {
  checkWaitWindow(v, (path, message) => ctx.addIssue({ code: "custom", path: [path], message }));
  const waitlist = v.scheduling === "waitlist";
  if (!waitlist && !v.date) ctx.addIssue({ code: "custom", path: ["date"], message: "Pick the date (or add it to the waitlist)" });
  if (v.endDate && v.date && v.endDate < v.date) ctx.addIssue({ code: "custom", path: ["endDate"], message: "The last day can't be before the first" });
  if (v.endTime && !v.startTime) ctx.addIssue({ code: "custom", path: ["startTime"], message: "Add a start time too" });
  if (v.startTime && v.endTime && (!v.endDate || v.endDate === v.date) && v.endTime <= v.startTime) {
    ctx.addIssue({ code: "custom", path: ["endTime"], message: "The end time must be after the start time" });
  }
  if (v.scheduling === "repeat") {
    if (v.endDate && v.endDate !== v.date) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Repeating work orders are one day each" });
    if (!v.repeatUntil) ctx.addIssue({ code: "custom", path: ["repeatUntil"], message: "Pick the last date it repeats" });
    else if (v.date && v.repeatUntil <= v.date) ctx.addIssue({ code: "custom", path: ["repeatUntil"], message: "Pick a date after the first one" });
    else if (v.date && daysBetween(v.date, v.repeatUntil) > VISIT_REPEAT_MAX_DAYS) ctx.addIssue({ code: "custom", path: ["repeatUntil"], message: "A series can run up to three years" });
    else if (v.date && v.offMonths && visitDates(v.date, v.repeatUnit ?? "week", v.repeatEvery ?? 1, v.repeatUntil, v.offMonths).length > VISIT_REPEAT_MAX) {
      ctx.addIssue({ code: "custom", path: ["repeatUntil"], message: `That's more than ${VISIT_REPEAT_MAX} work orders; pick an earlier end date` });
    }
  }
}

export const visitSchema = visitFields.superRefine(checkVisit);
export type VisitInput = z.infer<typeof visitSchema>;
/** Editing one work order (or this and later ones): no new series; no date puts it on the waitlist. */
export const visitUpdateSchema = visitFields.omit({ scheduling: true, repeatEvery: true, repeatUnit: true, repeatUntil: true, offMonths: true })
  .superRefine((v, ctx) => checkVisit({ ...v, scheduling: v.date ? "single" : "waitlist" }, ctx));
export type VisitUpdate = z.infer<typeof visitUpdateSchema>;

export const visitCompleteSchema = z.object({
  notes: z.preprocess(blankToNull, z.string().trim().max(5000).nullable()).optional(),
  /** Where the phone was (when location is allowed): stamped on the application record. */
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
  /** Chemical work orders: what the tech confirms was applied, and how (see chemicalCompletionSchema). */
  chemicals: chemicalCompletionSchema.optional(),
});
export const visitSkipSchema = z.object({ reason: z.string().trim().min(1, "Say why it was skipped").max(500) });

const toIso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * The dates of a repeating series: every `every` days / weeks / months / years from `start` through
 * `until`, leaving out the off-season months. Months and years keep the day of the month (a short
 * month uses its last day: Jan 31 → Feb 28 → Mar 31).
 */
export function visitDates(start: string, unit: RepeatUnit, every: number, until: string | null | undefined, offMonths: number[] = []): string[] {
  if (!until || until < start) return [start];
  const last = daysBetween(start, until) > VISIT_REPEAT_MAX_DAYS ? toIso(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8) + VISIT_REPEAT_MAX_DAYS) : until;
  const off = new Set(offMonths);
  const [y, m, d] = start.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < 2000; i++) {
    let date: string;
    if (unit === "day" || unit === "week") date = toIso(y, m - 1, d + i * every * (unit === "week" ? 7 : 1));
    else {
      const months = i * every * (unit === "year" ? 12 : 1);
      const yy = y + Math.floor((m - 1 + months) / 12), mm = (m - 1 + months) % 12;
      date = toIso(yy, mm, Math.min(d, lastDay(yy, mm)));
    }
    if (date > last) break;
    if (!off.has(Number(date.slice(5, 7)))) out.push(date);
  }
  return out;
}

/** What the work order bills: its line items added up. */
export const visitTotal = (lines: { quantity: number; unitPriceCents: number }[]) => lines.reduce((s, l) => s + lineAmount(l), 0);
/** The line items' budgeted hours added up (rounded to the hundredth). */
export const visitLineHours = (lines: { budgetedHours?: number | null }[]) => Math.round(lines.reduce((s, l) => s + (l.budgetedHours ?? 0), 0) * 100) / 100;

/** "Every week", "Every 6 weeks", "Every month (not Dec–Feb)". */
export function describeRepeat(unit: RepeatUnit, every: number, offMonths: number[] = []) {
  const base = every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
  if (!offMonths.length) return base;
  return `${base} (not ${[...offMonths].sort((a, b) => a - b).map((n) => MONTH_SHORT[n - 1]).join(", ")})`;
}

/** Photos and documents on a work order (like Homeworks' Photos / Documents). */
export const VISIT_FILE_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "application/pdf", "video/mp4", "video/quicktime",
] as const;
export const VISIT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const VISIT_FILES_MAX = 40;
export const isImageType = (t: string | null | undefined) => !!t && t.startsWith("image/");
export const isVideoType = (t: string | null | undefined) => !!t && t.startsWith("video/");

