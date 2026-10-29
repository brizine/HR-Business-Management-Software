export interface EntryLike {
  clockIn: string | Date;
  clockOut: string | Date | null;
}

export function entryHours(e: EntryLike, now = new Date()): number {
  const start = new Date(e.clockIn).getTime();
  const end = e.clockOut ? new Date(e.clockOut).getTime() : now.getTime();
  return Math.max(0, (end - start) / 3_600_000);
}

/** ISO week key (Monday start) used to bucket hours for weekly overtime. */
export function weekKey(d: string | Date): string {
  const date = new Date(d);
  const day = (date.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export interface HoursSummary {
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
}

/**
 * Splits hours into regular and overtime using the US federal (FLSA) rule:
 * hours over 40 in a workweek are overtime. States with daily overtime
 * (e.g. California) need an extra rule on top of this.
 */
export function summarizeHours(entries: EntryLike[], weeklyThreshold = 40, now = new Date()): HoursSummary {
  const byWeek = new Map<string, number>();
  for (const e of entries) {
    const k = weekKey(e.clockIn);
    byWeek.set(k, (byWeek.get(k) ?? 0) + entryHours(e, now));
  }
  let regular = 0;
  let overtime = 0;
  for (const h of byWeek.values()) {
    regular += Math.min(h, weeklyThreshold);
    overtime += Math.max(0, h - weeklyThreshold);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { totalHours: round(regular + overtime), regularHours: round(regular), overtimeHours: round(overtime) };
}
