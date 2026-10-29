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
      .filter((l) => l.providerEmployeeId && (l.totalHours > 0 || l.payType === "salary"))
      .map((l) => ({
        employee: l.providerEmployeeId,
        earnings:
          l.payType === "salary"
            ? [{ type: "salaried" }]
            : [
                { type: "hourly", hours: l.regularHours },
                ...(l.overtimeHours > 0 ? [{ type: "overtime", hours: l.overtimeHours }] : []),
              ],
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
