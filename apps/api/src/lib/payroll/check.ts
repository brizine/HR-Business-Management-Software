import type { PayrollLine, PayrollPeriod, PayrollProvider, PayrollSubmitResult } from "./index";

/**
 * Check (checkhq.com) embedded payroll. Creates a draft payroll with hourly
 * earnings for the period; an admin reviews and approves it in Check. Each
 * company and employee must first be onboarded in Check and their Check IDs
 * stored on `companies.payroll_provider_company_id` and
 * `employees.payroll_provider_employee_id`.
 *
 * Verify the request shape against Check's current API docs before going live.
 */
const amount = (cents: number) => (cents / 100).toFixed(2);

function extraEarnings(l: PayrollLine) {
  const flat = [
    ...(l.bonusCents ? [{ type: "bonus", amount: amount(l.bonusCents) }] : []),
    ...(l.commissionCents ? [{ type: "commission", amount: amount(l.commissionCents) }] : []),
    ...(l.otherPayCents ? [{ type: "other", amount: amount(l.otherPayCents) }] : []),
  ];
  return {
    ...(flat.length ? { extra_earnings: flat } : {}),
    ...(l.reimbursementCents ? { reimbursements: [{ amount: amount(l.reimbursementCents), description: "Reimbursement" }] } : {}),
  };
}

export class CheckPayrollProvider implements PayrollProvider {
  name = "check";

  async submit(companyProviderId: string, period: PayrollPeriod, lines: PayrollLine[]): Promise<PayrollSubmitResult> {
    const apiKey = process.env.CHECK_API_KEY;
    if (!apiKey) throw new Error("CHECK_API_KEY is not configured");
    const baseUrl = process.env.CHECK_API_URL ?? "https://sandbox.checkhq.com";

    const missing = lines.filter((l) => l.totalHours > 0 && !l.providerEmployeeId);
    if (missing.length) {
      throw new Error(`Not linked to Check: ${missing.map((l) => `${l.firstName} ${l.lastName}`).join(", ")}`);
    }

    const items = lines
      .filter((l) => l.providerEmployeeId && (l.totalHours > 0 || l.ptoHours > 0 || l.holidayHours > 0 || l.payType === "salary" || (l.extraPay ?? []).length > 0))
      .map((l) => ({
        employee: l.providerEmployeeId,
        earnings:
          l.payType === "salary"
            ? [{ type: "salaried" }]
            : [
                { type: "hourly", hours: l.regularHours },
                ...(l.overtimeHours > 0 ? [{ type: "overtime", hours: l.overtimeHours }] : []),
                // Earning type name per Check's docs; confirm before going live.
                ...(l.ptoHours > 0 ? [{ type: "pto", hours: l.ptoHours }] : []),
                ...(l.holidayHours > 0 ? [{ type: "holiday", hours: l.holidayHours }] : []),
              ],
        // Bonuses, commissions and other pay as flat earnings; reimbursements as non-taxable
        // reimbursements. Type names per Check's docs; confirm before going live.
        ...extraEarnings(l),
      }));

    const res = await fetch(`${baseUrl}/payrolls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        company: companyProviderId,
        period_start: period.periodStart,
        period_end: period.periodEnd,
        items,
      }),
    });
    if (!res.ok) throw new Error(`Check API error ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { id: string };
    return { status: "draft", providerReference: body.id };
  }
}
