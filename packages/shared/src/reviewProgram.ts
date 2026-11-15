import { z } from "zod";
import { EMPLOYMENT_TYPES } from "./schemas";
import { REVIEW_TYPES } from "./reviews";

/**
 * The review program: company rules for when employees are due a performance review, e.g.
 * "90-day review, 90 days after hire" and "Annual review, every 12 months on the hire
 * anniversary". Managers (and reviews admins) are reminded as each review comes due, and again
 * if it's overdue. A review of the rule's type dated close to (or after) the due date counts as
 * done.
 */
export const REVIEW_SCHEDULES = ["after_hire", "every"] as const;
/** For repeating reviews: counted from the hire date, from the last review, or from a fixed date. */
export const REVIEW_ANCHORS = ["hire", "last_review", "date"] as const;

export const reviewRuleSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1, "Name the review").max(80),
  /** Which kind of review completes it (the type picked when writing the review). */
  reviewType: z.enum(REVIEW_TYPES),
  schedule: z.enum(REVIEW_SCHEDULES),
  /** after_hire: this many days after the hire date (once). */
  days: z.number().int().min(1).max(3650).optional(),
  /** every: this many months apart. */
  months: z.number().int().min(1).max(60).optional(),
  anchor: z.enum(REVIEW_ANCHORS).optional(),
  /** anchor "date": the first date (YYYY-MM-DD); later ones follow every `months`. */
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Remind this many days before it's due. */
  remindDaysBefore: z.number().int().min(0).max(180),
  /** Only these employment types (empty: everyone). */
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(10),
  active: z.boolean(),
}).superRefine((r, ctx) => {
  if (r.schedule === "after_hire" && !r.days) ctx.addIssue({ code: "custom", path: ["days"], message: "How many days after hire?" });
  if (r.schedule === "every" && !r.months) ctx.addIssue({ code: "custom", path: ["months"], message: "How many months apart?" });
  if (r.schedule === "every" && r.anchor === "date" && !r.anchorDate) ctx.addIssue({ code: "custom", path: ["anchorDate"], message: "Pick the first date" });
});
export type ReviewRule = z.infer<typeof reviewRuleSchema>;

export const reviewProgramSchema = z.object({
  enabled: z.boolean(),
  rules: z.array(reviewRuleSchema).max(20),
  /** Remind again every this many days while a review is overdue (null: only once). */
  repeatOverdueDays: z.number().int().min(1).max(90).nullable(),
});
export type ReviewProgram = z.infer<typeof reviewProgramSchema> & {
  /** When the program was turned on: reviews due before this aren't chased. */
  startedOn?: string | null;
};

export const DEFAULT_REVIEW_PROGRAM: ReviewProgram = {
  enabled: false,
  repeatOverdueDays: 7,
  startedOn: null,
  rules: [
    { id: "ninety-day", name: "90-day review", reviewType: "probation", schedule: "after_hire", days: 90, remindDaysBefore: 14, employmentTypes: [], active: true },
    { id: "annual", name: "Annual review", reviewType: "annual", schedule: "every", months: 12, anchor: "hire", remindDaysBefore: 30, employmentTypes: [], active: true },
  ],
};

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** Same day of the month `n` months later (the last day of shorter months). */
export function addMonths(d: string, n: number) {
  const [y, m, day] = d.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export type ReviewDueStatus = "upcoming" | "due_soon" | "overdue";

export interface ReviewDue {
  ruleId: string;
  ruleName: string;
  reviewType: string;
  dueDate: string;
  status: ReviewDueStatus;
  /** Days until due (negative: overdue by that many). */
  daysLeft: number;
}

/** A review done this many days (or fewer) before the due date counts for it. */
const EARLY_WINDOW_DAYS = 60;

/**
 * The next review someone is due under a rule, or null if none (not their employment type, no
 * hire date, a one-time review already done or from before the program started, rule off).
 * `reviews` are their reviews (any status) with type and date.
 */
export function nextReviewDue(
  rule: ReviewRule,
  employee: { startDate: string | null; employmentType: string },
  reviews: { type: string; date: string }[],
  startedOn: string,
  today: string,
): ReviewDue | null {
  if (!rule.active) return null;
  if (rule.employmentTypes.length && !rule.employmentTypes.includes(employee.employmentType as never)) return null;
  const mine = reviews.filter((r) => r.type === rule.reviewType).map((r) => r.date).sort();
  const doneFor = (due: string) => mine.some((d) => d >= addDays(due, -Math.max(EARLY_WINDOW_DAYS, rule.remindDaysBefore)));
  const result = (due: string): ReviewDue => {
    const daysLeft = daysBetween(today, due);
    return { ruleId: rule.id, ruleName: rule.name, reviewType: rule.reviewType, dueDate: due, daysLeft, status: daysLeft < 0 ? "overdue" : daysLeft <= rule.remindDaysBefore ? "due_soon" : "upcoming" };
  };

  if (rule.schedule === "after_hire") {
    if (!employee.startDate) return null;
    const due = addDays(employee.startDate, rule.days!);
    if (due < startedOn || doneFor(due)) return null;
    return result(due);
  }

  const months = rule.months!;
  const anchor = rule.anchor ?? "hire";
  if (anchor === "last_review") {
    const last = mine.at(-1);
    let due = last ? addMonths(last, months) : employee.startDate ? addMonths(employee.startDate, months) : null;
    if (!due) return null;
    if (due < startedOn) due = startedOn;
    return result(due);
  }
  const first = anchor === "date" ? rule.anchorDate! : employee.startDate;
  if (!first) return null;
  // The first occurrence on or after the program started (and after hire), not yet done.
  for (let k = anchor === "hire" ? 1 : 0; k < 600; k++) {
    const due = addMonths(first, k * months);
    if (due < startedOn || (employee.startDate && due <= employee.startDate)) continue;
    if (doneFor(due)) continue;
    return result(due);
  }
  return null;
}

/** "Every 12 months on the hire anniversary", "90 days after hire" … for lists. */
export function describeReviewRule(r: ReviewRule) {
  if (r.schedule === "after_hire") return `${r.days} days after hire`;
  const every = r.months === 12 ? "Every year" : r.months === 1 ? "Every month" : `Every ${r.months} months`;
  if (r.anchor === "last_review") return `${every} after the last one`;
  if (r.anchor === "date") return `${every} from ${r.anchorDate}`;
  return `${every} from the hire date`;
}
