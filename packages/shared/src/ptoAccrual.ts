import type { PtoGrantSchedule, PtoTier } from "./schemas";

/**
 * Time-off accrual rules shared by the API (which applies them) and the web (which describes them).
 * Dates are "YYYY-MM-DD". Years of service count from the hire date.
 */
export interface PtoPolicyLike {
  accrualRate: number;
  annualGrantHours: number;
  grantSchedule: PtoGrantSchedule | string;
  grantDate?: string | null;
  grantDayOfMonth?: number | null;
  tiers?: PtoTier[] | null;
  carryoverLimitHours?: number | null;
  carryoverReset?: string | null;
  carryoverDate?: string | null;
}

const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];
const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** A day that may not exist in that month (Feb 29, the 31st) moves to the month's last day. */
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(Math.min(d, daysIn(y, m)))}`;

/** Whole years worked by `on` (0 without a hire date or before it). */
export function yearsOfService(hireDate: string | null | undefined, on: string) {
  if (!hireDate || hireDate > on) return 0;
  const [hy, hm, hd] = parts(hireDate);
  const [y, m, d] = parts(on);
  return y - hy - (m < hm || (m === hm && d < Math.min(hd, daysIn(y, hm))) ? 1 : 0);
}

/** The rate and award size that apply after `years` of service, and which step gave them. */
export function effectivePto(p: PtoPolicyLike, years: number) {
  let accrualRate = p.accrualRate;
  let grantHours = p.annualGrantHours;
  let tier: number | null = null;
  for (const t of [...(p.tiers ?? [])].sort((a, b) => a.afterYears - b.afterYears)) {
    if (years < t.afterYears) break;
    if (t.accrualRate != null) accrualRate = t.accrualRate;
    if (t.grantHours != null) grantHours = t.grantHours;
    tier = t.afterYears;
  }
  return { accrualRate, grantHours, tier };
}

/**
 * The most recent award date on or before `today` for this employee, or null if none applies
 * (no schedule, no hire date for anniversary awards, or before their first anniversary).
 */
export function lastGrantDate(p: PtoPolicyLike, hireDate: string | null | undefined, today: string): string | null {
  const [y, m, d] = parts(today);
  switch (p.grantSchedule) {
    case "yearly_date": {
      if (!p.grantDate) return null;
      const [gm, gd] = p.grantDate.split("-").map(Number);
      const thisYear = ymd(y, gm, gd);
      return thisYear <= today ? thisYear : ymd(y - 1, gm, gd);
    }
    case "anniversary": {
      if (!hireDate) return null;
      const [, hm, hd] = parts(hireDate);
      const thisYear = ymd(y, hm, hd);
      const last = thisYear <= today ? thisYear : ymd(y - 1, hm, hd);
      return yearsOfService(hireDate, last) >= 1 ? last : null;
    }
    case "monthly": {
      if (!p.grantDayOfMonth) return null;
      const thisMonth = ymd(y, m, p.grantDayOfMonth);
      if (thisMonth <= today) return thisMonth;
      return m === 1 ? ymd(y - 1, 12, p.grantDayOfMonth) : ymd(y, m - 1, p.grantDayOfMonth);
    }
    default:
      return null;
  }
}

/** The most recent policy-year reset on or before `today` (for carryover limits), or null. */
export function lastResetDate(p: PtoPolicyLike, hireDate: string | null | undefined, today: string) {
  if (p.carryoverLimitHours == null) return null;
  return lastGrantDate({ ...p, grantSchedule: p.carryoverReset === "anniversary" ? "anniversary" : "yearly_date", grantDate: p.carryoverDate ?? "01-01" }, hireDate, today);
}

/** Hours to remove at a reset: what's above the limit, keeping hours held by pending requests. */
export function carryoverForfeit(balance: number, pending: number, limit: number) {
  return Math.max(0, Math.round((balance - pending - limit) * 100) / 100);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const perHours = (rate: number) => `1h per ${Math.round((1 / rate) * 100) / 100}h worked`;

/** Plain-English summary of a policy, for the policies list. */
export function describePto(p: PtoPolicyLike & { maxBalanceHours?: number | null }) {
  const parts: string[] = [];
  if (p.accrualRate > 0) parts.push(`Earns ${perHours(p.accrualRate)}`);
  if (p.grantSchedule !== "none" && p.annualGrantHours > 0) {
    const when =
      p.grantSchedule === "yearly_date" && p.grantDate ? `every ${MONTHS[Number(p.grantDate.slice(0, 2)) - 1]} ${Number(p.grantDate.slice(3))}`
      : p.grantSchedule === "anniversary" ? "on each hire anniversary"
      : p.grantSchedule === "monthly" && p.grantDayOfMonth ? `on the ${ordinal(p.grantDayOfMonth)} of every month`
      : "";
    parts.push(`${p.annualGrantHours}h ${when}`);
  }
  if (!parts.length) parts.push("No automatic accrual");
  for (const t of [...(p.tiers ?? [])].sort((a, b) => a.afterYears - b.afterYears)) {
    const bits = [t.accrualRate != null ? (t.accrualRate > 0 ? perHours(t.accrualRate) : "no hourly accrual") : null, t.grantHours != null ? `${t.grantHours}h awards` : null].filter(Boolean);
    if (bits.length) parts.push(`after ${t.afterYears} year${t.afterYears === 1 ? "" : "s"}: ${bits.join(", ")}`);
  }
  if (p.maxBalanceHours != null) parts.push(`cap ${p.maxBalanceHours}h`);
  if (p.carryoverLimitHours != null) {
    const reset = p.carryoverReset === "anniversary" ? "each hire anniversary" : `every ${MONTHS[Number((p.carryoverDate ?? "01-01").slice(0, 2)) - 1]} ${Number((p.carryoverDate ?? "01-01").slice(3))}`;
    parts.push(p.carryoverLimitHours === 0 ? `use it or lose it (resets ${reset})` : `carry over up to ${p.carryoverLimitHours}h (resets ${reset})`);
  }
  return parts.join(" · ");
}
