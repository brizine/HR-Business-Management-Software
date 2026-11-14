import { describe, expect, it } from "vitest";
import { describeRates, hourlyGrossCents, rateOn, ratesDuring } from "../src";

const hourly = (effectiveDate: string, dollars: number) => ({ effectiveDate, payType: "hourly", payRateCents: dollars * 100 });
/** An 8-hour day starting 8:00 UTC on `date`. */
const day = (date: string, hours = 8) => ({ date, clockIn: `${date}T08:00:00Z`, clockOut: new Date(Date.parse(`${date}T08:00:00Z`) + hours * 3_600_000).toISOString() });
const base = { weeklyThreshold: 40, paidHours: [], holidayWorked: [], holidayMultiplier: 1.5 };

describe("pay rate history", () => {
  const rates = [hourly("2026-01-01", 18), hourly("2026-03-04", 20)];

  it("finds the rate in effect on a day (the first rate covers anything earlier)", () => {
    expect(rateOn(rates, "2026-03-03")?.payRateCents).toBe(1800);
    expect(rateOn(rates, "2026-03-04")?.payRateCents).toBe(2000);
    expect(rateOn(rates, "2025-06-01")?.payRateCents).toBe(1800);
    expect(ratesDuring(rates, "2026-03-01", "2026-03-14").map((r) => r.payRateCents)).toEqual([1800, 2000]);
    expect(ratesDuring(rates, "2026-02-01", "2026-02-14").map((r) => r.payRateCents)).toEqual([1800]);
  });

  it("pays each day at its own rate: a past period keeps the old rate after a raise", () => {
    const feb = [day("2026-02-02"), day("2026-02-03")];
    expect(hourlyGrossCents({ ...base, entries: feb, rates })).toBe(16 * 1800);
    // A raise in the middle of the week (Wed Mar 4): Mon-Tue at $18, Wed-Thu at $20.
    const week = [day("2026-03-02"), day("2026-03-03"), day("2026-03-04"), day("2026-03-05")];
    expect(hourlyGrossCents({ ...base, entries: week, rates })).toBe(16 * 1800 + 16 * 2000);
  });

  it("overtime in a week with two rates uses the weighted average rate (FLSA)", () => {
    // 50 hours: 20 at $18, 30 at $20 -> straight time $960, regular rate $19.20, 10 OT hours x $9.60 = $96.
    const week = [day("2026-03-02", 10), day("2026-03-03", 10), day("2026-03-04", 10), day("2026-03-05", 10), day("2026-03-06", 10)];
    expect(hourlyGrossCents({ ...base, entries: week, rates })).toBe(96_000 + 9_600);
    // One rate: the usual 1.5x.
    expect(hourlyGrossCents({ ...base, entries: week, rates: [hourly("2026-01-01", 20)] })).toBe(40 * 2000 + 10 * 3000);
  });

  it("time off, holidays and the holiday premium use that day's rate", () => {
    const g = hourlyGrossCents({ ...base, entries: [day("2026-03-05")], rates, paidHours: [{ date: "2026-03-02", hours: 8 }], holidayWorked: [{ date: "2026-03-05", hours: 8 }] });
    expect(g).toBe(8 * 2000 + 8 * 1800 + 8 * 0.5 * 2000);
  });

  it("salaried days aren't estimated", () => {
    const salary = [{ effectiveDate: "2026-01-01", payType: "salary", payRateCents: 6_000_000 }];
    expect(hourlyGrossCents({ ...base, entries: [day("2026-03-02")], rates: salary })).toBeNull();
    expect(hourlyGrossCents({ ...base, entries: [], rates: salary })).toBeNull();
    expect(hourlyGrossCents({ ...base, entries: [], rates })).toBe(0);
    // Hourly until a promotion to salary mid-period: only the hourly days count.
    const promo = [hourly("2026-01-01", 20), { effectiveDate: "2026-03-04", payType: "salary", payRateCents: 6_000_000 }];
    expect(hourlyGrossCents({ ...base, entries: [day("2026-03-03"), day("2026-03-04")], rates: promo })).toBe(8 * 2000);
  });

  it("describes a period's rates", () => {
    expect(describeRates([hourly("2026-01-01", 18), hourly("2026-03-04", 20)])).toBe("$18.00/hr, then $20.00/hr from Mar 4");
  });
});
