import { and, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import {
  ATTENDANCE_LABELS,
  DEFAULT_ATTENDANCE_RULES,
  classifyDay,
  currentPoints,
  isInactive,
  pointsFor,
  pointsWindowStart,
  type AttendanceRules,
  type AttendanceStatus,
  type ShiftResult,
} from "@crewdesk/shared";
import { db } from "../db";
import { attendanceOverrides, companies, employees, ptoPolicies, ptoRequests, shifts, timeEntries } from "../db/schema";
import { localParts } from "./tz";

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export async function attendanceRulesFor(companyId: string): Promise<AttendanceRules> {
  const [c] = await db.select({ rules: companies.attendanceRules }).from(companies).where(eq(companies.id, companyId));
  return { ...DEFAULT_ATTENDANCE_RULES, ...(c?.rules ?? {}) };
}

export interface AttendanceDay {
  date: string;
  status: AttendanceStatus;
  /** What the punches and time off show (before any owner/admin change). */
  auto: AttendanceStatus | null;
  overridden: boolean;
  note: string | null;
  points: number;
  shifts: ShiftResult[];
}

/**
 * Each person's attendance day by day for [from, to] (company time zone), plus their current
 * points. `employeeIds` limits it to some people.
 */
export async function computeAttendance(companyId: string, from: string, to: string, employeeIds: string[] | null, now = new Date()) {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const tz = company.timezone;
  const rules = await attendanceRulesFor(companyId);
  const today = localParts(now, tz).date;
  // Load enough history for current points too.
  const windowFrom = pointsWindowStart(today, rules);
  const loadFrom = windowFrom < from ? windowFrom : from;
  const lo = new Date(Date.parse(`${loadFrom}T00:00:00Z`) - 2 * DAY);
  const hi = new Date(Date.parse(`${to > today ? to : today}T00:00:00Z`) + 2 * DAY);

  const people = (await db.select().from(employees).where(eq(employees.companyId, companyId)))
    .filter((e) => (!employeeIds || employeeIds.includes(e.id)));
  const ids = people.map((p) => p.id);
  if (!ids.length) return { rules, today, people: [] };

  const shiftRows = await db.select({ employeeId: shifts.employeeId, startsAt: shifts.startsAt, endsAt: shifts.endsAt }).from(shifts)
    .where(and(eq(shifts.companyId, companyId), eq(shifts.status, "published"), isNotNull(shifts.employeeId), inArray(shifts.employeeId, ids), gte(shifts.startsAt, lo), lt(shifts.startsAt, hi)));
  const punchRows = await db.select({ employeeId: timeEntries.employeeId, clockIn: timeEntries.clockIn, clockOut: timeEntries.clockOut }).from(timeEntries)
    .where(and(eq(timeEntries.companyId, companyId), inArray(timeEntries.employeeId, ids), gte(timeEntries.clockIn, new Date(lo.getTime() - DAY)), lt(timeEntries.clockIn, hi)));
  const offRows = await db.select({ employeeId: ptoRequests.employeeId, startDate: ptoRequests.startDate, endDate: ptoRequests.endDate, policy: ptoPolicies.name }).from(ptoRequests)
    .innerJoin(ptoPolicies, eq(ptoPolicies.id, ptoRequests.policyId))
    .where(and(eq(ptoRequests.companyId, companyId), eq(ptoRequests.status, "approved"), inArray(ptoRequests.employeeId, ids), lte(ptoRequests.startDate, addDays(to > today ? to : today, 1)), gte(ptoRequests.endDate, loadFrom)));
  const overrideRows = await db.select().from(attendanceOverrides)
    .where(and(eq(attendanceOverrides.companyId, companyId), inArray(attendanceOverrides.employeeId, ids), gte(attendanceOverrides.date, loadFrom), lte(attendanceOverrides.date, to > today ? to : today)));

  const nowMs = now.getTime();
  const dateOf = (d: Date) => localParts(d, tz).date;

  const result = people.map((e) => {
    const myShifts = shiftRows.filter((s) => s.employeeId === e.id).map((s) => ({ start: s.startsAt.getTime(), end: s.endsAt.getTime(), date: dateOf(s.startsAt) }));
    const myPunches = punchRows.filter((p) => p.employeeId === e.id).map((p) => ({ clockIn: p.clockIn.getTime(), clockOut: p.clockOut?.getTime() ?? null, date: dateOf(p.clockIn) }));
    const myOff = offRows.filter((r) => r.employeeId === e.id);
    const myOverrides = new Map(overrideRows.filter((o) => o.employeeId === e.id).map((o) => [o.date, o]));
    const overlapsShift = (p: { clockIn: number; clockOut: number | null }) => myShifts.some((s) => p.clockIn < s.end && (p.clockOut ?? nowMs) > s.start - 3 * 3_600_000);

    const dates = new Set<string>([
      ...myShifts.map((s) => s.date),
      ...myPunches.filter((p) => !overlapsShift(p)).map((p) => p.date),
      ...myOverrides.keys(),
    ]);
    const days: AttendanceDay[] = [];
    for (const date of [...dates].sort()) {
      if (date < loadFrom || date > (to > today ? to : today)) continue;
      const dayShifts = myShifts.filter((s) => s.date === date);
      const off = myOff.find((r) => r.startDate <= date && date <= r.endDate);
      const classified = classifyDay({
        shifts: dayShifts,
        punches: dayShifts.length ? myPunches : myPunches.filter((p) => p.date === date && !overlapsShift(p)),
        timeOff: dayShifts.length && off ? { sick: /sick|ill/i.test(off.policy) } : null,
        rules,
        now: nowMs,
      });
      const o = myOverrides.get(date);
      const status = (o?.status as AttendanceStatus | undefined) ?? classified.status;
      if (!status) continue;
      days.push({
        date,
        status,
        auto: classified.status,
        overridden: !!o,
        note: o?.note ?? null,
        points: o?.points ?? pointsFor(status, rules),
        shifts: classified.shifts,
      });
    }
    const points = currentPoints(days.map((d) => ({ date: d.date, points: d.points })), today, rules);
    const inRange = days.filter((d) => d.date >= from && d.date <= to);
    const count = (s: AttendanceStatus) => inRange.filter((d) => d.status === s).length;
    const counted = count("on_time") + count("tardy") + count("early_leave") + count("no_show");
    return {
      employee: { id: e.id, firstName: e.firstName, lastName: e.lastName, title: e.title, active: !isInactive(e.status) },
      days: inRange,
      summary: {
        scheduledDays: inRange.filter((d) => d.shifts.length).length,
        onTime: count("on_time"),
        tardy: count("tardy"),
        earlyLeave: count("early_leave"),
        noShow: count("no_show"),
        sick: count("sick"),
        excused: count("excused"),
        unscheduled: count("unscheduled"),
        /** On-time share of the days that count (worked or missed, not excused). */
        onTimeRate: counted ? Math.round((count("on_time") / counted) * 100) : null,
        minutesLate: inRange.reduce((m, d) => m + d.shifts.reduce((x, s) => x + (d.status === "tardy" ? s.minutesLate : 0), 0), 0),
      },
      points,
    };
  });
  return { rules, today, people: result };
}

export const statusText = (s: AttendanceStatus) => ATTENDANCE_LABELS[s];
