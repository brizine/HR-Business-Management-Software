import { z } from "zod";

/**
 * Extra pay: one-off amounts on top of hours, such as a bonus, commission or reimbursement. Each
 * lands in the pay period its date falls in. Bonuses, commissions and "other" are wages (in the
 * estimated gross); reimbursements aren't wages and are listed separately.
 */
export const EXTRA_PAY_KINDS = ["bonus", "commission", "reimbursement", "other"] as const;
export type ExtraPayKind = (typeof EXTRA_PAY_KINDS)[number];
export const EXTRA_PAY_LABELS: Record<ExtraPayKind, string> = {
  bonus: "Bonus",
  commission: "Commission",
  reimbursement: "Reimbursement",
  other: "Other pay",
};
/** Kinds that count as wages (taxable pay). */
export const WAGE_KINDS: readonly ExtraPayKind[] = ["bonus", "commission", "other"];

export const extraPaySchema = z.object({
  /** One person, or several at once (e.g. the same bonus for a whole crew). */
  employeeIds: z.array(z.string().uuid()).min(1, "Choose who it's for").max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date"),
  kind: z.enum(EXTRA_PAY_KINDS),
  amountCents: z.number().int().positive("Enter an amount").max(100_000_000),
  note: z.string().trim().max(300).optional(),
});

export interface ExtraPayLike { kind: string; amountCents: number }

/** Totals by kind, plus wages (bonus + commission + other) and reimbursements. */
export function extraPayTotals(items: ExtraPayLike[]) {
  const sum = (k: ExtraPayKind) => items.filter((i) => i.kind === k).reduce((t, i) => t + i.amountCents, 0);
  const bonusCents = sum("bonus");
  const commissionCents = sum("commission");
  const otherPayCents = sum("other");
  return { bonusCents, commissionCents, otherPayCents, reimbursementCents: sum("reimbursement"), extraWagesCents: bonusCents + commissionCents + otherPayCents };
}
