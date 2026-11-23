import { describe, expect, it } from "vitest";
import {
  billingSettingsSchema, customerSchema, formatTaxRate, invoiceLineSchema, invoiceTotals, lineTaxRate, propertySchema, serviceTypeSchema,
  taxBreakdown, taxFor, taxRateFor, visitLineSchema,
} from "../src";

describe("sales tax", () => {
  it("is off until turned on, and a rate takes up to 3 decimals", () => {
    const s = billingSettingsSchema.parse({ nextInvoiceNumber: 1001, termsDays: 0 });
    expect(s).toMatchObject({ taxEnabled: false, taxName: "Sales tax", defaultTaxRate: 0 });
    expect(billingSettingsSchema.safeParse({ nextInvoiceNumber: 1001, termsDays: 0, defaultTaxRate: 8.6255 }).success).toBe(false);
    expect(billingSettingsSchema.safeParse({ nextInvoiceNumber: 1001, termsDays: 0, defaultTaxRate: 31 }).success).toBe(false);
    expect(billingSettingsSchema.parse({ nextInvoiceNumber: 1001, termsDays: 0, defaultTaxRate: "8.625" }).defaultTaxRate).toBe(8.625);
    expect(serviceTypeSchema.parse({ name: "Mulch", priceCents: 500 }).taxable).toBe(false);
    expect(invoiceLineSchema.parse({ description: "Mulch", quantity: 2, unitPriceCents: 500 }).taxRate).toBe(0);
    expect(visitLineSchema.parse({ description: "Mulch", quantity: 2, unitPriceCents: 500, taxRate: "8.5" }).taxRate).toBe(8.5);
    expect(customerSchema.parse({ firstName: "Ann", email: "a@example.com", taxExempt: true, taxRate: "" })).toMatchObject({ taxExempt: true, taxRate: null });
    expect(propertySchema.parse({ street: "1 Elm", taxRate: "9.25" }).taxRate).toBe(9.25);
    expect(formatTaxRate(8.625)).toBe("8.625%");
    expect(formatTaxRate(8.5)).toBe("8.5%");
  });

  it("picks the rate like Homeworks: property, then customer, then the default; exempt and off mean none", () => {
    const settings = { taxEnabled: true, defaultTaxRate: 8.5 };
    expect(taxRateFor({ settings })).toBe(8.5);
    expect(taxRateFor({ settings, customer: { taxRate: 9 } })).toBe(9);
    expect(taxRateFor({ settings, customer: { taxRate: 9 }, property: { taxRate: 9.25 } })).toBe(9.25);
    expect(taxRateFor({ settings, customer: { taxExempt: true }, property: { taxRate: 9.25 } })).toBe(0);
    expect(taxRateFor({ settings: { taxEnabled: false, defaultTaxRate: 8.5 } })).toBe(0);
    expect(lineTaxRate(true, 8.5)).toBe(8.5);
    expect(lineTaxRate(false, 8.5)).toBe(0);
  });

  it("adds up each line's tax and rounds once, like Bigcapital", () => {
    // $65 at 8.625% is $5.60625; two of them $11.2125 → $11.21 (rounding each line would give $11.22).
    const lines = [{ quantity: 1, unitPriceCents: 6500, taxRate: 8.625 }, { quantity: 1, unitPriceCents: 6500, taxRate: 8.625 }, { quantity: 1, unitPriceCents: 4000 }];
    expect(taxFor(lines)).toBe(1121);
    expect(invoiceTotals(lines, "none", 0)).toEqual({ subtotalCents: 17000, discountCents: 0, taxCents: 1121, totalCents: 18121 });
    // No tax anywhere: the same totals as before.
    expect(invoiceTotals([{ quantity: 2, unitPriceCents: 1500 }], "none", 0)).toEqual({ subtotalCents: 3000, discountCents: 0, taxCents: 0, totalCents: 3000 });
  });

  it("charges tax on what's paid after a discount, spread across the lines", () => {
    // $100 taxed at 10% + $100 untaxed, $20 off: each line takes $10 of it; tax is 10% of $90.
    const t = invoiceTotals([{ quantity: 1, unitPriceCents: 10000, taxRate: 10 }, { quantity: 1, unitPriceCents: 10000 }], "amount", 2000);
    expect(t).toEqual({ subtotalCents: 20000, discountCents: 2000, taxCents: 900, totalCents: 18900 });
    expect(invoiceTotals([{ quantity: 1, unitPriceCents: 10000, taxRate: 10 }], "percent", 50).taxCents).toBe(500);
  });

  it("breaks tax down by rate for the invoice and the report", () => {
    const b = taxBreakdown([
      { quantity: 1, unitPriceCents: 6500, taxRate: 8.625 }, { quantity: 2, unitPriceCents: 1000, taxRate: 4.5 },
      { quantity: 1, unitPriceCents: 4000, taxRate: 0 }, { quantity: 1, unitPriceCents: 3500, taxRate: 8.625 },
    ]);
    expect(b).toEqual({ untaxedCents: 4000, rates: [{ rate: 4.5, taxableCents: 2000, taxCents: 90 }, { rate: 8.625, taxableCents: 10000, taxCents: 863 }] });
  });
});
