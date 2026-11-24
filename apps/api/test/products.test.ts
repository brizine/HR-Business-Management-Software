/** Products: the catalog of chemicals and fertilizers, their named rates, cost history and permissions. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@products.test`;
const T: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Products Co", firstName: "Pat", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  // A second company, to check products stay with their own company.
  T.other = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Other Co", firstName: "Oz", lastName: "Other", email: email("other"), password: "password123" } })).json().token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const celsius = {
  name: "Testweed WG", manufacturer: "Acme Turf", productType: "herbicide", formulation: "wg",
  activeIngredients: [{ name: "Ingredient A", percent: 10 }, { name: "Ingredient B", percent: 2 }],
  epaRegNo: "0000-1111", signalWord: "caution", reiHours: 12, targets: "Broadleaf weeds",
  useUnit: "ounces dry", purchaseUnitName: "10 oz bottle", purchaseUnitSize: 10, labelMaxPer1000: 0.085,
  rates: [
    { name: "Medium", amountPer1000: 0.057, method: "truck_spray", carrierGalPer1000: 2 },
    { name: "High", amountPer1000: 0.085, method: "truck_spray", carrierGalPer1000: 2 },
  ],
};

describe("products", () => {
  let id = "";

  it("is Chemical Tracking only: admins, and the people they add", async () => {
    // A manager isn't in until an admin adds them; only admins change the list.
    expect((await call("GET", "/products", "office")).status).toBe(403);
    expect((await call("GET", "/auth/me", "office")).body.access.chemicalTracking).toBe(false);
    expect((await call("GET", "/auth/me", "owner")).body.access.chemicalTracking).toBe(true);
    const people = (await call("GET", "/chemical-tracking/access", "owner")).body.people as { id: string; name: string; access: boolean; admin: boolean }[];
    const office = people.find((p) => p.name === "office Person")!;
    const tech = people.find((p) => p.name === "tech Person")!;
    expect(people.find((p) => p.admin)?.access).toBe(true);
    expect(office.access).toBe(false);
    expect((await call("PUT", `/chemical-tracking/access/${office.id}`, "owner")).status).toBe(200);
    expect((await call("GET", "/auth/me", "office")).body.access.chemicalTracking).toBe(true);
    expect((await call("PUT", `/chemical-tracking/access/${tech.id}`, "office")).status).toBe(403);
    expect((await call("GET", "/products", "tech")).status).toBe(403);
    expect((await call("GET", "/chemical-tracking/methods", "tech")).status).toBe(403);
    // The other company can't add someone from this one.
    expect((await call("PUT", `/chemical-tracking/access/${tech.id}`, "other")).status).toBe(404);
  });

  it("lets Chemical Tracking users add a product with its rates", async () => {
    const made = await call("POST", "/products", "office", celsius);
    expect(made.status).toBe(200);
    id = made.body.id;
    expect(made.body).toMatchObject({ name: "Testweed WG", epaRegNo: "0000-1111", useUnit: "ounces dry", trackRecords: true, currentCost: null, costPerUseUnitCents: null });
    expect(made.body.rates.map((r: { name: string }) => r.name)).toEqual(["Medium", "High"]);
    expect((await call("GET", "/products", "office")).body.map((p: { name: string }) => p.name)).toEqual(["Testweed WG"]);
    expect((await call("GET", "/products", "other")).body).toEqual([]);
    expect((await call("GET", `/products/${id}`, "other")).status).toBe(404);
  });

  it("refuses rates above the label maximum, and duplicate rate names", async () => {
    expect((await call("POST", "/products", "owner", { ...celsius, rates: [{ name: "Too much", amountPer1000: 0.1 }] })).status).toBe(400);
    expect((await call("POST", "/products", "owner", { ...celsius, rates: [{ name: "High", amountPer1000: 0.05 }, { name: "high", amountPer1000: 0.06 }] })).status).toBe(400);
  });

  it("keeps rate ids when editing, adds new ones and drops removed ones", async () => {
    const before = (await call("GET", `/products/${id}`, "office")).body;
    const [medium, high] = before.rates;
    const edited = await call("PUT", `/products/${id}`, "owner", {
      ...celsius,
      rates: [{ ...high, amountPer1000: 0.08 }, { name: "Spot", amountPer1000: 0.03, method: "backpack", carrierGalPer1000: null }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.rates.map((r: { id: string; name: string; amountPer1000: number }) => [r.name, r.amountPer1000])).toEqual([["High", 0.08], ["Spot", 0.03]]);
    expect(edited.body.rates[0].id).toBe(high.id);
    expect(edited.body.rates.some((r: { id: string }) => r.id === medium.id)).toBe(false);
  });

  it("keeps cost history and uses the cost in force today", async () => {
    await call("POST", `/products/${id}/costs`, "owner", { costPerPurchaseUnitCents: 32000, vendor: "SiteOne", effectiveFrom: "2025-01-15" });
    const later = await call("POST", `/products/${id}/costs`, "owner", { costPerPurchaseUnitCents: 35000, vendor: "SiteOne", effectiveFrom: "2026-02-01" });
    expect(later.body.currentCost).toMatchObject({ costPerPurchaseUnitCents: 35000, effectiveFrom: "2026-02-01" });
    expect(later.body.costPerUseUnitCents).toBe(3500); // $350 per 10 oz bottle = $35.00 per oz
    const future = await call("POST", `/products/${id}/costs`, "owner", { costPerPurchaseUnitCents: 99900, effectiveFrom: "2099-01-01" });
    expect(future.body.currentCost.costPerPurchaseUnitCents).toBe(35000);
    expect(future.body.costs.map((c: { effectiveFrom: string }) => c.effectiveFrom)).toEqual(["2099-01-01", "2026-02-01", "2025-01-15"]);
    const wrong = future.body.costs[0];
    expect((await call("DELETE", `/products/${id}/costs/${wrong.id}`, "tech")).status).toBe(403);
    expect((await call("DELETE", `/products/${id}/costs/${wrong.id}`, "owner")).body.costs).toHaveLength(2);
    expect((await call("POST", `/products/${id}/costs`, "owner", { costPerPurchaseUnitCents: 100, effectiveFrom: "Feb 1" })).status).toBe(400);
  });

  it("hides inactive products unless asked, and finds by name, maker or EPA number", async () => {
    await call("POST", "/products", "owner", { name: "Old Fert 10-10-10", productType: "fertilizer", useUnit: "pounds dry", active: false });
    expect((await call("GET", "/products", "office")).body).toHaveLength(1);
    expect((await call("GET", "/products?all=1", "office")).body).toHaveLength(2);
    expect((await call("GET", "/products?q=0000-11", "office")).body[0].name).toBe("Testweed WG");
    expect((await call("GET", "/products?q=acme", "office")).body).toHaveLength(1);
    expect((await call("GET", "/products?q=100%25", "office")).body).toHaveLength(0);
  });
});
