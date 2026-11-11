import { z } from "zod";

/**
 * Accounting (Bigcapital) connection. Bigcapital runs on its own server; Crewdesk sends it:
 *   - a journal entry for each approved pay period (estimated gross wages; debit wage expense,
 *     credit a payroll liability), and
 *   - an expense for each completed work order with costs (parts and labor, paid from a bank /
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
  /** Credited for payroll: e.g. "Payroll Liabilities" / "Wages Payable". Liability account. */
  payrollLiabilityAccountId: z.number().int().positive().nullable(),
  /** Work order parts. Expense account. */
  partsAccountId: z.number().int().positive().nullable(),
  /** Work order labor (shop or in-house). Expense account (parts account if not set). */
  laborAccountId: z.number().int().positive().nullable(),
  /** What work order costs are paid from: bank, cash or credit card. */
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

export type PostingKind = "payroll" | "work_order";

export interface JournalLine { accountId: number; debitCents?: number; creditCents?: number; note?: string }

/**
 * The payroll journal for a period: wages (and time off, if it has its own account) debited,
 * the liability credited for the total. Hourly staff only; salaried pay isn't estimated here.
 */
export function payrollJournalLines(
  lines: { payType: string; payRateCents: number; ptoHours: number; holidayHours: number; estimatedGrossCents: number | null }[],
  s: Pick<AccountingSettings, "wagesAccountId" | "timeOffAccountId" | "payrollLiabilityAccountId">,
): { lines: JournalLine[]; totalCents: number; salaried: number } {
  let wages = 0;
  let timeOff = 0;
  let salaried = 0;
  for (const l of lines) {
    if (l.payType !== "hourly" || l.estimatedGrossCents == null) { if (l.payType === "salary") salaried++; continue; }
    const off = s.timeOffAccountId ? Math.round((l.ptoHours + l.holidayHours) * l.payRateCents) : 0;
    timeOff += off;
    wages += l.estimatedGrossCents - off;
  }
  const total = wages + timeOff;
  if (!total || !s.wagesAccountId || !s.payrollLiabilityAccountId) return { lines: [], totalCents: total, salaried };
  const out: JournalLine[] = [];
  if (wages) out.push({ accountId: s.wagesAccountId, debitCents: wages, note: "Wages (regular, overtime, holiday premium)" });
  if (timeOff) out.push({ accountId: s.timeOffAccountId!, debitCents: timeOff, note: "Paid time off and holidays" });
  out.push({ accountId: s.payrollLiabilityAccountId, creditCents: total, note: "Gross wages payable" });
  return { lines: out, totalCents: total, salaried };
}
