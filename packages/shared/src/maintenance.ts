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

/** How close counts as "due soon" for a work order scheduled by mileage, engine hours or date. */
export const WORK_ORDER_DUE_SOON = { miles: 500, hours: 25, days: 7 };

export interface WorkOrderDueLike { dueDate?: string | null; dueOdometer?: number | null; dueHours?: number | null }

/**
 * Where a scheduled work order stands against the asset's meters and today's date (whichever
 * comes first): "upcoming", "due_soon" or "overdue", with the distance to go for each. Null if it
 * has no due point.
 */
export function workOrderDue(wo: WorkOrderDueLike, meter: MeterLike, today = new Date()): { status: "upcoming" | "due_soon" | "overdue"; notes: string[] } | null {
  const notes: string[] = [];
  let status: "upcoming" | "due_soon" | "overdue" | null = null;
  const bump = (s: "upcoming" | "due_soon" | "overdue") => {
    const rank = { upcoming: 0, due_soon: 1, overdue: 2 };
    if (!status || rank[s] > rank[status]) status = s;
  };
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  if (wo.dueOdometer != null) {
    const left = wo.dueOdometer - meter.odometer;
    bump(left <= 0 ? "overdue" : left <= WORK_ORDER_DUE_SOON.miles ? "due_soon" : "upcoming");
    notes.push(left <= 0 ? `${fmt(-left)} miles past ${fmt(wo.dueOdometer)} mi` : `${fmt(left)} miles to go (due at ${fmt(wo.dueOdometer)} mi)`);
  }
  if (wo.dueHours != null) {
    const left = wo.dueHours - meter.engineHours;
    bump(left <= 0 ? "overdue" : left <= WORK_ORDER_DUE_SOON.hours ? "due_soon" : "upcoming");
    notes.push(left <= 0 ? `${fmt(-left)} hours past ${fmt(wo.dueHours)} hrs` : `${fmt(left)} hours to go (due at ${fmt(wo.dueHours)} hrs)`);
  }
  if (wo.dueDate) {
    const days = Math.round((Date.parse(`${wo.dueDate}T00:00:00Z`) - Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`)) / DAY_MS);
    bump(days < 0 ? "overdue" : days <= WORK_ORDER_DUE_SOON.days ? "due_soon" : "upcoming");
    notes.push(days < 0 ? `${-days} day${days === -1 ? "" : "s"} past the due date` : days === 0 ? "due today" : `${days} day${days === 1 ? "" : "s"} to go`);
  }
  return status ? { status, notes } : null;
}
