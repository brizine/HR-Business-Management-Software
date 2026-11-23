import { describe, expect, it } from "vitest";
import { depositCents, depositRuleFor, describeDepositRule, estimateDepositSettingsSchema, estimateSchema } from "../src";

const company = { requireFor: "new" as const, minTotalCents: 50000, kind: "percent" as const, value: 25 };

describe("estimate deposits", () => {
  it("company rule: who needs one, from what total, and how much", () => {
    const rule = depositRuleFor(company, { depositMode: "default" }, true)!;
    expect(rule).toEqual({ kind: "percent", value: 25, minTotalCents: 50000 });
    expect(depositCents(rule, 80000)).toBe(20000);
    // Under the threshold: none.
    expect(depositCents(rule, 49999)).toBe(0);
    // Not a new customer.
    expect(depositRuleFor(company, { depositMode: "default" }, false)).toBeNull();
    expect(depositRuleFor({ ...company, requireFor: "all" }, { depositMode: "default" }, false)).not.toBeNull();
    expect(depositRuleFor({ ...company, requireFor: "none" }, { depositMode: "default" }, true)).toBeNull();
  });

  it("an estimate can need none or have its own (no threshold); an amount never tops the total", () => {
    expect(depositRuleFor(company, { depositMode: "none" }, true)).toBeNull();
    const own = depositRuleFor(company, { depositMode: "custom", depositKind: "amount", depositValue: 15000 }, false)!;
    expect(depositCents(own, 10000)).toBe(10000);
    expect(depositCents(own, 40000)).toBe(15000);
    expect(depositCents(own, 0)).toBe(0);
    expect(describeDepositRule(own)).toBe("$150.00");
    expect(describeDepositRule(company)).toBe("25% of the accepted total, on estimates of $500.00 or more");
  });

  it("checks the settings and the estimate's own amount", () => {
    expect(estimateDepositSettingsSchema.safeParse({ requireFor: "all", kind: "percent", value: 0 }).success).toBe(false);
    expect(estimateDepositSettingsSchema.safeParse({ requireFor: "all", kind: "percent", value: 120 }).success).toBe(false);
    expect(estimateDepositSettingsSchema.parse({ requireFor: "none" })).toMatchObject({ requireFor: "none", value: 0 });
    const base = { customerId: "8b0c5a3e-2f6b-4b7a-9d55-1c2e3f4a5b6c", lines: [{ description: "Aeration", quantity: 1, unitPriceCents: 10000 }] };
    expect(estimateSchema.safeParse({ ...base, depositMode: "custom" }).success).toBe(false);
    expect(estimateSchema.parse({ ...base, depositMode: "custom", depositKind: "percent", depositValue: 30 })).toMatchObject({ depositMode: "custom", depositValue: 30 });
    expect(estimateSchema.parse(base).depositMode).toBe("default");
  });
});
