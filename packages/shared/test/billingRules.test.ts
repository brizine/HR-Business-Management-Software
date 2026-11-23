import { describe, expect, it } from "vitest";
import { invoiceTotals } from "../src/billing";
import { describeSchedule, dueLateFeeRules, effectiveLateFeeRules, effectiveSchedule, lateFeeAmount, lateFeeRulesSchema, sendsOn, type SendSchedule } from "../src/billingRules";

const S = (o: Partial<SendSchedule>): SendSchedule => ({ frequency: "weekly", weekdaysOnly: false, days: [1], monthMode: "day", monthDay: 1, nth: 1, weekday: 1, ...o });

describe("late fees", () => {
  const rules = [{ days: 30, kind: "amount" as const, value: 1500 }, { days: 60, kind: "percent" as const, value: 1.5 }, { days: 90, kind: "amount" as const, value: 1500 }];
  it("each step works from the original total (no compounding)", () => {
    expect(lateFeeAmount(rules[0], 20000)).toBe(1500);
    expect(lateFeeAmount(rules[1], 20000)).toBe(300);
    expect(lateFeeAmount(rules[1], 33333)).toBe(500);
  });
  it("steps come due on the invoice date + days, once each", () => {
    expect(dueLateFeeRules(rules, "2026-01-01", "2026-01-30", [])).toEqual([]);
    expect(dueLateFeeRules(rules, "2026-01-01", "2026-01-31", []).map((r) => r.days)).toEqual([30]);
    expect(dueLateFeeRules(rules, "2026-01-01", "2026-04-15", [30]).map((r) => r.days)).toEqual([60, 90]);
  });
  it("the customer's choice: company default (if on), none, or their own", () => {
    const company = { enabled: true, rules, emailCustomer: true };
    expect(effectiveLateFeeRules(company, "default", null)).toBe(rules);
    expect(effectiveLateFeeRules({ ...company, enabled: false }, "default", null)).toEqual([]);
    expect(effectiveLateFeeRules(company, "none", null)).toEqual([]);
    expect(effectiveLateFeeRules(company, "custom", [rules[2]])).toEqual([rules[2]]);
  });
  it("rules: different days, sane values", () => {
    expect(lateFeeRulesSchema.safeParse([{ days: 30, kind: "amount", value: 100 }, { days: 30, kind: "percent", value: 1 }]).success).toBe(false);
    expect(lateFeeRulesSchema.safeParse([{ days: 30, kind: "percent", value: 150 }]).success).toBe(false);
    expect(lateFeeRulesSchema.safeParse([{ days: 30, kind: "amount", value: 12.5 }]).success).toBe(false);
  });
  it("a late fee line isn't discounted or taxed", () => {
    const t = invoiceTotals([{ quantity: 1, unitPriceCents: 10000, taxRate: 8 }, { quantity: 1, unitPriceCents: 1500, isLateFee: true }], "percent", 10);
    expect(t).toEqual({ subtotalCents: 11500, discountCents: 1000, taxCents: 720, totalCents: 11220 });
  });
});

describe("auto-send schedules", () => {
  it("daily and weekdays", () => {
    expect(sendsOn(S({ frequency: "daily" }), "2026-11-22")).toBe(true);
    expect(sendsOn(S({ frequency: "daily", weekdaysOnly: true }), "2026-11-22")).toBe(false); // Sunday
    expect(sendsOn(S({ frequency: "daily", weekdaysOnly: true }), "2026-11-23")).toBe(true);
  });
  it("weekly on chosen days", () => {
    expect(sendsOn(S({ days: [1, 4] }), "2026-11-26")).toBe(true); // Thursday
    expect(sendsOn(S({ days: [1, 4] }), "2026-11-25")).toBe(false);
  });
  it("monthly on a date (short months use the last day) or the nth weekday", () => {
    expect(sendsOn(S({ frequency: "monthly", monthDay: 31 }), "2026-11-30")).toBe(true);
    expect(sendsOn(S({ frequency: "monthly", monthDay: 0 }), "2026-02-28")).toBe(true);
    expect(sendsOn(S({ frequency: "monthly", monthDay: 15 }), "2026-11-15")).toBe(true);
    expect(sendsOn(S({ frequency: "monthly", monthMode: "weekday", nth: 1, weekday: 1 }), "2026-11-02")).toBe(true);
    expect(sendsOn(S({ frequency: "monthly", monthMode: "weekday", nth: 1, weekday: 1 }), "2026-11-09")).toBe(false);
    expect(sendsOn(S({ frequency: "monthly", monthMode: "weekday", nth: 5, weekday: 1 }), "2026-11-30")).toBe(true);
    expect(sendsOn(S({ frequency: "monthly", monthMode: "weekday", nth: 5, weekday: 1 }), "2026-11-23")).toBe(false);
  });
  it("describes and resolves", () => {
    expect(describeSchedule(S({ days: [4, 1] }))).toBe("Every Monday and Thursday");
    expect(describeSchedule(S({ frequency: "monthly", monthMode: "weekday", nth: 5, weekday: 5 }))).toBe("Monthly on the last Friday");
    expect(describeSchedule(S({ frequency: "monthly", monthDay: 22 }))).toBe("Monthly on the 22nd");
    const company = { enabled: false, schedule: S({}), hour: 8, invoiceWorkOrders: true };
    expect(effectiveSchedule(company, "default", null)).toBeNull();
    expect(effectiveSchedule({ ...company, enabled: true }, "default", null)).toEqual(S({}));
    expect(effectiveSchedule({ ...company, enabled: true }, "off", null)).toBeNull();
    expect(effectiveSchedule(company, "custom", S({ frequency: "daily" }))?.frequency).toBe("daily");
  });
});
