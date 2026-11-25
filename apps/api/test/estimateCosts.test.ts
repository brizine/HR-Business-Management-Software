/**
 * "Our cost" on open estimates follows the service's products: lines that took the cost from the
 * service update when a product cost, rate or mix changes; typed-in costs and accepted or declined
 * estimates keep theirs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@est-costs.test`;
let app: FastifyInstance;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}
const line = (costCents: number | null, costAuto: boolean) => ({ serviceTypeId: ID.round, description: "Round 1", quantity: 1, unitPriceCents: 6500, costCents, costAuto });
const costs = async (id: string) => (await call("GET", `/estimates/${id}`, "owner")).body.lines.map((l: any) => [l.costCents, l.costAuto]);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Est Costs Co", firstName: "Eve", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  ID.cust = (await call("POST", "/customers", "owner", { firstName: "Ann", lastName: "Example", email: email("ann") })).body.id;
  ID.prop = (await call("POST", "/properties", "owner", { street: "1 Ann St", lawnSqFt: 10000, billToCustomerId: ID.cust })).body.id;
  const m = (await call("GET", "/chemical-tracking/methods", "owner")).body[0].id;
  // $1.00 an ounce, 0.5 oz per 1,000: $0.50 per 1,000, $5.00 for 10,000 sq ft.
  const p = (await call("POST", "/products", "owner", { name: "Sample Herbicide", useUnit: "ounces liquid", purchaseUnitName: "jug", purchaseUnitSize: 100, rates: [{ name: "Std", amountPer1000: 0.5, applicationMethodId: m }] })).body;
  await call("POST", `/products/${p.id}/costs`, "owner", { costPerPurchaseUnitCents: 10000, effectiveFrom: "2020-01-01" });
  ID.product = p.id; ID.method = m;
  ID.round = (await call("POST", "/service-types", "owner", { name: "Round 1", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000" })).body.id;
  await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", { products: [{ productId: p.id, productRateId: p.rates[0].id }] });
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("estimate costs", () => {
  it("open estimates follow product and mix changes; typed costs and closed estimates don't", async () => {
    const open = (await call("POST", "/estimates", "owner", { customerId: ID.cust, propertyId: ID.prop, title: "Open", lines: [line(500, true), line(777, false)] })).body.id;
    const closed = (await call("POST", "/estimates", "owner", { customerId: ID.cust, propertyId: ID.prop, title: "Accepted", lines: [line(500, true)] })).body.id;
    expect(await costs(open)).toEqual([[500, true], [777, false]]);
    await call("POST", `/estimates/${closed}/send`, "owner", {});
    expect((await call("POST", `/estimates/${closed}/respond`, "owner", { action: "accept" })).status).toBe(200);

    // The product's cost doubles.
    await call("POST", `/products/${ID.product}/costs`, "owner", { costPerPurchaseUnitCents: 20000, effectiveFrom: "2021-01-01" });
    expect(await costs(open)).toEqual([[1000, true], [777, false]]);
    expect(await costs(closed)).toEqual([[500, true]]);

    // A mix is added to the service: $0.30 per 1,000 more.
    const mix = (await call("POST", "/chemical-tracking/mixes", "owner", { name: "Tank", applicationMethodId: ID.method, items: [{ productId: ID.product, ratePer1000: 0.15 }] })).body.id;
    await call("PUT", `/chemical-tracking/services/${ID.round}/mixes`, "owner", { mixes: [{ mixId: mix }] });
    expect(await costs(open)).toEqual([[1300, true], [777, false]]);
  });
});
