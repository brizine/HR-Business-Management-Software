/** Sales tax: off by default; settings, taxable items, exempt customers and rates, invoice totals, work orders, the PDF and the report. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@tax.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, headers: res.headers, raw: res.rawPayload };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Tax Co", firstName: "Tad", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  ID.office = (await call("POST", "/employees", "owner", { firstName: "office", lastName: "Person", email: email("office"), password: "password123", role: "manager" })).body.id;
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

const settings = (over: Record<string, unknown> = {}) => ({ nextInvoiceNumber: 1001, termsDays: 0, footer: "", payableTo: "", autoApplyCredits: true, ...over });

describe("sales tax", () => {
  it("is off by default; admins turn it on with a name and a default rate", async () => {
    expect((await call("GET", "/invoices/settings", "owner")).body).toMatchObject({ taxEnabled: false, taxName: "Sales tax", defaultTaxRate: 0 });
    expect((await call("PUT", "/invoices/settings", "office", settings({ taxEnabled: true }))).status).toBe(403);
    expect((await call("PUT", "/invoices/settings", "owner", settings({ taxEnabled: true, defaultTaxRate: 31 }))).status).toBe(400);
    const on = await call("PUT", "/invoices/settings", "owner", settings({ taxEnabled: true, taxName: "Sales tax", defaultTaxRate: 8.625 }));
    expect(on.body).toMatchObject({ taxEnabled: true, defaultTaxRate: 8.625 });
  });

  it("price-list items are marked taxable; customers can be exempt or have a rate; properties a rate", async () => {
    const mulch = await call("POST", "/service-types", "owner", { name: "Mulch (per bag)", pricing: "flat", priceCents: 650, incomeAccountCode: "4950", taxable: true });
    expect(mulch.body.taxable).toBe(true);
    ID.mulch = mulch.body.id;
    ID.fert = (await call("POST", "/service-types", "owner", { name: "Fertilizer round", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000" })).body.id;
    const hoa = await call("POST", "/customers", "office", { kind: "commercial", companyName: "Elm Park HOA", email: "board@elmpark.example", taxExempt: true, taxExemptNumber: "EX-12345" });
    expect(hoa.body).toMatchObject({ taxExempt: true, taxExemptNumber: "EX-12345", taxRate: null });
    ID.hoa = hoa.body.id;
    const ann = await call("POST", "/customers", "office", { firstName: "Ann", lastName: "Buyer", email: "ann@example.com", taxRate: "9", property: { street: "5 Elm St", city: "Norman", taxRate: "9.25" } });
    expect(ann.body.taxRate).toBe(9);
    ID.ann = ann.body.id;
    ID.annProp = (await call("GET", `/customers/${ID.ann}`, "office")).body.properties[0].id;
    expect((await call("GET", `/properties/${ID.annProp}`, "office")).body.taxRate).toBe(9.25);
    expect((await call("POST", "/customers", "office", { firstName: "X", email: "x@example.com", taxRate: "8.12345" })).status).toBe(400);
  });

  it("an invoice adds each line's tax, rounded once, after the discount", async () => {
    const inv = await call("POST", "/invoices", "office", {
      customerId: ID.ann, propertyId: ID.annProp, issueDate: "2026-11-23", discountKind: "amount", discountValue: 1000,
      lines: [
        { serviceTypeId: ID.mulch, description: "Mulch (per bag)", quantity: 10, unitPriceCents: 650, incomeAccountCode: "4950", taxRate: 9.25 },
        { serviceTypeId: ID.fert, description: "Fertilizer round", quantity: 1, unitPriceCents: 6500, incomeAccountCode: "4000" },
      ],
    });
    expect(inv.status).toBe(200);
    // $65 of mulch + $65 untaxed, $10 off: the mulch takes $5 of it, so tax is 9.25% of $60 = $5.55.
    expect(inv.body).toMatchObject({ subtotalCents: 13000, discountCents: 1000, taxCents: 555, totalCents: 12555 });
    ID.inv = inv.body.id;
    const shown = (await call("GET", `/invoices/${ID.inv}`, "office")).body;
    expect(shown.lines.map((l: any) => l.taxRate)).toEqual([9.25, 0]);
    const pdf = await call("GET", `/invoices/${ID.inv}/pdf`, "office");
    expect(pdf.status).toBe(200);
    expect(String(pdf.headers["content-type"])).toContain("application/pdf");
    // Without tax on any line: no tax, same as before.
    const plain = await call("POST", "/invoices", "office", { customerId: ID.hoa, issueDate: "2026-11-24", lines: [{ description: "Common areas mowing", quantity: 1, unitPriceCents: 40000, incomeAccountCode: "4200" }] });
    expect(plain.body).toMatchObject({ taxCents: 0, totalCents: 40000 });
    ID.plain = plain.body.id;
  });

  it("work orders keep each line's rate, and the invoice made from one keeps it too", async () => {
    const wo = await call("POST", "/visits", "office", {
      title: "Bed refresh", customerId: ID.ann, propertyId: ID.annProp, date: "2026-11-23",
      lines: [{ serviceTypeId: ID.mulch, description: "Mulch (per bag)", quantity: 4, unitPriceCents: 650, taxRate: 9.25 }, { description: "Labor", quantity: 1, unitPriceCents: 5000 }],
    });
    expect(wo.status).toBe(200);
    expect(wo.body.lines.map((l: any) => l.taxRate)).toEqual([9.25, 0]);
    await call("POST", `/visits/${wo.body.id}/complete`, "office", {});
    const made = await call("POST", `/visits/${wo.body.id}/invoice`, "office");
    const inv = (await call("GET", `/invoices/${made.body.invoiceId}`, "office")).body;
    // 9.25% of $26 = $2.405 → $2.41.
    expect(inv).toMatchObject({ subtotalCents: 7600, taxCents: 241, totalCents: 7841 });
    expect(inv.lines.map((l: any) => l.taxRate)).toEqual([9.25, 0]);
  });

  it("the sales tax report adds up taxable, untaxed, exempt and tax by month or quarter", async () => {
    for (const id of [ID.inv, ID.plain]) await call("POST", `/invoices/${id}/send`, "office", { via: ["paper"] });
    const r = (await call("GET", "/invoices/tax-report?from=2026-10-01&to=2026-12-31&by=month", "office")).body;
    expect(r).toMatchObject({ taxEnabled: true, taxName: "Sales tax", by: "month" });
    expect(r.periods.map((p: any) => p.period)).toEqual(["2026-11"]);
    expect(r.total).toMatchObject({ invoices: 2, salesCents: 12000 + 40000, taxableCents: 6000, untaxedCents: 6000 + 40000, exemptCents: 40000, taxCents: 555 });
    expect(r.total.rates).toEqual([{ rate: 9.25, taxableCents: 6000, taxCents: 555 }]);
    // Drafts (the work order's invoice) stay out until sent.
    expect((await call("GET", "/invoices/tax-report?from=2026-10-01&to=2026-12-31&by=quarter", "office")).body.periods.map((p: any) => p.period)).toEqual(["2026 Q4"]);
    expect((await call("GET", "/invoices/tax-report?from=2026-12-31&to=2026-01-01", "office")).status).toBe(400);
  });
});
