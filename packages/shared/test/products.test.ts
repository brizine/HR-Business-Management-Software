import { describe, expect, it } from "vitest";
import { costOn, costPerUseUnitCents, formatRateAmount, productSchema, rateCostPer1000Cents } from "../src";

describe("product costs", () => {
  const costs = [{ effectiveFrom: "2025-01-15", c: 1 }, { effectiveFrom: "2026-02-01", c: 2 }, { effectiveFrom: "2099-01-01", c: 3 }];

  it("uses the latest cost that has started", () => {
    expect(costOn(costs, "2025-01-14")).toBeNull();
    expect(costOn(costs, "2025-01-15")?.c).toBe(1);
    expect(costOn(costs, "2026-11-24")?.c).toBe(2);
    expect(costOn([...costs].reverse(), "2026-11-24")?.c).toBe(2);
  });

  it("works out cost per use unit and per 1,000 sq ft", () => {
    // A 2.5 gal jug (320 fl oz) at $180 is 56.25¢ per oz; 1.5 oz per 1,000 is 84.375¢.
    const perOz = costPerUseUnitCents(18000, 320);
    expect(perOz).toBe(56.25);
    expect(rateCostPer1000Cents(1.5, perOz)).toBe(84.375);
    expect(costPerUseUnitCents(18000, null)).toBeNull();
    expect(costPerUseUnitCents(null, 320)).toBeNull();
    expect(rateCostPer1000Cents(1.5, null)).toBeNull();
  });

  it("shows rates with short units", () => {
    expect(formatRateAmount(0.0565, "ounces dry")).toBe("0.057 oz dry");
    expect(formatRateAmount(3, "pounds dry")).toBe("3 lb dry");
    expect(formatRateAmount(1.5, "milliliters")).toBe("1.5 mL");
  });

  it("needs a name and a use unit, and empty text becomes null", () => {
    expect(productSchema.safeParse({ name: "X" }).success).toBe(false);
    const p = productSchema.parse({ name: "X", useUnit: "ounces liquid", manufacturer: "  ", epaRegNo: "" });
    expect(p).toMatchObject({ manufacturer: null, epaRegNo: null, productType: "other", trackRecords: true, rates: [] });
  });
});
