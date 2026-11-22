import { z } from "zod";

/**
 * Accounting (Bigcapital) connection. Bigcapital runs on its own server; Crewdesk sends it:
 *   - a journal entry for each approved pay period (estimated gross wages; debit wage expense,
 *     credit a payroll liability), and
 *   - an expense for each completed repair order with costs (parts and labor, paid from a bank /
 *     credit card account).
 * Account ids are Bigcapital's own. The API key is stored encrypted and never sent back.
 */
export const accountingSettingsSchema = z.object({
  enabled: z.boolean(),
  /** e.g. https://books.example.com (Crewdesk adds /api). */
  baseUrl: z.string().trim().url("Enter the full address, e.g. https://books.example.com").refine((u) => /^https?:\/\//.test(u), "Use an http(s) address").transform((u) => u.replace(/\/+$/, "").replace(/\/api$/, "")),
  /** Only sent when it changes; blank keeps the saved key. */
  apiKey: z.string().trim().max(500).optional(),
  /** Wages (regular, overtime, holiday-work premium). Expense account. */
  wagesAccountId: z.number().int().positive().nullable(),
  /** Paid time off and paid holidays (optional; wages account if not set). Expense account. */
  timeOffAccountId: z.number().int().positive().nullable(),
  /** Reimbursements paid through payroll (optional; left out of the journal if not set). Expense account. */
  reimbursementAccountId: z.number().int().positive().nullable().optional(),
  /** Credited for payroll: e.g. "Payroll Liabilities" / "Wages Payable". Liability account. */
  payrollLiabilityAccountId: z.number().int().positive().nullable(),
  /** Repair order parts. Expense account. */
  partsAccountId: z.number().int().positive().nullable(),
  /** Repair order labor (shop or in-house). Expense account (parts account if not set). */
  laborAccountId: z.number().int().positive().nullable(),
  /** What repair order costs are paid from: bank, cash or credit card. */
  workOrderPaymentAccountId: z.number().int().positive().nullable(),
  autoPostPayroll: z.boolean(),
  autoPostWorkOrders: z.boolean(),
});
export type AccountingSettings = Omit<z.infer<typeof accountingSettingsSchema>, "apiKey">;

export const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = {
  enabled: false,
  baseUrl: "",
  wagesAccountId: null,
  timeOffAccountId: null,
  reimbursementAccountId: null,
  payrollLiabilityAccountId: null,
  partsAccountId: null,
  laborAccountId: null,
  workOrderPaymentAccountId: null,
  autoPostPayroll: false,
  autoPostWorkOrders: false,
};

/** Bigcapital account types (by the role they play here). */
export const EXPENSE_ACCOUNT_TYPES = ["expense", "other-expense", "cost-of-goods-sold"];
export const LIABILITY_ACCOUNT_TYPES = ["other-current-liability", "accounts-payable", "credit-card", "tax-payable", "long-term-liability", "non-current-liability"];
/** Bigcapital only accepts these as what an expense is paid from. */
export const PAYMENT_ACCOUNT_TYPES = ["cash", "bank", "credit-card", "other-current-asset", "non-current-asset", "fixed-asset"];

export type PostingKind = "payroll" | "work_order" | "invoice" | "payment" | "customer";

export interface JournalLine { accountId: number; debitCents?: number; creditCents?: number; note?: string }

/**
 * The payroll journal for a period: wages (and time off, if it has its own account) debited,
 * the liability credited for the total. Hourly pay is estimated from hours; salaried pay isn't,
 * but everyone's bonuses, commissions and other extra pay are included with wages, and
 * reimbursements are debited to their own account when one is chosen.
 */
export function payrollJournalLines(
  lines: {
    payType: string; payRateCents: number; ptoHours: number; holidayHours: number; estimatedGrossCents: number | null;
    bonusCents?: number; commissionCents?: number; otherPayCents?: number; reimbursementCents?: number;
  }[],
  s: Pick<AccountingSettings, "wagesAccountId" | "timeOffAccountId" | "payrollLiabilityAccountId"> & { reimbursementAccountId?: number | null },
): { lines: JournalLine[]; totalCents: number; salaried: number; reimbursementsLeftOut: number } {
  let wages = 0;
  let timeOff = 0;
  let reimbursements = 0;
  let salaried = 0;
  let reimbursementsLeftOut = 0;
  for (const l of lines) {
    const extraWages = (l.bonusCents ?? 0) + (l.commissionCents ?? 0) + (l.otherPayCents ?? 0);
    if (l.reimbursementCents) {
      if (s.reimbursementAccountId) reimbursements += l.reimbursementCents;
      else reimbursementsLeftOut += l.reimbursementCents;
    }
    if (l.payType !== "hourly" || l.estimatedGrossCents == null) {
      if (l.payType === "salary") salaried++;
      // Salaried pay isn't estimated, but their extra pay is a known amount.
      wages += extraWages;
      continue;
    }
    const off = s.timeOffAccountId ? Math.round((l.ptoHours + l.holidayHours) * l.payRateCents) : 0;
    timeOff += off;
    // The hourly estimate already includes extra wages.
    wages += l.estimatedGrossCents - off;
  }
  const total = wages + timeOff + reimbursements;
  if (!total || !s.wagesAccountId || !s.payrollLiabilityAccountId) return { lines: [], totalCents: total, salaried, reimbursementsLeftOut };
  const out: JournalLine[] = [];
  if (wages) out.push({ accountId: s.wagesAccountId, debitCents: wages, note: "Wages (regular, overtime, holiday premium, bonuses, commissions)" });
  if (timeOff) out.push({ accountId: s.timeOffAccountId!, debitCents: timeOff, note: "Paid time off and holidays" });
  if (reimbursements) out.push({ accountId: s.reimbursementAccountId!, debitCents: reimbursements, note: "Reimbursements" });
  out.push({ accountId: s.payrollLiabilityAccountId, creditCents: total, note: "Gross wages and reimbursements payable" });
  return { lines: out, totalCents: total, salaried, reimbursementsLeftOut };
}
