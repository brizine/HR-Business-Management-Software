import { z } from "zod";

/**
 * Attendance: each person's scheduled days compared with their punches and time off.
 *
 *   on_time      worked as scheduled (green)
 *   tardy        clocked in after the grace period (yellow)
 *   early_leave  clocked out before the shift ended, beyond the grace period (yellow)
 *   no_show      scheduled, never clocked in, no approved time off (red)
 *   sick         called in sick: approved sick time, or marked by an owner/admin (blue)
 *   excused      approved time off or an excused absence (grey)
 *   unscheduled  worked a day they weren't scheduled (green outline)
 *   pending      scheduled, not yet reached the no-show time (no colour)
 *
 * Owners and admins can change any day on the calendar (an "override"), with a note.
 * Points add up for late arrivals, early departures, no-shows and (optionally) sick days, and
 * drop off after a number of days. Reaching a point level alerts managers.
 */
export const ATTENDANCE_STATUSES = ["on_time", "tardy", "early_leave", "no_show", "sick", "excused", "unscheduled", "pending"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
/** What an owner/admin can set a day to on the calendar. */
export const OVERRIDE_STATUSES = ["on_time", "tardy", "early_leave", "no_show", "sick", "excused"] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  on_time: "Worked as scheduled",
  tardy: "Late",
  early_leave: "Left early",
  no_show: "No-show",
  sick: "Called in sick",
  excused: "Excused / time off",
  unscheduled: "Worked (not scheduled)",
  pending: "Scheduled",
};

export const EARLY_CLOCK_IN_ACTIONS = ["note", "points", "block"] as const;
export type EarlyClockInAction = (typeof EARLY_CLOCK_IN_ACTIONS)[number];
export const EARLY_CLOCK_IN_LABELS: Record<EarlyClockInAction, string> = {
  note: "Just note it on the calendar and report",
  points: "Note it and add points",
  block: "Don't allow clocking in that early",
};

export const attendanceThresholdSchema = z.object({
  points: z.number().min(0.5).max(100),
  /** What it means, e.g. "Written warning". Managers are alerted when someone reaches it. */
  label: z.string().trim().min(1).max(80),
});

export const attendanceRulesSchema = z.object({
  /** Minutes after a shift starts before clocking in counts as late. */
  graceMinutes: z.number().int().min(0).max(120),
  /** Minutes before a shift ends that clocking out still counts as on time. */
  earlyLeaveGraceMinutes: z.number().int().min(0).max(240),
  /** Alert when someone hasn't clocked in this many minutes after their shift starts (also when it becomes a no-show). */
  noShowMinutes: z.number().int().min(5).max(720),
  /** Send "hasn't clocked in" alerts to managers (and the employee). */
  alertsEnabled: z.boolean(),
  pointsEnabled: z.boolean(),
  tardyPoints: z.number().min(0).max(10),
  earlyLeavePoints: z.number().min(0).max(10),
  noShowPoints: z.number().min(0).max(10),
  sickPoints: z.number().min(0).max(10),
  /** "Very late": at least this many minutes late earns lateTierPoints instead (0 = off). */
  lateTierMinutes: z.number().int().min(0).max(720),
  lateTierPoints: z.number().min(0).max(10),
  /** "Left very early": at least this many minutes early earns earlyTierPoints instead (0 = off). */
  earlyTierMinutes: z.number().int().min(0).max(720),
  earlyTierPoints: z.number().min(0).max(10),
  /** A day that's both late and left early earns points for both (otherwise just for being late). */
  countLateAndEarly: z.boolean(),
  /** Clocking in up to this many minutes before a shift is fine; earlier counts as "clocked in early" (0 = no limit). */
  earlyClockInMinutes: z.number().int().min(0).max(240),
  /** What happens when someone clocks in earlier: just note it, also add points, or don't allow it at the time clock. */
  earlyClockInAction: z.enum(EARLY_CLOCK_IN_ACTIONS),
  earlyClockInPoints: z.number().min(0).max(10),
  /** Points drop off this many days after the day they were earned. */
  pointsExpireDays: z.number().int().min(7).max(730),
  thresholds: z.array(attendanceThresholdSchema).max(10),
});
export type AttendanceRules = z.infer<typeof attendanceRulesSchema>;

export const DEFAULT_ATTENDANCE_RULES: AttendanceRules = {
  graceMinutes: 5,
  earlyLeaveGraceMinutes: 5,
  noShowMinutes: 30,
  alertsEnabled: true,
  pointsEnabled: true,
  tardyPoints: 0.5,
  earlyLeavePoints: 0.5,
  noShowPoints: 1,
  sickPoints: 0,
  lateTierMinutes: 0,
  lateTierPoints: 1,
  earlyTierMinutes: 0,
  earlyTierPoints: 1,
  countLateAndEarly: false,
  earlyClockInMinutes: 0,
  earlyClockInAction: "note",
  earlyClockInPoints: 0.5,
  pointsExpireDays: 90,
  thresholds: [
    { points: 3, label: "Verbal warning" },
    { points: 5, label: "Written warning" },
    { points: 7, label: "Final warning" },
  ],
};

export const attendanceOverrideSchema = z.object({
  employeeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** null puts the day back to what the punches show. */
  status: z.enum(OVERRIDE_STATUSES).nullable(),
  note: z.string().trim().max(500).optional(),
  /** Points for this day instead of the usual amount (null = the usual). */
  points: z.number().min(0).max(10).nullable().optional(),
});

export interface ShiftLike { start: number; end: number }
export interface PunchLike { clockIn: number; clockOut: number | null }

export interface ShiftResult {
  start: number;
  end: number;
  clockIn: number | null;
  clockOut: number | null;
  minutesLate: number;
  minutesEarly: number;
  /** How many minutes before the shift they clocked in (0 if not early). */
  minutesEarlyIn: number;
  status: Exclude<AttendanceStatus, "sick" | "excused" | "unscheduled">;
}

const MIN = 60_000;
/** A punch belongs to a shift if it overlaps it, or starts up to 3 hours before it. */
const EARLY_PUNCH = 3 * 60 * MIN;

/** One shift against the punches (times in ms). */
export function classifyShift(shift: ShiftLike, punches: PunchLike[], rules: Pick<AttendanceRules, "graceMinutes" | "earlyLeaveGraceMinutes" | "noShowMinutes">, now: number): ShiftResult {
  const mine = punches.filter((p) => p.clockIn < shift.end && (p.clockOut ?? now) > shift.start - EARLY_PUNCH).sort((a, b) => a.clockIn - b.clockIn);
  const base = { start: shift.start, end: shift.end };
  if (!mine.length) {
    const noShowAt = shift.start + rules.noShowMinutes * MIN;
    return { ...base, clockIn: null, clockOut: null, minutesLate: 0, minutesEarly: 0, minutesEarlyIn: 0, status: now >= noShowAt ? "no_show" : "pending" };
  }
  const clockIn = mine[0].clockIn;
  const last = mine[mine.length - 1];
  const clockOut = last.clockOut;
  const minutesLate = Math.max(0, Math.round((clockIn - shift.start) / MIN));
  const minutesEarly = clockOut == null ? 0 : Math.max(0, Math.round((shift.end - clockOut) / MIN));
  const minutesEarlyIn = Math.max(0, Math.round((shift.start - clockIn) / MIN));
  const status = minutesLate > rules.graceMinutes ? "tardy" : minutesEarly > rules.earlyLeaveGraceMinutes ? "early_leave" : clockOut == null && now < shift.end ? "pending" : "on_time";
  // Still on the clock and on time: "pending" only until the shift ends; then it counts as worked.
  return { ...base, clockIn, clockOut, minutesLate, minutesEarly, minutesEarlyIn, status: status === "pending" ? "on_time" : status };
}

const WORST: AttendanceStatus[] = ["no_show", "tardy", "early_leave", "pending", "on_time"];

/**
 * One person's day: their shifts that start that day, punches, and approved time off (if any,
 * `sick` when it's a sick-time policy). Returns the day's status and each shift's details.
 */
export function classifyDay(input: {
  shifts: ShiftLike[];
  punches: PunchLike[];
  timeOff: { sick: boolean } | null;
  rules: Pick<AttendanceRules, "graceMinutes" | "earlyLeaveGraceMinutes" | "noShowMinutes">;
  now: number;
}): { status: AttendanceStatus | null; shifts: ShiftResult[] } {
  const results = input.shifts.map((s) => classifyShift(s, input.punches, input.rules, input.now));
  if (!results.length) return { status: input.punches.length ? "unscheduled" : input.timeOff ? (input.timeOff.sick ? "sick" : "excused") : null, shifts: [] };
  // Approved time off covers missed shifts (worked ones still count as worked).
  if (input.timeOff && results.every((r) => r.status === "no_show" || r.status === "pending")) return { status: input.timeOff.sick ? "sick" : "excused", shifts: results };
  const status = WORST.find((w) => results.some((r) => r.status === w)) ?? "on_time";
  return { status, shifts: results };
}

/** How late / early a day was: the worst shift that day. */
export interface DayTimes { minutesLate: number; minutesEarly: number; minutesEarlyIn?: number }

/** The worst lateness and early departure among a day's shifts (beyond the grace periods count). */
export function dayTimes(shifts: Pick<ShiftResult, "minutesLate" | "minutesEarly" | "minutesEarlyIn">[]): DayTimes {
  return {
    minutesLate: Math.max(0, ...shifts.map((s) => s.minutesLate)),
    minutesEarly: Math.max(0, ...shifts.map((s) => s.minutesEarly)),
    minutesEarlyIn: Math.max(0, ...shifts.map((s) => s.minutesEarlyIn)),
  };
}

/** Whether a day's clock-in was earlier than the early buffer allows. */
export const clockedInTooEarly = (times: DayTimes | undefined, rules: Pick<AttendanceRules, "earlyClockInMinutes">) =>
  !!times && rules.earlyClockInMinutes > 0 && (times.minutesEarlyIn ?? 0) > rules.earlyClockInMinutes;

/**
 * Points a day earns under the rules (0 if points are off). With `times` (what the punches showed),
 * the "very late" / "left very early" amounts apply, and a day that was both late and early can
 * earn both. Without them (e.g. an owner set the day by hand) the usual amounts apply.
 */
export function pointsFor(status: AttendanceStatus | null, rules: AttendanceRules, times?: DayTimes): number {
  if (!rules.pointsEnabled || !status) return 0;
  // Clocking in too early adds its points to a worked day, when the rules say so.
  const earlyIn = rules.earlyClockInAction === "points" && clockedInTooEarly(times, rules) && ["on_time", "tardy", "early_leave"].includes(status) ? rules.earlyClockInPoints : 0;
  return earlyIn + basePoints(status, rules, times);
}

function basePoints(status: AttendanceStatus, rules: AttendanceRules, times?: DayTimes): number {
  const late = () => (times && rules.lateTierMinutes > 0 && times.minutesLate >= rules.lateTierMinutes ? rules.lateTierPoints : rules.tardyPoints);
  const early = () => (times && rules.earlyTierMinutes > 0 && times.minutesEarly >= rules.earlyTierMinutes ? rules.earlyTierPoints : rules.earlyLeavePoints);
  switch (status) {
    case "tardy": return late() + (rules.countLateAndEarly && times && times.minutesEarly > rules.earlyLeaveGraceMinutes ? early() : 0);
    case "early_leave": return early();
    case "no_show": return rules.noShowPoints;
    case "sick": return rules.sickPoints;
    default: return 0;
  }
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The first day whose points still count today (points earned before it have dropped off). */
export const pointsWindowStart = (today: string, rules: Pick<AttendanceRules, "pointsExpireDays">) => addDays(today, -(rules.pointsExpireDays - 1));

/**
 * Current points from dated events (only those within the window count), and the highest
 * threshold reached. `crossedOn` is the day the running total first reached that threshold
 * (used so each crossing alerts once).
 */
export function currentPoints(events: { date: string; points: number }[], today: string, rules: AttendanceRules) {
  const from = pointsWindowStart(today, rules);
  const active = events.filter((e) => e.points > 0 && e.date >= from && e.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  let total = 0;
  const reached: { points: number; label: string; crossedOn: string }[] = [];
  const levels = [...rules.thresholds].sort((a, b) => a.points - b.points);
  for (const e of active) {
    total += e.points;
    for (const t of levels) if (total >= t.points && !reached.some((r) => r.points === t.points)) reached.push({ ...t, crossedOn: e.date });
  }
  const next = levels.find((t) => total < t.points) ?? null;
  // When the oldest counted point drops off.
  const nextExpiry = active.length ? addDays(active[0].date, rules.pointsExpireDays) : null;
  return { total: Math.round(total * 100) / 100, reached, highest: reached[reached.length - 1] ?? null, next, nextExpiry };
}
