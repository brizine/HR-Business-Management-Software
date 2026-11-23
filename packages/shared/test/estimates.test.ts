import { describe, expect, it } from "vitest";
import { estimateLineAmount, estimateResponseSchema, estimateSchema, estimateTotals, lineIncluded, visitsText } from "../src/estimates";

const L = (o: Record<string, unknown>) => ({ quantity: 1, unitPriceCents: 0, ...o });

describe("estimates", () => {
  it("a line is quantity × price × visits", () => {
    expect(estimateLineAmount(L({ quantity: 2, unitPriceCents: 4550, visits: 6 }))).toBe(54600);
    expect(visitsText(L({ quantity: 1, unitPriceCents: 4500, visits: 6 }))).toBe("6 visits × $45.00");
    expect(visitsText(L({ unitPriceCents: 4500 }))).toBe("");
  });

  it("totals count required lines and ticked optional ones (or the customer's choice), then discount and tax", () => {
    const lines = [
      L({ id: "a", unitPriceCents: 10000, visits: 6, taxRate: 0, costCents: 4000, budgetedHours: 0.5 }),
      L({ id: "b", unitPriceCents: 20000, optional: true, selected: true, taxRate: 8.5 }),
      L({ id: "c", unitPriceCents: 5000, optional: true, selected: false }),
    ];
    const t = estimateTotals(lines, 10);
    expect(t.subtotalCents).toBe(80000);
    expect(t.discountCents).toBe(8000);
    // Tax on line b after its share of the discount: 20000 − 2000 = 18000 × 8.5% = 1530.
    expect(t.taxCents).toBe(1530);
    expect(t.totalCents).toBe(73530);
    expect(t.costCents).toBe(24000);
    expect(t.profitCents).toBe(48000);
    expect(t.marginPercent).toBe(66.7);
    expect(t.hours).toBe(3);
    expect(t.optionalCount).toBe(2);
    // The customer ticked only c.
    const chosen = new Set(["c"]);
    expect(lineIncluded(lines[1], chosen)).toBe(false);
    expect(estimateTotals(lines, 0, chosen).subtotalCents).toBe(65000);
  });

  it("needs a customer and a line; the end date can't be before the date", () => {
    expect(estimateSchema.safeParse({ lines: [{ description: "x", quantity: 1, unitPriceCents: 1 }] }).success).toBe(false);
    const ok = estimateSchema.parse({ customerId: "00000000-0000-4000-8000-000000000001", lines: [{ description: " Aeration ", quantity: "1", unitPriceCents: "9500" }] });
    expect(ok.lines[0]).toMatchObject({ description: "Aeration", visits: 1, optional: false, selected: true, incomeAccountCode: "4000" });
    expect(estimateSchema.safeParse({ customerId: "00000000-0000-4000-8000-000000000001", issueDate: "2026-05-02", validUntil: "2026-05-01", lines: [{ description: "x", quantity: 1, unitPriceCents: 1 }] }).success).toBe(false);
  });

  it("asking for changes needs a comment", () => {
    expect(estimateResponseSchema.safeParse({ action: "changes" }).success).toBe(false);
    expect(estimateResponseSchema.parse({ action: "accept", name: "Ann Apple" })).toMatchObject({ action: "accept", selectedLineIds: [] });
  });
});
