import { describe, expect, it } from "vitest";
import { cardExpired, cardExpiry, paymentMethodLabel } from "../src/paymentMethods";

describe("saved payment methods", () => {
  it("labels cards and bank accounts", () => {
    expect(paymentMethodLabel({ type: "card", brand: "visa", last4: "4242" })).toBe("Visa ·· 4242");
    expect(paymentMethodLabel({ type: "card", brand: "cartes_bancaires", last4: "1111" })).toBe("Cartes_bancaires ·· 1111");
    expect(paymentMethodLabel({ type: "ach", bankName: "Arvest Bank", accountType: "checking", last4: "6789" })).toBe("Arvest Bank checking ·· 6789");
    expect(paymentMethodLabel({ type: "ach", last4: "1" })).toBe("Bank account ·· 1");
  });
  it("expiry, and expired only after the month ends", () => {
    expect(cardExpiry({ type: "card", expMonth: 4, expYear: 2028 })).toBe("04/28");
    expect(cardExpiry({ type: "ach" })).toBe("");
    expect(cardExpired({ type: "card", expMonth: 11, expYear: 2026 }, "2026-11-30")).toBe(false);
    expect(cardExpired({ type: "card", expMonth: 10, expYear: 2026 }, "2026-11-01")).toBe(true);
    expect(cardExpired({ type: "card", expMonth: 1, expYear: 2027 }, "2026-12-31")).toBe(false);
    expect(cardExpired({ type: "ach" }, "2030-01-01")).toBe(false);
  });
});
