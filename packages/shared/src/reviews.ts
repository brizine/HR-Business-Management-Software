import { z } from "zod";

/**
 * Employee reviews and disciplinary actions ("Reviews & discipline").
 *
 * Both start as drafts only managers see. Sharing one notifies the employee, who can read it and
 * acknowledge it (optionally with their own comment). Acknowledging means they've seen it, not
 * that they agree.
 */
export const RECORD_KINDS = ["review", "discipline"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const REVIEW_TYPES = ["annual", "probation", "mid_year", "quarterly", "other"] as const;
export const REVIEW_TYPE_LABELS: Record<(typeof REVIEW_TYPES)[number], string> = {
  annual: "Annual review",
  probation: "End of probation (90-day)",
  mid_year: "Mid-year review",
  quarterly: "Quarterly check-in",
  other: "Other review",
};

/** Disciplinary steps, least to most serious. */
export const DISCIPLINE_TYPES = ["coaching", "verbal_warning", "written_warning", "final_warning", "suspension", "termination"] as const;
export const DISCIPLINE_TYPE_LABELS: Record<(typeof DISCIPLINE_TYPES)[number], string> = {
  coaching: "Coaching / documented conversation",
  verbal_warning: "Verbal warning",
  written_warning: "Written warning",
  final_warning: "Final written warning",
  suspension: "Suspension",
  termination: "Termination",
};

export const DISCIPLINE_REASONS = ["attendance", "tardiness", "conduct", "performance", "safety", "policy", "equipment", "other"] as const;
export const DISCIPLINE_REASON_LABELS: Record<(typeof DISCIPLINE_REASONS)[number], string> = {
  attendance: "Attendance / no-call no-show",
  tardiness: "Tardiness",
  conduct: "Conduct / behavior",
  performance: "Job performance",
  safety: "Safety violation",
  policy: "Company policy violation",
  equipment: "Vehicle or equipment misuse",
  other: "Other",
};

export const RATINGS = [1, 2, 3, 4, 5] as const;
export const RATING_LABELS: Record<number, string> = {
  1: "Unsatisfactory",
  2: "Needs improvement",
  3: "Meets expectations",
  4: "Exceeds expectations",
  5: "Outstanding",
};

export const RECORD_STATUSES = ["draft", "shared", "acknowledged"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export function recordTypeLabel(kind: RecordKind, type: string) {
  return (kind === "review" ? (REVIEW_TYPE_LABELS as Record<string, string>)[type] : (DISCIPLINE_TYPE_LABELS as Record<string, string>)[type]) ?? type;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const optionalDate = isoDate.nullable().optional().or(z.literal("")).transform((v) => (v ? v : null));

export const reviewInputSchema = z
  .object({
    kind: z.literal("review"),
    employeeId: z.string().uuid(),
    type: z.enum(REVIEW_TYPES),
    date: isoDate,
    periodStart: optionalDate,
    periodEnd: optionalDate,
    rating: z.number().int().min(1).max(5).nullable().optional().transform((v) => v ?? null),
    /** Overall summary. */
    summary: z.string().trim().min(1, "Write a summary").max(10000),
    strengths: text(10000),
    improvements: text(10000),
    goals: text(10000),
  })
  .refine((r) => !r.periodStart || !r.periodEnd || r.periodStart <= r.periodEnd, { message: "The review period ends before it starts", path: ["periodEnd"] });

export const disciplineInputSchema = z.object({
  kind: z.literal("discipline"),
  employeeId: z.string().uuid(),
  type: z.enum(DISCIPLINE_TYPES),
  date: isoDate,
  reason: z.enum(DISCIPLINE_REASONS),
  /** When it happened (may differ from the date the action is written up). */
  incidentDate: optionalDate,
  /** What happened. */
  summary: z.string().trim().min(1, "Describe what happened").max(10000),
  /** What's expected from now on, and what happens if it continues. */
  expectations: text(10000),
  followUpDate: optionalDate,
});

export const recordInputSchema = z.union([reviewInputSchema, disciplineInputSchema]);
export type RecordInput = z.infer<typeof recordInputSchema>;

export const acknowledgeSchema = z.object({ comment: z.string().trim().max(5000).optional() });
