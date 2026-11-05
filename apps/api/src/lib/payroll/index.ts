import { and, eq, gte, lt, lte, isNotNull } from "drizzle-orm";
import { DEFAULT_HOLIDAY_RULES, WORK_AROUND_WINDOW_DAYS, checkWorkAround, entryHours, holidayHoursFor, holidaysBetween, isInactive, summarizeHours, type HolidayObserve } from "@crewdesk/shared";
import type { DB } from "../../db";
import { companies, employees, holidays, ptoRequests, shifts, timeEntries } from "../../db/schema";
import { localParts } from "../tz";
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
  /** Paid holiday hours in the period (paid at the regular rate), for eligible people. */
  holidayHours: number;
  /** Hours worked on a paid holiday (already in regular/overtime; the holiday premium is paid on top). */
  holidayWorkedHours: number;
  /** Why a holiday wasn't paid, or is paid provisionally (the "work the day before and after" rule). */
  holidayNotes: string[];
  /** Completed time entries in the period that a manager hasn't approved yet. */
  unapprovedEntries: number;
  /** Gross for hourly staff (regular + 1.5x overtime + time off + holidays + holiday-work premium); salaried staff are left to the payroll system. */
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

  // Paid holidays observed in the period, and the company's rules for who gets them.
  const holidayRows = await db.select().from(holidays).where(eq(holidays.companyId, companyId));
  const inPeriod = holidaysBetween(holidayRows.map((h) => ({ ...h, observe: h.observe as HolidayObserve })), period.periodStart, period.periodEnd);
  const rules = { ...DEFAULT_HOLIDAY_RULES, ...(company?.holidayRules ?? {}) };
  const holidayDays = new Set(inPeriod.map((o) => o.observed));
  const tz = company?.timezone ?? "America/Chicago";

  // "Work the scheduled day before and after": published shifts, punches and approved time off
  // around each holiday in the period.
  const shiftDays = new Map<string, Set<string>>();
  const workedDays = new Map<string, Set<string>>();
  let aroundTimeOff: { employeeId: string; startDate: string; endDate: string }[] = [];
  const today = localParts(new Date(), tz).date;
  if (rules.requireWorkAround && inPeriod.length) {
    const lo = new Date(start.getTime() - (WORK_AROUND_WINDOW_DAYS + 1) * DAY);
    const hi = new Date(end.getTime() + (WORK_AROUND_WINDOW_DAYS + 1) * DAY);
    const add = (m: Map<string, Set<string>>, id: string, day: string) => (m.get(id) ?? m.set(id, new Set()).get(id)!).add(day);
    const nearShifts = await db.select({ employeeId: shifts.employeeId, startsAt: shifts.startsAt }).from(shifts)
      .where(and(eq(shifts.companyId, companyId), eq(shifts.status, "published"), isNotNull(shifts.employeeId), gte(shifts.startsAt, lo), lt(shifts.startsAt, hi)));
    for (const sh of nearShifts) add(shiftDays, sh.employeeId!, localParts(sh.startsAt, tz).date);
    const nearEntries = await db.select({ employeeId: timeEntries.employeeId, clockIn: timeEntries.clockIn }).from(timeEntries)
      .where(and(eq(timeEntries.companyId, companyId), gte(timeEntries.clockIn, lo), lt(timeEntries.clockIn, hi)));
    for (const t of nearEntries) add(workedDays, t.employeeId, localParts(t.clockIn, tz).date);
    const loDay = lo.toISOString().slice(0, 10);
    const hiDay = hi.toISOString().slice(0, 10);
    aroundTimeOff = await db.select({ employeeId: ptoRequests.employeeId, startDate: ptoRequests.startDate, endDate: ptoRequests.endDate }).from(ptoRequests)
      .where(and(eq(ptoRequests.companyId, companyId), eq(ptoRequests.status, "approved"), lte(ptoRequests.startDate, hiDay), gte(ptoRequests.endDate, loDay)));
  }
  const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

  return staff
    .filter((e) => !isInactive(e.status) || entries.some((t) => t.employeeId === e.id))
    .map((e) => {
      const all = entries.filter((t) => t.employeeId === e.id);
      const counted = period.approvedOnly ? all.filter((t) => t.approvedAt) : all;
      const hours = summarizeHours(counted, company?.weeklyOvertimeThreshold ?? 40);
      const ptoHours = round(timeOff.filter((r) => r.employeeId === e.id).reduce((sum, r) => sum + ptoHoursInPeriod(r, period), 0));
      const holidayNotes: string[] = [];
      const holidayHours = round(inPeriod.reduce((sum, o) => {
        const hrs = holidayHoursFor({ employmentType: e.employmentType, hireDate: e.startDate }, rules, o.holiday.hours, o.observed);
        if (!hrs || !rules.requireWorkAround) return sum + hrs;
        const check = checkWorkAround({
          observed: o.observed,
          scheduledDays: shiftDays.get(e.id) ?? [],
          workedDays: workedDays.get(e.id) ?? new Set(),
          timeOff: aroundTimeOff.filter((t) => t.employeeId === e.id),
          today,
        });
        if (!check.met) {
          const days = check.missed.map((m) => `the scheduled day ${m} (${fmtDay(m === "before" ? check.before! : check.after!)})`).join(" and ");
          holidayNotes.push(`No holiday pay for ${o.holiday.name}: didn't work ${days}`);
          return sum;
        }
        if (check.afterPending) holidayNotes.push(`${o.holiday.name}: paid as long as they work the scheduled day after (${fmtDay(check.after!)})`);
        return sum + hrs;
      }, 0));
      // Hours on shifts that started on an observed holiday (company time zone).
      const holidayWorkedHours = round(
        counted
          .filter((t) => t.clockOut && holidayDays.has(localParts(t.clockIn, tz).date))
          .reduce((sum, t) => sum + entryHours(t), 0),
      );
      const premium = holidayWorkedHours * (rules.workedMultiplier - 1);
      const gross =
        e.payType === "hourly"
          ? Math.round((hours.regularHours + ptoHours + holidayHours + premium) * e.payRateCents + hours.overtimeHours * e.payRateCents * 1.5)
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
        holidayHours,
        holidayWorkedHours,
        holidayNotes,
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
    "Holiday Hours",
    "Hours Worked On Holidays",
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
    l.holidayHours.toFixed(2),
    l.holidayWorkedHours.toFixed(2),
    l.estimatedGrossCents == null ? "" : (l.estimatedGrossCents / 100).toFixed(2),
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
