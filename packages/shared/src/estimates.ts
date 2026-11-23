import { z } from "zod";
import { formatMoney } from "./billing";
import { taxFor, taxRateSchema } from "./tax";

/**
 * Estimates, like Homeworks': a numbered quote with lines (quantity × rate × visits, tax), optional
 * lines the customer can tick, a discount, terms and notes. Sent by email with a link where the
 * customer accepts (typing their name), declines or asks for changes; then it becomes a work order
 * or an invoice.
 */

export const ESTIMATE_STATUSES = ["draft", "sent", "accepted", "declined", "changes"] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];
export const ESTIMATE_STATUS_LABELS: Record<EstimateStatus, string> = {
  draft: "Draft", sent: "Pending", accepted: "Accepted", declined: "Declined", changes: "Changes requested",
};
/** Still waiting on the customer. */
export const OPEN_ESTIMATE_STATUSES: EstimateStatus[] = ["sent", "changes"];

export const estimateNumber = (n: number | null | undefined) => (n ? `EST-${n}` : "Estimate");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();

export const estimateLineSchema = z.object({
  /** Kept when the estimate is saved again, so a customer's choices stay with the right line. */
  id: z.string().uuid().optional(),
  serviceTypeId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  /** The service address this line is for (blank: the estimate's). */
  propertyId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  description: z.string().trim().min(1, "Describe the line").max(500),
  quantity: z.coerce.number().positive("The quantity must be more than 0").max(100_000).multipleOf(0.01),
  unitPriceCents: z.coerce.number().int().min(0, "Prices can't be negative").max(100_000_000),
  /** How many visits it's for (e.g. 6 fertilizer rounds); the line total is quantity × price × visits. */
  visits: z.coerce.number().int().min(1).max(365).default(1),
  taxRate: taxRateSchema.default(0),
  incomeAccountCode: z.string().trim().regex(/^\d{3,6}$/).default("4000"),
  /** Internal: what it costs us per unit, and the hours budgeted per visit (never shown to the customer). */
  costCents: z.preprocess(blankToNull, z.coerce.number().int().min(0).max(100_000_000).nullable()).optional(),
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0).max(999).nullable()).optional(),
  /** The customer chooses whether to include it; `selected` is whether it starts ticked. */
  optional: z.boolean().default(false),
  selected: z.boolean().default(true),
  /** Marked "Recommended" for the customer. */
  recommended: z.boolean().default(false),
});
export type EstimateLineInput = z.infer<typeof estimateLineSchema>;

export const estimateSchema = z.object({
  title: optText(300),
  customerId: z.string({ required_error: "Pick the customer" }).uuid({ message: "Pick the customer" }),
  propertyId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  issueDate: isoDate.optional(),
  /** After this the customer can't accept it online (blank: no end). */
  validUntil: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  /** When the customer asked for it. */
  requestedAt: z.preprocess(blankToNull, z.string().datetime({ offset: true }).nullable()).optional(),
  poNumber: optText(60),
  discountPercent: z.coerce.number().min(0).max(100).multipleOf(0.01).default(0),
  lines: z.array(estimateLineSchema).min(1, "Add at least one line").max(60),
  terms: optText(5000),
  /** Shown to the customer. */
  customerNotes: optText(5000),
  /** Only the office sees these. */
  internalNotes: optText(5000),
}).superRefine((v, ctx) => {
  if (v.issueDate && v.validUntil && v.validUntil < v.issueDate) ctx.addIssue({ code: "custom", path: ["validUntil"], message: "It can't end before its date" });
});
export type EstimateInput = z.infer<typeof estimateSchema>;

export const sendEstimateSchema = z.object({
  emailTo: z.string().trim().toLowerCase().email("Enter a valid email").max(254).optional().or(z.literal("").transform(() => undefined)),
  message: optText(2000),
});

/** The customer's answer (online), or the office recording one taken by phone. */
export const estimateResponseSchema = z.object({
  action: z.enum(["accept", "decline", "changes"]),
  /** The optional lines they ticked (lines that aren't optional are always in). */
  selectedLineIds: z.array(z.string().uuid()).max(60).default([]),
  /** Typed as their signature when accepting online. */
  name: optText(120),
  comment: optText(2000),
}).superRefine((v, ctx) => {
  if (v.action === "changes" && !v.comment) ctx.addIssue({ code: "custom", path: ["comment"], message: "Say what you'd like changed" });
});
export type EstimateResponse = z.infer<typeof estimateResponseSchema>;

type TotalLine = { id?: string; quantity: number; unitPriceCents: number; visits?: number | null; taxRate?: number | null; costCents?: number | null; budgetedHours?: number | null; optional?: boolean; selected?: boolean };

/** quantity × price × visits, in cents. */
export const estimateLineAmount = (l: TotalLine) => Math.round(l.quantity * l.unitPriceCents * (l.visits ?? 1));
/** Whether a line counts: not optional, or optional and ticked (by the customer's choice when given). */
export const lineIncluded = (l: TotalLine, chosen?: Set<string> | null) => !l.optional || (chosen && l.id ? chosen.has(l.id) : !!l.selected);

/**
 * What the estimate comes to with the lines that count: subtotal, discount, tax and total, plus
 * (for the office) the cost, profit, margin and budgeted hours.
 */
export function estimateTotals(lines: TotalLine[], discountPercent: number, chosen?: Set<string> | null) {
  const inc = lines.filter((l) => lineIncluded(l, chosen));
  const subtotalCents = inc.reduce((s, l) => s + estimateLineAmount(l), 0);
  const discountCents = Math.min(subtotalCents, Math.round((subtotalCents * (discountPercent || 0)) / 100));
  const taxCents = taxFor(inc.map((l) => ({ quantity: l.quantity * (l.visits ?? 1), unitPriceCents: l.unitPriceCents, taxRate: l.taxRate ?? 0 })), discountCents);
  const totalCents = subtotalCents - discountCents + taxCents;
  const costCents = inc.reduce((s, l) => s + Math.round((l.costCents ?? 0) * l.quantity * (l.visits ?? 1)), 0);
  const profitCents = subtotalCents - discountCents - costCents;
  const hours = Math.round(inc.reduce((s, l) => s + (l.budgetedHours ?? 0) * (l.visits ?? 1), 0) * 100) / 100;
  const visitsRevenueCents = inc.reduce((s, l) => s + Math.round(l.quantity * l.unitPriceCents), 0);
  return {
    subtotalCents, discountCents, taxCents, totalCents, costCents, profitCents, hours, visitsRevenueCents,
    marginPercent: subtotalCents - discountCents > 0 ? Math.round((profitCents / (subtotalCents - discountCents)) * 1000) / 10 : 0,
    optionalCount: lines.filter((l) => l.optional).length,
  };
}

/** "6 visits × $45.00" for a line with more than one visit. */
export const visitsText = (l: { visits?: number | null; quantity: number; unitPriceCents: number }) =>
  (l.visits ?? 1) > 1 ? `${l.visits} visits × ${formatMoney(Math.round(l.quantity * l.unitPriceCents))}` : "";

/** For the Customers list filter "Estimates". */
export const ESTIMATE_FILTER_OPTIONS = [
  ["sent", "Pending (waiting for an answer)"], ["accepted", "Accepted"], ["declined", "Declined"], ["changes", "Changes requested"], ["none", "No estimates"],
] as const;
