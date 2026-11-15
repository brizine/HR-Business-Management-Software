import { describe, expect, it } from "vitest";
import { fuelEconomy, fuelEntrySchema, fuelTotals, fuelUnit, totalCostOfOwnership, type FuelLike } from "../src";

let n = 0;
const fill = (date: string, quantity: number, cost: number, odometer: number | null, more: Partial<FuelLike> = {}): FuelLike =>
  ({ id: `f${++n}`, date, fuelType: "gasoline", quantity, totalCostCents: cost, odometer, hours: null, fullTank: true, ...more });

describe("fuel", () => {
  it("MPG by the full-tank method; partial fills add up; DEF is left out", () => {
    const a = fill("2026-01-01", 20, 6000, 10000);
    const b = fill("2026-01-08", 10, 3000, 10200, { fullTank: false });
    const def = fill("2026-01-09", 2.5, 1000, 10250, { fuelType: "def" });
    const c = fill("2026-01-15", 15, 4500, 10500);
    const d = fill("2026-01-22", 20, 6200, 10900);
    const e = fuelEconomy([d, c, def, b, a], "odometer");
    // 10000 → 10500 on 25 gal = 20 mpg; 10500 → 10900 on 20 gal = 20 mpg.
    expect(e.distance).toBe(900);
    expect(e.quantity).toBe(45);
    expect(e.perUnit).toBe(20);
    expect(e.byEntry).toEqual({ [c.id]: 20, [d.id]: 20 });
    expect(e.costPerDistanceCents).toBeCloseTo((3000 + 4500 + 6200) / 900);
    expect(e.byEntry[b.id]).toBeUndefined();
  });

  it("restarts after a missing or backwards meter; engine hours for equipment", () => {
    const e = fuelEconomy([fill("2026-01-01", 10, 1, 500), fill("2026-01-02", 10, 1, null), fill("2026-01-03", 10, 1, 600), fill("2026-01-04", 10, 1, 700)], "odometer");
    expect(e.distance).toBe(100);
    const mower = [fill("2026-01-01", 5, 1, null, { hours: 100 }), fill("2026-01-05", 4, 1, null, { hours: 108 })];
    expect(fuelEconomy(mower, "hours").perUnit).toBe(2); // 8 hours on 4 gal: 2 hours per gallon
    expect(fuelEconomy(mower, "odometer").perUnit).toBeNull();
  });

  it("totals, CNG units and validation", () => {
    const t = fuelTotals([fill("2026-01-01", 10, 3000, 1), fill("2026-01-02", 2, 800, 2, { fuelType: "def" }), fill("2026-01-03", 8, 2000, 3, { fuelType: "cng" })]);
    expect(t).toMatchObject({ fills: 3, quantity: 18, defQuantity: 2, costCents: 5800 });
    expect(t.avgPriceCents).toBeCloseTo(5000 / 18);
    expect(fuelUnit("cng")).toBe("GGE");
    expect(fuelUnit("diesel")).toBe("gal");
    expect(fuelEntrySchema.safeParse({ assetId: "00000000-0000-4000-8000-000000000000", date: "2026-01-01", fuelType: "cng", quantity: 12.5, totalCostCents: 3000 }).data?.fullTank).toBe(true);
    expect(fuelEntrySchema.safeParse({ assetId: "00000000-0000-4000-8000-000000000000", date: "2026-01-01", fuelType: "kerosene", quantity: 1, totalCostCents: 1 }).success).toBe(false);
  });

  it("total cost of ownership per mile, hour and year", () => {
    const t = totalCostOfOwnership({ purchasePriceCents: 4_000_000, maintenanceCents: 500_000, fuelCents: 1_500_000, odometer: 70000, engineHours: 0, purchaseOdometer: 10000, purchaseHours: null, purchaseDate: "2024-01-01" }, "2026-01-01");
    expect(t.totalCents).toBe(6_000_000);
    expect(t.miles).toBe(60000);
    expect(t.perMileCents).toBe(100);
    expect(t.operatingPerMileCents).toBeCloseTo(2_000_000 / 60000);
    expect(t.perHourCents).toBeNull();
    expect(Math.round(t.perYearCents! / 10_000)).toBe(300); // about $30,000 a year over 2 years
  });
});
