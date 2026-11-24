/**
 * Products on services: budgeted material per 1,000 sq ft, and what each completed work order applied,
 * saved with the cost in force on its day so a mid-season price change never rewrites past jobs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@svcproducts.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let lawn = 0; // the sample property's lawn, in sq ft
const k = () => lawn / 1000;

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}

const workOrder = (date: string) => ({
  title: "Lawn round", customerId: ID.jane, propertyId: ID.janeProp, date, startTime: "08:00",
  lines: [{ serviceTypeId: ID.round, description: "Lawn round", quantity: 1, unitPriceCents: 6500 }], assigneeIds: [ID.tech],
});

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Svc Products Co", firstName: "Sam", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Svc Products Co", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  // Chemical Tracking: admins always; the office manager is added to the access list.
  const officeId = (await call("GET", "/chemical-tracking/access", "owner")).body.people.find((p: { name: string }) => p.name === "office Person").id;
  await call("PUT", `/chemical-tracking/access/${officeId}`, "owner");
  await call("POST", "/crm/sample-customers", "owner");
  ID.jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "office")).body.properties[0].id;
  await call("PUT", `/properties/${ID.janeProp}`, "office", { ...(await call("GET", `/properties/${ID.janeProp}`, "office")).body, lawnSqFt: 10000 });
  lawn = (await call("GET", `/properties/${ID.janeProp}`, "office")).body.lawnSqFt;

  // Liquid: a 2.5 gal jug holds 320 oz. $160 from Jan 1 (50¢/oz), then $192 from Jun 1 (60¢/oz). 1 oz per 1,000.
  const liquid = (await call("POST", "/products", "owner", { name: "Liquid A", useUnit: "ounces liquid", purchaseUnitName: "2.5 gal jug", purchaseUnitSize: 320, epaRegNo: "0000-1", rates: [{ name: "Standard", amountPer1000: 1 }] })).body;
  ID.liquid = liquid.id; ID.liquidRate = liquid.rates[0].id;
  ID.spring = (await call("POST", `/products/${ID.liquid}/costs`, "owner", { costPerPurchaseUnitCents: 16000, effectiveFrom: "2026-01-01" })).body.costs[0].id;
  await call("POST", `/products/${ID.liquid}/costs`, "owner", { costPerPurchaseUnitCents: 19200, effectiveFrom: "2026-06-01" });
  // Granular, summer only: a 50 lb bag at $25 (50¢/lb), 3 lb per 1,000.
  const granular = (await call("POST", "/products", "owner", { name: "Granular B", useUnit: "pounds dry", purchaseUnitName: "50 lb bag", purchaseUnitSize: 50, rates: [{ name: "Summer", amountPer1000: 3, method: "push_spreader" }] })).body;
  ID.granular = granular.id; ID.granularRate = granular.rates[0].id;
  await call("POST", `/products/${ID.granular}/costs`, "owner", { costPerPurchaseUnitCents: 2500, effectiveFrom: "2026-01-01" });

  ID.round = (await call("POST", "/service-types", "owner", { name: "Lawn round", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000", setupMinutes: 4, minutesPer1000: 3 })).body.id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("products on services", () => {
  it("only Chemical Tracking users set a service's products, and only with the product's own rates", async () => {
    const links = { products: [{ productId: ID.liquid, productRateId: ID.liquidRate }, { productId: ID.granular, productRateId: ID.granularRate, startDate: "2026-06-01", endDate: "2026-09-30" }] };
    expect((await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "tech", links)).status).toBe(403);
    expect((await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", { products: [{ productId: ID.liquid, productRateId: ID.granularRate }] })).status).toBe(400);
    expect((await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", { products: [{ ...links.products[1], startDate: "2026-09-30", endDate: "2026-06-01" }] })).status).toBe(400);
    expect((await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", links)).status).toBe(200);
  });

  it("shows material per 1,000 sq ft from the products that apply today", async () => {
    const svc = (await call("GET", "/service-types", "office")).body.find((s: { id: string }) => s.id === ID.round);
    expect(svc.products.map((p: { productName: string; applies: boolean }) => [p.productName, p.applies])).toEqual([["Liquid A", true], ["Granular B", false]]);
    // Today is after Jun 1 (60¢/oz × 1 oz) and the granular ended Sep 30.
    expect(svc.materialPer1000Cents).toBeCloseTo(60, 6);
    expect(svc.materialMissingCost).toBe(0);
  });

  it("saves what a completed work order applied at the price on its day", async () => {
    ID.springWo = (await call("POST", "/visits", "office", workOrder("2026-04-15"))).body.id;
    ID.summerWo = (await call("POST", "/visits", "office", workOrder("2026-07-15"))).body.id;
    await call("POST", `/visits/${ID.springWo}/complete`, "tech", {});
    await call("POST", `/visits/${ID.summerWo}/complete`, "tech", {});
    const spring = (await call("GET", `/visits/${ID.springWo}/products`, "office")).body;
    expect(lawn).toBeGreaterThan(0);
    expect(spring.map((r: any) => [r.productName, r.areaSqFt, r.amount, r.unit, r.costCents, r.costDate])).toEqual([["Liquid A", lawn, k(), "ounces liquid", Math.round(k() * 50), "2026-04-15"]]);
    const summer = (await call("GET", `/visits/${ID.summerWo}/products`, "office")).body;
    expect(summer.map((r: any) => [r.productName, r.amount, r.costCents])).toEqual([["Liquid A", k(), Math.round(k() * 60)], ["Granular B", 3 * k(), Math.round(3 * k() * 50)]]);
    // The crew sees what was applied, not what it cost.
    const crewView = (await call("GET", `/visits/${ID.summerWo}/products`, "tech")).body;
    expect(crewView[0]).toMatchObject({ productName: "Liquid A", amount: k(), epaRegNo: "0000-1" });
    expect(crewView[0]).not.toHaveProperty("costCents");
  });

  it("keeps past costs when a price changes, a cost is backdated or a jug size is edited", async () => {
    await call("POST", `/products/${ID.liquid}/costs`, "owner", { costPerPurchaseUnitCents: 99900, effectiveFrom: "2026-03-01" });
    const p = (await call("GET", `/products/${ID.liquid}`, "owner")).body;
    await call("PUT", `/products/${ID.liquid}`, "owner", { ...p, purchaseUnitSize: 256 });
    const spring = (await call("GET", `/visits/${ID.springWo}/products`, "office")).body;
    expect(spring[0]).toMatchObject({ costCents: Math.round(k() * 50), costPerUseUnitCents: 50 });
  });

  it("won't remove a cost a work order used, or a rate a service uses", async () => {
    const used = await call("DELETE", `/products/${ID.liquid}/costs/${ID.spring}`, "owner");
    expect(used.status).toBe(400);
    expect(used.body.error).toMatch(/1 completed work order used this cost/);
    const p = (await call("GET", `/products/${ID.liquid}`, "owner")).body;
    const dropRate = await call("PUT", `/products/${ID.liquid}`, "owner", { ...p, rates: [{ name: "Other", amountPer1000: 2 }] });
    expect(dropRate.status).toBe(400);
    expect(dropRate.body.error).toMatch(/Standard rate is used by Lawn round/);
  });

  it("clears the saved products when a work order is reopened", async () => {
    await call("POST", `/visits/${ID.summerWo}/reopen`, "office", {});
    expect((await call("GET", `/visits/${ID.summerWo}/products`, "office")).body).toEqual([]);
  });
});
