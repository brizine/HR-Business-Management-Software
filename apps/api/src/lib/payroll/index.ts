import { and, eq, gte, lt, lte, isNotNull } from "drizzle-orm";
import { summarizeHours } from "@crewdesk/shared";
import type { DB } from "../../db";
import { companies, employees, ptoRequests, timeEntries } from "../../db/schema";
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
  /** Worked hours (regular + overtime). */
  totalHours: number;
  /** Approved time off in the period (paid at the regular rate). */
  ptoHours: number;
  /** Completed time entries in the period that a manager hasn't approved yet. */
  unapprovedEntries: number;
  /** Gross for hourly staff (regular + 1.5x overtime + time off); salaried staff are left to the payroll system. */
  estimatedGrossCents: number | null;
}

export interface PayrollPeriod {
  periodStart: string;
  periodEnd: string;
  /** Count only time entries a manager has approved. */
  approvedOnly?: boolean;
}

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;

/**
 * Hours of a time-off request that fall inside the period. A request that
 * spans two pay periods is split by calendar days.
 */
export function ptoHoursInPeriod(req: { startDate: string; endDate: string; hours: number }, period: PayrollPeriod) {
  const from = req.startDate > period.periodStart ? req.startDate : period.periodStart;
  const to = req.endDate < period.periodEnd ? req.endDate : period.periodEnd;
  if (from > to) return 0;
  return (req.hours * days(from, to)) / days(req.startDate, req.endDate);
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

  const timeOff = await db
    .select()
    .from(ptoRequests)
    .where(
      and(
        eq(ptoRequests.companyId, companyId),
        eq(ptoRequests.status, "approved"),
        lte(ptoRequests.startDate, period.periodEnd),
        gte(ptoRequests.endDate, period.periodStart),
      ),
    );
  const round = (n: number) => Math.round(n * 100) / 100;

  return staff
    .filter((e) => e.status !== "terminated" || entries.some((t) => t.employeeId === e.id))
    .map((e) => {
      const all = entries.filter((t) => t.employeeId === e.id);
      const counted = period.approvedOnly ? all.filter((t) => t.approvedAt) : all;
      const hours = summarizeHours(counted, company?.weeklyOvertimeThreshold ?? 40);
      const ptoHours = round(timeOff.filter((r) => r.employeeId === e.id).reduce((sum, r) => sum + ptoHoursInPeriod(r, period), 0));
      const gross =
        e.payType === "hourly"
          ? Math.round((hours.regularHours + ptoHours) * e.payRateCents + hours.overtimeHours * e.payRateCents * 1.5)
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
        ptoHours,
        unapprovedEntries: all.filter((t) => !t.approvedAt).length,
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
    "Total Hours Worked",
    "Time Off Hours",
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
    l.ptoHours.toFixed(2),
    l.estimatedGrossCents == null ? "" : (l.estimatedGrossCents / 100).toFixed(2),
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
