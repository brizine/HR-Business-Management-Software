import { z } from "zod";
import { entryHours, weekKey, type EntryLike } from "./time";

/**
 * Pay rate history. Each raise (or change between hourly and salary) is a row with the date it
 * takes effect, so payroll for any period pays each day at the rate in effect that day.
 */
export interface PayRateLike {
  effectiveDate: string;
  payType: string;
  payRateCents: number;
}

export const payRateSchema = z.object({
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date the new pay starts"),
  payType: z.enum(["hourly", "salary"]),
  payRateCents: z.number().int().nonnegative().max(100_000_000),
  note: z.string().trim().max(200).optional(),
});

/** Oldest first. */
export const sortRates = <T extends PayRateLike>(rates: T[]) => [...rates].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

/** The rate in effect on `date` (YYYY-MM-DD). Before the first rate, the first rate applies. */
export function rateOn<T extends PayRateLike>(rates: T[], date: string): T | null {
  const sorted = sortRates(rates);
  let found: T | null = sorted[0] ?? null;
  for (const r of sorted) if (r.effectiveDate <= date) found = r;
  return found;
}

/** The rates that applied at some point during [from, to]: the one in effect at the start, then any changes. */
export function ratesDuring<T extends PayRateLike>(rates: T[], from: string, to: string): T[] {
  const first = rateOn(rates, from);
  return [...(first ? [first] : []), ...sortRates(rates).filter((r) => r.effectiveDate > from && r.effectiveDate <= to)];
}

export interface HourlyPayInput {
  /** Completed time entries; `date` is the local calendar day the entry started (it decides the rate). */
  entries: (EntryLike & { date: string })[];
  rates: PayRateLike[];
  weeklyThreshold: number;
  /** Paid time off and paid holiday hours, by day (paid at that day's rate). */
  paidHours: { date: string; hours: number }[];
  /** Hours worked on a holiday, by day, and the holiday multiplier (premium = hours x (multiplier - 1) x rate). */
  holidayWorked: { date: string; hours: number }[];
  holidayMultiplier: number;
}

/**
 * Gross pay for the hourly days in a period, in cents. Overtime follows the federal (FLSA) rule
 * for a week with more than one rate: the overtime premium is half the week's weighted average
 * rate (straight-time pay / hours worked) for each overtime hour. With one rate that's the usual
 * 1.5x. Days on a salary rate aren't included (salaried pay is left to the payroll system).
 * Returns null when every rate that applies is a salary.
 */
export function hourlyGrossCents(input: HourlyPayInput): number | null {
  const rateFor = (date: string) => {
    const r = rateOn(input.rates, date);
    return r && r.payType === "hourly" ? r.payRateCents : null;
  };
  let total = 0;
  const weeks = new Map<string, { hours: number; straight: number; hourlyHours: number }>();
  for (const e of input.entries) {
    const h = entryHours(e);
    const rate = rateFor(e.date);
    const key = weekKey(e.clockIn);
    const w = weeks.get(key) ?? { hours: 0, straight: 0, hourlyHours: 0 };
    w.hours += h;
    if (rate != null) {
      w.straight += h * rate;
      w.hourlyHours += h;
    }
    weeks.set(key, w);
  }
  for (const w of weeks.values()) {
    total += w.straight;
    const overtime = Math.max(0, w.hours - input.weeklyThreshold);
    if (overtime > 0 && w.hourlyHours > 0) {
      const regularRate = w.straight / w.hourlyHours;
      total += 0.5 * regularRate * Math.min(overtime, w.hourlyHours);
    }
  }
  for (const p of input.paidHours) {
    const rate = rateFor(p.date);
    if (rate != null) total += p.hours * rate;
  }
  for (const p of input.holidayWorked) {
    const rate = rateFor(p.date);
    if (rate != null) total += p.hours * (input.holidayMultiplier - 1) * rate;
  }
  const days = [...input.entries.map((e) => e.date), ...input.paidHours.map((p) => p.date)];
  const anyHourlyDay = days.some((d) => rateFor(d) != null);
  if (!anyHourlyDay && (days.length > 0 || input.rates.every((r) => r.payType !== "hourly"))) return null;
  return Math.round(total);
}

/** "$18.00/hr, then $20.00/hr from Mar 15" for a period with a change. */
export function describeRates(rates: PayRateLike[]): string {
  const money = (r: PayRateLike) =>
    r.payType === "hourly"
      ? `$${(r.payRateCents / 100).toFixed(2)}/hr`
      : `$${(r.payRateCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}/yr salary`;
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return rates.map((r, i) => (i === 0 ? money(r) : `${money(r)} from ${day(r.effectiveDate)}`)).join(", then ");
}
