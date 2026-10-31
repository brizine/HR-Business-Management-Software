import { z } from "zod";

/**
 * Pay schedules. Dates are calendar days ("YYYY-MM-DD") in the company's time zone.
 *   weekly / biweekly: back-to-back 7- or 14-day periods counted from `anchorDate` (a period start)
 *   semimonthly: the 1st–15th and the 16th–end of each month
 *   monthly: each calendar month
 * Payday is `paydayOffsetDays` after the period's last day.
 */
export const PAY_FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];
export const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Every two weeks (bi-weekly)",
  semimonthly: "Twice a month (1st–15th, 16th–end)",
  monthly: "Monthly",
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const payScheduleSchema = z
  .object({
    frequency: z.enum(PAY_FREQUENCIES).nullable(),
    /** First day of any pay period (weekly and bi-weekly only). */
    anchorDate: isoDate.nullable().optional(),
    paydayOffsetDays: z.number().int().min(0).max(31),
    /** Who gets asked to approve each period once it ends. */
    approverIds: z.array(z.string().uuid()).max(50),
  })
  .refine((s) => !(s.frequency === "weekly" || s.frequency === "biweekly") || !!s.anchorDate, {
    message: "Pick the first day of a pay period",
    path: ["anchorDate"],
  });
export type PaySchedule = z.infer<typeof payScheduleSchema>;

const DAY = 86_400_000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => toIso(new Date(toDate(iso).getTime() + days * DAY));
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

export interface PayPeriod {
  start: string;
  end: string;
  payday: string;
}

/** The pay period that contains `date`. */
export function periodContaining(date: string, s: { frequency: PayFrequency; anchorDate?: string | null; paydayOffsetDays: number }): PayPeriod {
  let start: string, end: string;
  if (s.frequency === "weekly" || s.frequency === "biweekly") {
    const len = s.frequency === "weekly" ? 7 : 14;
    const anchor = s.anchorDate ?? date;
    const diff = Math.round((toDate(date).getTime() - toDate(anchor).getTime()) / DAY);
    const k = Math.floor(diff / len);
    start = addDays(anchor, k * len);
    end = addDays(start, len - 1);
  } else {
    const [y, m, d] = date.split("-").map(Number);
    const last = lastOfMonth(y, m - 1);
    if (s.frequency === "monthly") {
      start = `${y}-${pad(m)}-01`;
      end = `${y}-${pad(m)}-${pad(last)}`;
    } else if (d <= 15) {
      start = `${y}-${pad(m)}-01`;
      end = `${y}-${pad(m)}-15`;
    } else {
      start = `${y}-${pad(m)}-16`;
      end = `${y}-${pad(m)}-${pad(last)}`;
    }
  }
  return { start, end, payday: addDays(end, s.paydayOffsetDays) };
}

/** `count` periods starting with the one containing `from`. */
export function upcomingPeriods(from: string, s: Parameters<typeof periodContaining>[1], count: number): PayPeriod[] {
  const out: PayPeriod[] = [];
  let day = from;
  for (let i = 0; i < count; i++) {
    const p = periodContaining(day, s);
    out.push(p);
    day = addDays(p.end, 1);
  }
  return out;
}

/** The most recent period that has fully ended before `today` (its last day was yesterday or earlier). */
export function lastEndedPeriod(today: string, s: Parameters<typeof periodContaining>[1]) {
  const yesterday = addDays(today, -1);
  const p = periodContaining(yesterday, s);
  return p.end <= yesterday ? p : periodContaining(addDays(p.start, -1), s);
}
