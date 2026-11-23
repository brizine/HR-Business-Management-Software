import { z } from "zod";
import { formatMoney } from "./money";

/**
 * Deposits on estimates (like Homeworks' "Require deposit prior to accepting an estimate"): the
 * company says who needs one (no one, new customers, everyone), from what estimate total, and how
 * much ($ or % of what they accept). An estimate can use that, need none, or have its own amount.
 * The customer pays it online as they accept; it goes on their account as a prepayment.
 */

export const DEPOSIT_FOR = ["none", "new", "all"] as const;
export type DepositFor = (typeof DEPOSIT_FOR)[number];
export const DEPOSIT_FOR_LABELS: Record<DepositFor, string> = {
  none: "No one",
  new: "New customers (no invoices yet)",
  all: "Every customer",
};

const kindSchema = z.enum(["amount", "percent"]);

export const estimateDepositSettingsSchema = z.object({
  requireFor: z.enum(DEPOSIT_FOR).default("none"),
  /** Only estimates of at least this total (cents; 0 = any). */
  minTotalCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
  kind: kindSchema.default("percent"),
  /** Cents for an amount, or a percent of the accepted total. */
  value: z.coerce.number().min(0).max(100_000_000).default(0),
}).superRefine((v, ctx) => {
  if (v.requireFor === "none") return;
  if (!(v.value > 0)) ctx.addIssue({ code: "custom", path: ["value"], message: "Enter the deposit" });
  if (v.kind === "percent" && v.value > 100) ctx.addIssue({ code: "custom", path: ["value"], message: "A percent can't be over 100" });
});
export type EstimateDepositSettings = z.infer<typeof estimateDepositSettingsSchema>;
export const DEFAULT_ESTIMATE_DEPOSIT: EstimateDepositSettings = { requireFor: "none", minTotalCents: 0, kind: "percent", value: 0 };

export const ESTIMATE_DEPOSIT_MODES = ["default", "none", "custom"] as const;
export type EstimateDepositMode = (typeof ESTIMATE_DEPOSIT_MODES)[number];

/** An estimate's own choice (on its form). */
export const estimateDepositFieldsSchema = z.object({
  depositMode: z.enum(ESTIMATE_DEPOSIT_MODES).default("default"),
  depositKind: kindSchema.nullable().optional(),
  depositValue: z.coerce.number().min(0).max(100_000_000).nullable().optional(),
});

/** Checks an estimate's own deposit (call from a superRefine). */
export function checkEstimateDeposit(v: { depositMode?: EstimateDepositMode; depositKind?: "amount" | "percent" | null; depositValue?: number | null }, add: (path: string, message: string) => void) {
  if (v.depositMode !== "custom") return;
  if (!v.depositKind) add("depositKind", "Choose $ or %");
  if (!(Number(v.depositValue) > 0)) add("depositValue", "Enter the deposit");
  if (v.depositKind === "percent" && Number(v.depositValue) > 100) add("depositValue", "A percent can't be over 100");
}

export type DepositRule = { kind: "amount" | "percent"; value: number; minTotalCents: number };

/** The deposit rule for an estimate, or null when it needs none. `isNew`: the customer has no invoices yet. */
export function depositRuleFor(
  company: EstimateDepositSettings | undefined,
  estimate: { depositMode?: string | null; depositKind?: string | null; depositValue?: number | null },
  isNew: boolean,
): DepositRule | null {
  const mode = estimate.depositMode ?? "default";
  if (mode === "none") return null;
  if (mode === "custom") {
    if (!estimate.depositKind || !(Number(estimate.depositValue) > 0)) return null;
    return { kind: estimate.depositKind as DepositRule["kind"], value: Number(estimate.depositValue), minTotalCents: 0 };
  }
  const c = company ?? DEFAULT_ESTIMATE_DEPOSIT;
  if (c.requireFor === "none" || (c.requireFor === "new" && !isNew) || !(c.value > 0)) return null;
  return { kind: c.kind, value: c.value, minTotalCents: c.minTotalCents };
}

/** What they pay as they accept, for the total they accept (0 when it's under the threshold). */
export function depositCents(rule: DepositRule | null, totalCents: number): number {
  if (!rule || totalCents <= 0 || totalCents < rule.minTotalCents) return 0;
  const cents = rule.kind === "amount" ? Math.round(rule.value) : Math.round((totalCents * rule.value) / 100);
  return Math.max(0, Math.min(totalCents, cents));
}

/** "$100.00" or "25%" (plus "on estimates of $500.00 or more"). */
export function describeDepositRule(rule: Pick<DepositRule, "kind" | "value"> & { minTotalCents?: number }): string {
  const what = rule.kind === "amount" ? formatMoney(rule.value) : `${Number(rule.value.toFixed(2))}% of the accepted total`;
  return rule.minTotalCents ? `${what}, on estimates of ${formatMoney(rule.minTotalCents)} or more` : what;
}
