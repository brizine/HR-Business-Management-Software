import { z } from "zod";
import { EMPLOYMENT_TYPES } from "./schemas";

/**
 * Paid holidays. Each holiday has a date rule:
 *   fixed: the same date every year (July 4)
 *   nth:   a weekday in a month ("4th Thursday of November", "last Monday of May"), optionally
 *          shifted by a number of days ("the day after Thanksgiving" = 4th Thursday + 1)
 *   once:  one specific date (a one-off day off)
 * Holidays that land on a weekend can be observed on the nearest weekday (Saturday → Friday,
 * Sunday → Monday). Dates are calendar days ("YYYY-MM-DD") in the company's time zone.
 */
export const HOLIDAY_RULE_KINDS = ["fixed", "nth", "once"] as const;
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const holidayRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }),
  z.object({
    kind: z.literal("nth"),
    month: z.number().int().min(1).max(12),
    weekday: z.number().int().min(0).max(6),
    /** 1–4, or -1 for the last one in the month. */
    nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
    /** Days after that weekday (e.g. 1 for the day after Thanksgiving). */
    offsetDays: z.number().int().min(-6).max(6).default(0),
  }),
  z.object({ kind: z.literal("once"), date: isoDate }),
]);
export type HolidayRule = z.infer<typeof holidayRuleSchema>;

/** "nearest": Saturday → Friday, Sunday → Monday. "none": paid on the day itself, even on a weekend. */
export const HOLIDAY_OBSERVE = ["nearest", "none"] as const;
export type HolidayObserve = (typeof HOLIDAY_OBSERVE)[number];

export const holidaySchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  rule: holidayRuleSchema,
  /** Paid hours for a full holiday. */
  hours: z.number().min(0).max(24),
  observe: z.enum(HOLIDAY_OBSERVE).default("nearest"),
  active: z.boolean().default(true),
});
export type HolidayInput = z.infer<typeof holidaySchema>;

/** Who gets holiday pay, and what working on a holiday pays. */
export const holidayRulesSchema = z.object({
  /** Employment types that get paid holidays. */
  eligibleTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(EMPLOYMENT_TYPES.length),
  /** Days after the hire date before someone gets holiday pay (0 = right away). */
  waitingDays: z.number().int().min(0).max(730),
  /** Part-time employees get this share of a holiday's hours (0.5 = half). Only matters if part-time is eligible. */
  partTimeShare: z.number().min(0).max(1),
  /** Pay for hours worked on a holiday, as a multiple of their rate (1 = normal pay, 1.5 = time and a half). Paid on top of holiday pay. */
  workedMultiplier: z.number().min(1).max(3),
});
export type HolidayRules = z.infer<typeof holidayRulesSchema>;
export const DEFAULT_HOLIDAY_RULES: HolidayRules = { eligibleTypes: ["full_time"], waitingDays: 0, partTimeShare: 0.5, workedMultiplier: 1 };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => new Date(utc(s).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const weekdayOf = (s: string) => utc(s).getUTCDay();

/** The holiday's actual date in a year, or null if it doesn't happen that year. */
export function holidayDate(rule: HolidayRule, year: number): string | null {
  if (rule.kind === "once") return rule.date.startsWith(`${year}-`) ? rule.date : null;
  if (rule.kind === "fixed") return iso(year, rule.month, Math.min(rule.day, lastOfMonth(year, rule.month)));
  let day: number;
  if (rule.nth === -1) {
    const last = lastOfMonth(year, rule.month);
    const lastWeekday = weekdayOf(iso(year, rule.month, last));
    day = last - ((lastWeekday - rule.weekday + 7) % 7);
  } else {
    const firstWeekday = weekdayOf(iso(year, rule.month, 1));
    day = 1 + ((rule.weekday - firstWeekday + 7) % 7) + (rule.nth - 1) * 7;
  }
  return addDays(iso(year, rule.month, day), rule.offsetDays ?? 0);
}

/** The day it's taken off: a weekend holiday moves to Friday or Monday when observed "nearest". */
export function observedDate(date: string, observe: HolidayObserve): string {
  if (observe === "none") return date;
  const wd = weekdayOf(date);
  return wd === 6 ? addDays(date, -1) : wd === 0 ? addDays(date, 1) : date;
}

export interface HolidayOccurrence<H> {
  holiday: H;
  /** The holiday itself. */
  date: string;
  /** The day off and paid. */
  observed: string;
}

/** Every observed holiday with its day off in [from, to] (inclusive), in date order. */
export function holidaysBetween<H extends { rule: HolidayRule; observe: HolidayObserve; active?: boolean }>(list: H[], from: string, to: string): HolidayOccurrence<H>[] {
  const out: HolidayOccurrence<H>[] = [];
  // A weekend move can cross a year boundary (Jan 1 on a Saturday is observed Dec 31).
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)) + 1; y++) {
    for (const h of list) {
      if (h.active === false) continue;
      const date = holidayDate(h.rule, y);
      if (!date) continue;
      const observed = observedDate(date, h.observe);
      if (observed >= from && observed <= to) out.push({ holiday: h, date, observed });
    }
  }
  return out.sort((a, b) => a.observed.localeCompare(b.observed));
}

/** Holiday hours someone gets for a holiday on `date` (0 if not eligible). */
export function holidayHoursFor(
  person: { employmentType: string; hireDate: string | null; status?: string },
  rules: HolidayRules,
  hours: number,
  date: string,
): number {
  if (!rules.eligibleTypes.includes(person.employmentType as never)) return 0;
  if (person.hireDate && addDays(person.hireDate, rules.waitingDays) > date) return 0;
  if (person.hireDate && person.hireDate > date) return 0;
  return person.employmentType === "part_time" ? Math.round(hours * rules.partTimeShare * 100) / 100 : hours;
}

/** "4th Thursday of November", "July 4", "Day after the 4th Thursday of November", "Dec 24, 2026 (one time)". */
export function describeHolidayRule(rule: HolidayRule): string {
  if (rule.kind === "once") {
    const [y, m, d] = rule.date.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${d}, ${y} (one time)`;
  }
  if (rule.kind === "fixed") return `${MONTH_NAMES[rule.month - 1]} ${rule.day}, every year`;
  const nth = rule.nth === -1 ? "Last" : ["1st", "2nd", "3rd", "4th"][rule.nth - 1];
  const base = `${nth} ${WEEKDAY_NAMES[rule.weekday]} of ${MONTH_NAMES[rule.month - 1]}`;
  const off = rule.offsetDays ?? 0;
  if (!off) return base;
  if (off === 1) return `Day after the ${base}`;
  if (off === -1) return `Day before the ${base}`;
  return `${Math.abs(off)} day${Math.abs(off) === 1 ? "" : "s"} ${off > 0 ? "after" : "before"} the ${base}`;
}

/** Common US paid holidays the owner can add with one click. */
export const HOLIDAY_PRESETS: { key: string; name: string; rule: HolidayRule }[] = [
  { key: "new_year", name: "New Year's Day", rule: { kind: "fixed", month: 1, day: 1 } },
  { key: "mlk", name: "Martin Luther King Jr. Day", rule: { kind: "nth", month: 1, weekday: 1, nth: 3, offsetDays: 0 } },
  { key: "presidents", name: "Presidents' Day", rule: { kind: "nth", month: 2, weekday: 1, nth: 3, offsetDays: 0 } },
  { key: "memorial", name: "Memorial Day", rule: { kind: "nth", month: 5, weekday: 1, nth: -1, offsetDays: 0 } },
  { key: "juneteenth", name: "Juneteenth", rule: { kind: "fixed", month: 6, day: 19 } },
  { key: "independence", name: "Independence Day", rule: { kind: "fixed", month: 7, day: 4 } },
  { key: "labor", name: "Labor Day", rule: { kind: "nth", month: 9, weekday: 1, nth: 1, offsetDays: 0 } },
  { key: "columbus", name: "Columbus Day", rule: { kind: "nth", month: 10, weekday: 1, nth: 2, offsetDays: 0 } },
  { key: "veterans", name: "Veterans Day", rule: { kind: "fixed", month: 11, day: 11 } },
  { key: "thanksgiving", name: "Thanksgiving Day", rule: { kind: "nth", month: 11, weekday: 4, nth: 4, offsetDays: 0 } },
  { key: "black_friday", name: "Day after Thanksgiving", rule: { kind: "nth", month: 11, weekday: 4, nth: 4, offsetDays: 1 } },
  { key: "christmas_eve", name: "Christmas Eve", rule: { kind: "fixed", month: 12, day: 24 } },
  { key: "christmas", name: "Christmas Day", rule: { kind: "fixed", month: 12, day: 25 } },
  { key: "new_years_eve", name: "New Year's Eve", rule: { kind: "fixed", month: 12, day: 31 } },
];
