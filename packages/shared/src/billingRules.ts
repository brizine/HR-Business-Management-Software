import { z } from "zod";
import { formatMoney } from "./money";

/**
 * Late fees and auto-sending invoices, like Homeworks' Invoice Settings. The company sets the
 * default rules; each customer uses them, none, or their own.
 */

/* ── Late fees ── */

/** "30 days after the invoice was sent, add $15" or "... add 1.5%". `value` is cents for an amount, percent for a percent. */
export const lateFeeRuleSchema = z.object({
  days: z.coerce.number().int().min(1, "At least 1 day").max(365),
  kind: z.enum(["amount", "percent"]),
  value: z.coerce.number().positive("Enter the fee").max(10_000_000),
}).superRefine((r, ctx) => {
  if (r.kind === "percent" && r.value > 100) ctx.addIssue({ code: "custom", path: ["value"], message: "A percent can't be over 100" });
  if (r.kind === "amount" && !Number.isInteger(r.value)) ctx.addIssue({ code: "custom", path: ["value"], message: "Amounts are in cents" });
});
export type LateFeeRule = z.infer<typeof lateFeeRuleSchema>;
export const lateFeeRulesSchema = z.array(lateFeeRuleSchema).max(6, "Up to 6 steps").superRefine((rs, ctx) => {
  const days = rs.map((r) => r.days);
  if (new Set(days).size !== days.length) ctx.addIssue({ code: "custom", message: "Each step needs a different number of days" });
});

export const lateFeeSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  rules: lateFeeRulesSchema.default([]),
  /** Email the customer (with the new balance and pay link) when a fee is added. */
  emailCustomer: z.boolean().default(true),
});
export type LateFeeSettings = z.infer<typeof lateFeeSettingsSchema>;

/**
 * The fee one step adds. Every step works from the original invoice total (before any late fees),
 * so fees never compound.
 */
export function lateFeeAmount(rule: LateFeeRule, originalTotalCents: number): number {
  return rule.kind === "amount" ? Math.round(rule.value) : Math.round((originalTotalCents * rule.value) / 100);
}

/** The steps whose day has come (sent date + days, on or before today) that haven't been added yet. */
export function dueLateFeeRules(rules: LateFeeRule[], sentOn: string, today: string, done: Iterable<number>): LateFeeRule[] {
  const added = new Set(done);
  return [...rules].sort((a, b) => a.days - b.days).filter((r) => !added.has(r.days) && addDaysIso(sentOn, r.days) <= today);
}

export const describeLateFeeRule = (r: LateFeeRule) => `${r.kind === "amount" ? formatMoney(r.value) : `${r.value}%`} ${r.days} days after the invoice is sent`;

/** The rules a customer's invoices get: the company's (if on), none, or their own. */
export function effectiveLateFeeRules(company: LateFeeSettings, mode: string | null | undefined, custom: LateFeeRule[] | null | undefined): LateFeeRule[] {
  if (mode === "none") return [];
  if (mode === "custom") return custom ?? [];
  return company.enabled ? company.rules : [];
}

/* ── Auto-sending invoices ── */

export const SEND_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export const SEND_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const ORDINALS = ["", "first", "second", "third", "fourth", "last"] as const;

export const sendScheduleSchema = z.object({
  frequency: z.enum(SEND_FREQUENCIES),
  /** Daily: Monday to Friday only. */
  weekdaysOnly: z.boolean().default(false),
  /** Weekly: the days (0 = Sunday … 6 = Saturday). */
  days: z.array(z.number().int().min(0).max(6)).max(7).default([1]),
  /** Monthly: on a date ("day", 0 = the last day), or on e.g. the first Monday ("weekday"). */
  monthMode: z.enum(["day", "weekday"]).default("day"),
  monthDay: z.number().int().min(0).max(31).default(1),
  /** 1–4, or 5 for the last one. */
  nth: z.number().int().min(1).max(5).default(1),
  weekday: z.number().int().min(0).max(6).default(1),
}).superRefine((s, ctx) => {
  if (s.frequency === "weekly" && !s.days.length) ctx.addIssue({ code: "custom", path: ["days"], message: "Pick at least one day" });
});
export type SendSchedule = z.infer<typeof sendScheduleSchema>;
export const DEFAULT_SEND_SCHEDULE: SendSchedule = { frequency: "weekly", weekdaysOnly: false, days: [1], monthMode: "day", monthDay: 1, nth: 1, weekday: 1 };

export const autoSendSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: sendScheduleSchema.default(DEFAULT_SEND_SCHEDULE),
  /** The local hour they go out (0–23). */
  hour: z.number().int().min(0).max(23).default(8),
  /** First turn the customer's finished work orders that aren't on an invoice yet into invoices. */
  invoiceWorkOrders: z.boolean().default(true),
});
export type AutoSendSettings = z.infer<typeof autoSendSettingsSchema>;

const ymdParts = (ymd: string) => ymd.split("-").map(Number) as [number, number, number];
function addDaysIso(ymd: string, n: number) {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whether invoices go out on this day (YYYY-MM-DD) on this schedule. */
export function sendsOn(s: SendSchedule, ymd: string): boolean {
  const [y, m, d] = ymdParts(ymd);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (s.frequency === "daily") return !s.weekdaysOnly || (dow >= 1 && dow <= 5);
  if (s.frequency === "weekly") return s.days.includes(dow);
  if (s.monthMode === "day") {
    // The 31st in a 30-day month (and "last") means the month's last day.
    const want = s.monthDay === 0 ? lastDay : Math.min(s.monthDay, lastDay);
    return d === want;
  }
  if (dow !== s.weekday) return false;
  return s.nth === 5 ? d + 7 > lastDay : Math.ceil(d / 7) === s.nth;
}

/** "Every Monday and Thursday", "Every weekday", "Monthly on the 1st", "Monthly on the first Monday". */
export function describeSchedule(s: SendSchedule): string {
  if (s.frequency === "daily") return s.weekdaysOnly ? "Every weekday (Mon–Fri)" : "Every day";
  if (s.frequency === "weekly") {
    const names = [...s.days].sort().map((d) => SEND_WEEKDAYS[d]);
    return `Every ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
  }
  if (s.monthMode === "day") return s.monthDay === 0 ? "Monthly on the last day" : `Monthly on the ${ordinal(s.monthDay)}`;
  return `Monthly on the ${ORDINALS[s.nth]} ${SEND_WEEKDAYS[s.weekday]}`;
}
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** The schedule a customer's invoices go out on, or null when they don't auto-send. */
export function effectiveSchedule(company: AutoSendSettings, mode: string | null | undefined, custom: SendSchedule | null | undefined): SendSchedule | null {
  if (mode === "off") return null;
  if (mode === "custom") return custom ?? null;
  return company.enabled ? company.schedule : null;
}

/** A customer's own late fee and auto-send choices (from their page). */
export const customerBillingRulesSchema = z.object({
  lateFeeMode: z.enum(["default", "none", "custom"]),
  lateFeeRules: lateFeeRulesSchema.default([]),
  autoSendMode: z.enum(["default", "off", "custom"]),
  autoSendSchedule: sendScheduleSchema.nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.lateFeeMode === "custom" && !v.lateFeeRules.length) ctx.addIssue({ code: "custom", path: ["lateFeeRules"], message: "Add at least one late fee step, or pick another option" });
  if (v.autoSendMode === "custom" && !v.autoSendSchedule) ctx.addIssue({ code: "custom", path: ["autoSendSchedule"], message: "Pick when to send" });
});
