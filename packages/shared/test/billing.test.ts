import { describe, expect, it } from "vitest";
import { describePricing, formatMoney, invoiceSchema, invoiceTotals, isOverdue, priceFor, serviceTypeSchema, invoiceBalance, creditSchema, billingSettingsSchema, prepayTotals, prepaySplit, prepaymentSchema, splitIncome } from "../src/billing";

describe("price list", () => {
  it("prices flat, per 1,000 sq ft (with a minimum) and by lawn size", () => {
    expect(priceFor({ pricing: "flat", priceCents: 4500, minimumCents: 0, brackets: [] }, null)).toBe(4500);
    const per = { pricing: "per_thousand", priceCents: 425, minimumCents: 4000, brackets: [] };
    expect(priceFor(per, 11000)).toBe(4675);
    expect(priceFor(per, 5000)).toBe(4000);
    expect(priceFor(per, null)).toBeNull();
    const br = { pricing: "bracket", priceCents: 0, minimumCents: 0, brackets: [{ upToSqFt: 5000, priceCents: 4000 }, { upToSqFt: 10000, priceCents: 5500 }, { upToSqFt: null, priceCents: 7000 }] };
    expect([priceFor(br, 5000), priceFor(br, 5001), priceFor(br, 25000)]).toEqual([4000, 5500, 7000]);
    expect(priceFor({ ...br, brackets: br.brackets.slice(0, 2) }, 25000)).toBeNull();
    expect(describePricing(per)).toBe("$4.25 per 1,000 sq ft (min $40.00)");
    expect(describePricing(br)).toBe("up to 5,000 sq ft $40.00 · up to 10,000 sq ft $55.00 · larger $70.00");
  });

  it("checks brackets go up, with only the last open-ended", () => {
    const bad = serviceTypeSchema.safeParse({ name: "X", pricing: "bracket", brackets: [{ upToSqFt: null, priceCents: 1 }, { upToSqFt: 5000, priceCents: 2 }] });
    expect(bad.success).toBe(false);
    expect(serviceTypeSchema.safeParse({ name: "X", pricing: "bracket", brackets: [] }).success).toBe(false);
  });
});

describe("invoices", () => {
  it("adds up lines and caps the discount at the subtotal", () => {
    const lines = [{ quantity: 1, unitPriceCents: 4675 }, { quantity: 1.5, unitPriceCents: 3333 }];
    expect(invoiceTotals(lines, "none", 0)).toEqual({ subtotalCents: 9675, discountCents: 0, totalCents: 9675 });
    expect(invoiceTotals(lines, "percent", 10)).toEqual({ subtotalCents: 9675, discountCents: 968, totalCents: 8707 });
    expect(invoiceTotals(lines, "amount", 50000).totalCents).toBe(0);
    expect(formatMoney(123456)).toBe("$1,234.56");
  });

  it("validates dates, lines and discounts; works out overdue", () => {
    const ok = { customerId: "00000000-0000-4000-8000-000000000000", lines: [{ description: "Round 1", quantity: 1, unitPriceCents: 4500 }] };
    expect(invoiceSchema.safeParse(ok).success).toBe(true);
    expect(invoiceSchema.safeParse({ ...ok, lines: [] }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...ok, discountKind: "percent", discountValue: 120 }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...ok, issueDate: "2026-03-10", dueDate: "2026-03-01" }).success).toBe(false);
    expect(isOverdue({ status: "sent", dueDate: "2026-03-01" }, "2026-03-02")).toBe(true);
    expect(isOverdue({ status: "paid", dueDate: "2026-03-01" }, "2026-03-02")).toBe(false);
  });
});

describe("credits", () => {
  it("what's owed is the total less payments and credits", () => {
    expect(invoiceBalance({ totalCents: 8500, paidCents: 3000, creditedCents: 2000 })).toBe(3500);
    expect(invoiceBalance({ totalCents: 8500, paidCents: 0 })).toBe(8500);
  });
  it("a credit needs an amount and a description the customer sees; it's used on open invoices unless told otherwise", () => {
    const base = { customerId: "11111111-1111-4111-8111-111111111111", reason: "goodwill" as const, description: "Thanks for your patience" };
    expect(creditSchema.parse({ ...base, amountCents: 2000 }).applyTo).toBe("open");
    expect(creditSchema.parse({ ...base, amountCents: 2000, applyTo: "none" }).applyTo).toBe("none");
    expect(creditSchema.safeParse({ ...base, amountCents: 0 }).success).toBe(false);
    expect(creditSchema.safeParse({ ...base, amountCents: 100, description: " " }).success).toBe(false);
    expect(creditSchema.safeParse({ ...base, amountCents: 100, applyTo: "someday" }).success).toBe(false);
  });
  it("using credit automatically is on unless turned off", () => {
    expect(billingSettingsSchema.parse({ nextInvoiceNumber: 1001, termsDays: 0 }).autoApplyCredits).toBe(true);
  });
});

describe("prepayments", () => {
  it("works out the discount (percent or dollars) and what the customer pays", () => {
    expect(prepayTotals(50000, "percent", 5)).toEqual({ coversCents: 50000, discountCents: 2500, amountCents: 47500 });
    expect(prepayTotals(29750, "percent", 5)).toEqual({ coversCents: 29750, discountCents: 1488, amountCents: 28262 });
    expect(prepayTotals(18500, "amount", 1500)).toEqual({ coversCents: 18500, discountCents: 1500, amountCents: 17000 });
    expect(prepayTotals(10000, "none", 0).amountCents).toBe(10000);
  });
  it("splits a payment between cash and discount in the prepayment's proportions, never more than is left", () => {
    expect(prepaySplit(10000, 47500, 2500)).toEqual({ cashCents: 9500, discountCents: 500 });
    expect(prepaySplit(45000, 38000, 2000)).toEqual({ cashCents: 38000, discountCents: 2000 });
    expect(prepaySplit(7000, 9500, 0)).toEqual({ cashCents: 7000, discountCents: 0 });
    expect(prepaySplit(0, 100, 10)).toEqual({ cashCents: 0, discountCents: 0 });
  });
  it("checks the prepayment form", () => {
    const base = { customerId: "11111111-1111-4111-8111-111111111111", description: "2027 season", coversCents: 50000, how: "check" as const };
    expect(prepaymentSchema.safeParse(base).success).toBe(true);
    expect(prepaymentSchema.safeParse({ ...base, discountKind: "percent", discountValue: 60 }).success).toBe(false);
    expect(prepaymentSchema.safeParse({ ...base, discountKind: "amount", discountValue: 50000 }).success).toBe(false);
    expect(prepaymentSchema.safeParse({ ...base, description: "" }).success).toBe(false);
  });
});

describe("prepayment income", () => {
  it("splits money received across income accounts by what each is worth, adding up exactly", () => {
    expect(splitIncome(27000, [["4000", 12000], ["4100", 18000]])).toEqual([{ code: "4000", cents: 10800 }, { code: "4100", cents: 16200 }]);
    expect(splitIncome(100, [["4000", 1], ["4100", 1], ["4200", 1]]).reduce((s, p) => s + p.cents, 0)).toBe(100);
    expect(splitIncome(47500, [["4000", 30000], ["4000", 20000]])).toEqual([{ code: "4000", cents: 47500 }]);
    expect(splitIncome(5000, [])).toEqual([{ code: "4000", cents: 5000 }]);
  });
});
