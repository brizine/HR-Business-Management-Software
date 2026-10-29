export type DueStatus = "ok" | "due_soon" | "overdue";

export interface ScheduleLike {
  intervalMiles?: number | null;
  intervalHours?: number | null;
  intervalDays?: number | null;
  lastServiceDate?: string | null;
  lastServiceOdometer?: number | null;
  lastServiceHours?: number | null;
}

export interface MeterLike {
  odometer: number;
  engineHours: number;
}

export interface DueResult {
  status: DueStatus;
  nextDueOdometer: number | null;
  nextDueHours: number | null;
  nextDueDate: string | null;
  /** Human-readable reasons the schedule is due soon or overdue. */
  reasons: string[];
}

/** Fraction of an interval remaining below which a schedule is "due soon". */
export const DUE_SOON_FRACTION = 0.1;

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whichever interval (miles, engine hours, calendar days) comes first wins,
 * like a "every 5,000 miles or 6 months" oil-change rule.
 */
export function computeDue(schedule: ScheduleLike, meter: MeterLike, today = new Date()): DueResult {
  const reasons: string[] = [];
  let worst: DueStatus = "ok";
  const bump = (s: DueStatus) => {
    if (s === "overdue" || (s === "due_soon" && worst === "ok")) worst = s;
  };

  const check = (remaining: number, interval: number, unit: string) => {
    if (remaining <= 0) {
      bump("overdue");
      reasons.push(`Overdue by ${Math.abs(Math.round(remaining)).toLocaleString()} ${unit}`);
    } else if (remaining <= interval * DUE_SOON_FRACTION) {
      bump("due_soon");
      reasons.push(`Due in ${Math.round(remaining).toLocaleString()} ${unit}`);
    }
  };

  let nextDueOdometer: number | null = null;
  if (schedule.intervalMiles) {
    nextDueOdometer = (schedule.lastServiceOdometer ?? 0) + schedule.intervalMiles;
    check(nextDueOdometer - meter.odometer, schedule.intervalMiles, "miles");
  }

  let nextDueHours: number | null = null;
  if (schedule.intervalHours) {
    nextDueHours = (schedule.lastServiceHours ?? 0) + schedule.intervalHours;
    check(nextDueHours - meter.engineHours, schedule.intervalHours, "hours");
  }

  let nextDueDate: string | null = null;
  if (schedule.intervalDays) {
    const base = schedule.lastServiceDate ?? today.toISOString().slice(0, 10);
    nextDueDate = addDays(base, schedule.intervalDays);
    const todayMs = Date.parse(today.toISOString().slice(0, 10) + "T00:00:00Z");
    const remainingDays = (Date.parse(nextDueDate + "T00:00:00Z") - todayMs) / DAY_MS;
    check(remainingDays, schedule.intervalDays, "days");
  }

  return { status: worst, nextDueOdometer, nextDueHours, nextDueDate, reasons };
}
