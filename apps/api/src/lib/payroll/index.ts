import { and, eq, gte, lt, isNotNull } from "drizzle-orm";
import { summarizeHours } from "@crewdesk/shared";
import type { DB } from "../../db";
import { companies, employees, timeEntries } from "../../db/schema";
import { CheckPayrollProvider } from "./check";

export interface PayrollLine {
  employeeId: string;
  providerEmployeeId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  payType: string;
  payRateCents: number;
  regularHours: number;
  overtimeHours: number;
  totalHours: number;
  /** Gross for hourly staff (regular + 1.5x overtime); salaried staff are left to the provider. */
  estimatedGrossCents: number | null;
}

export interface PayrollPeriod {
  periodStart: string;
  periodEnd: string;
}

export interface PayrollSubmitResult {
  status: "submitted" | "draft";
  providerReference: string;
}

/** A payroll service that can receive hours and run payroll (Check, Gusto Embedded, ...). */
export interface PayrollProvider {
  name: string;
  submit(companyProviderId: string, period: PayrollPeriod, lines: PayrollLine[]): Promise<PayrollSubmitResult>;
}

export function getProvider(name: string): PayrollProvider | null {
  if (name === "check") return new CheckPayrollProvider();
  return null;
}

/** Totals completed time entries per employee for [periodStart, periodEnd]. */
export async function buildPayrollLines(db: DB, companyId: string, period: PayrollPeriod): Promise<PayrollLine[]> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const start = new Date(period.periodStart + "T00:00:00Z");
  const end = new Date(Date.parse(period.periodEnd + "T00:00:00Z") + 86_400_000);

  const staff = await db.select().from(employees).where(eq(employees.companyId, companyId));
  const entries = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.companyId, companyId),
        gte(timeEntries.clockIn, start),
        lt(timeEntries.clockIn, end),
        isNotNull(timeEntries.clockOut),
      ),
    );

  return staff
    .filter((e) => e.status !== "terminated" || entries.some((t) => t.employeeId === e.id))
    .map((e) => {
      const mine = entries.filter((t) => t.employeeId === e.id);
      const hours = summarizeHours(mine, company?.weeklyOvertimeThreshold ?? 40);
      const gross =
        e.payType === "hourly"
          ? Math.round(hours.regularHours * e.payRateCents + hours.overtimeHours * e.payRateCents * 1.5)
          : null;
      return {
        employeeId: e.id,
        providerEmployeeId: e.payrollProviderEmployeeId,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.email,
        payType: e.payType,
        payRateCents: e.payRateCents,
        ...hours,
        estimatedGrossCents: gross,
      };
    });
}

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function payrollCsv(lines: PayrollLine[]): string {
  const header = [
    "Employee ID",
    "First Name",
    "Last Name",
    "Email",
    "Pay Type",
    "Pay Rate",
    "Regular Hours",
    "Overtime Hours",
    "Total Hours",
    "Estimated Gross",
  ];
  const rows = lines.map((l) => [
    l.employeeId,
    l.firstName,
    l.lastName,
    l.email,
    l.payType,
    (l.payRateCents / 100).toFixed(2),
    l.regularHours.toFixed(2),
    l.overtimeHours.toFixed(2),
    l.totalHours.toFixed(2),
    l.estimatedGrossCents == null ? "" : (l.estimatedGrossCents / 100).toFixed(2),
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
