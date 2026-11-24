/**
 * The tech's chemicals step: products prefilled from the service with how they're usually applied
 * (a Spray Mix sheet), rates from the sheet's linked rows, products marked not used, spot
 * treatments added, and the area / site; all of it on the chemical record.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { flushWeather } from "../src/lib/weather";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@techchem.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}
const workOrder = (serviceId: string) => ({
  title: "Round", customerId: ID.jane, propertyId: ID.janeProp, date: today, startTime: "08:00",
  lines: [{ serviceTypeId: serviceId, description: "Round", quantity: 1, unitPriceCents: 6500 }], assigneeIds: [ID.tech],
});
const recordFor = async (wo: string) => {
  const [r] = (await call("GET", `/chemical-records?visitId=${wo}`, "owner")).body;
  return (await call("GET", `/chemical-records/${r.id}`, "owner")).body;
};

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Tech Chem Co", firstName: "Tia", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  ID.tech = (await call("POST", "/employees", "owner", { firstName: "tech", lastName: "Person", email: email("tech"), password: "password123", role: "employee" })).body.id;
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
  T.other = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Other Co", firstName: "Oz", lastName: "Other", email: email("other"), password: "password123" } })).json().token;
  await call("POST", "/crm/sample-customers", "owner", {});
  ID.jane = (await call("GET", "/customers?q=jane", "owner")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "owner")).body.properties[0].id;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  await call("PUT", "/weather/settings", "owner", { mode: "off" });

  const pre = (await call("POST", "/products", "owner", { name: "Sample Pre-Emergent", productType: "herbicide", epaRegNo: "0000-1", useUnit: "ounces liquid", rates: [{ name: "High", amountPer1000: 0.57, method: "truck_spray", carrierGalPer1000: 2 }] })).body;
  const fert = (await call("POST", "/products", "owner", { name: "Sample Fertilizer", productType: "fertilizer", useUnit: "pounds dry", trackRecords: true, rates: [{ name: "Spring", amountPer1000: 3, method: "push_spreader" }] })).body;
  const spot = (await call("POST", "/products", "owner", { name: "Sample Spot Herbicide", productType: "herbicide", epaRegNo: "0000-2", useUnit: "ounces liquid", rates: [{ name: "Spot", amountPer1000: 1.5, method: "backpack", carrierGalPer1000: 1 }] })).body;
  ID.pre = pre.id; ID.fert = fert.id; ID.spot = spot.id;
  ID.other = (await call("POST", "/products", "other", { name: "Theirs", useUnit: "ounces liquid" })).body.id;

  // Spray Mix sheets: Truck 2 gal/1,000 (87.12 gal/acre) and Backpack 1 gal/1,000 (43.56).
  ID.truck = (await call("POST", "/spray-mixes", "owner", { name: "Truck 2gal/1000ft", gallonsPerAcre: 87.12, defaultTankGallons: 75 })).body.id;
  ID.pack = (await call("POST", "/spray-mixes", "owner", { name: "Backpack 1gal/1000ft", gallonsPerAcre: 43.56, defaultTankGallons: 4 })).body.id;
  const truckRow = (await call("POST", `/spray-mixes/${ID.truck}/products`, "owner", { name: "Pre-Emergent", ratePerAcre: 26.136, unit: "ounces liquid" })).body;
  const packRow = (await call("POST", `/spray-mixes/${ID.pack}/products`, "owner", { name: "Pre-Emergent", ratePerAcre: 30.492, unit: "ounces liquid" })).body;
  expect((await call("PUT", `/spray-mixes/products/${truckRow.id}/catalog`, "owner", { catalogId: pre.id })).status).toBe(200);
  expect((await call("PUT", `/spray-mixes/products/${packRow.id}/catalog`, "owner", { catalogId: pre.id })).status).toBe(200);
  expect((await call("PUT", `/spray-mixes/products/${packRow.id}/catalog`, "other", { catalogId: pre.id })).status).toBe(404);

  ID.round = (await call("POST", "/service-types", "owner", { name: "Round 1", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000", chemical: true, applicationSite: "Turf – front and back lawn" })).body.id;
  await call("PUT", `/service-types/${ID.round}/products`, "owner", { products: [{ productId: pre.id, productRateId: pre.rates[0].id }, { productId: fert.id, productRateId: fert.rates[0].id }] });
  ID.mow = (await call("POST", "/service-types", "owner", { name: "Mowing", pricing: "flat", priceCents: 4000, incomeAccountCode: "4000" })).body.id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("the tech's chemicals step", () => {
  it("prefills the service's products with the matching Spray Mix sheet and its linked rate", async () => {
    ID.wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    const o = (await call("GET", `/visits/${ID.wo}/chemicals`, "tech")).body;
    expect(o.chemical).toBe(true);
    expect(o.site).toBe("Turf – front and back lawn");
    expect(o.methods.map((m: any) => m.name)).toEqual(["Truck 2gal/1000ft", "Backpack 1gal/1000ft", "Spreader (not mixed)"]);
    const lawn = o.areaSqFt;
    expect(o.items.map((i: any) => [i.productName, i.methodId, Math.round(i.ratePer1000 * 1000) / 1000])).toEqual([
      ["Sample Pre-Emergent", ID.truck, 0.6], // 26.136 oz/acre on the truck sheet
      ["Sample Fertilizer", "dry", 3],
    ]);
    expect(o.items[0].amount).toBeCloseTo((0.6 * lawn) / 1000, 6);
    const pre = o.products.find((p: any) => p.id === ID.pre);
    expect(pre.bySheet[ID.pack]).toBeCloseTo(0.7, 6); // 30.492 oz/acre on the backpack sheet
    expect(o.products.some((p: any) => p.id === ID.other)).toBe(false);
    expect(JSON.stringify(o)).not.toMatch(/cost/i);
  });

  it("records what the tech confirmed: method, rate, amount, not-used and added products, area and site", async () => {
    await call("POST", `/visits/${ID.wo}/start`, "tech", {});
    const done = await call("POST", `/visits/${ID.wo}/complete`, "tech", {
      notes: "Back lawn locked",
      chemicals: {
        areaSqFt: 6000, site: "Turf – front lawn",
        items: [
          { productId: ID.pre, used: true, methodId: ID.pack, ratePer1000: 0.7, amount: 4.2 },
          { productId: ID.fert, used: false, methodId: "dry", ratePer1000: 3, amount: 18 },
          { productId: ID.spot, used: true, methodId: ID.pack, ratePer1000: 1.5, amount: 0.75 },
        ],
      },
    });
    expect(done.status).toBe(200);
    await flushWeather();
    const r = await recordFor(ID.wo);
    expect(r).toMatchObject({ site: "Turf – front lawn", areaSqFt: 6000, tankMixGal: 6 }); // 1 gal per 1,000 × 6,000
    expect(r.products.map((p: any) => [p.tradeName, p.methodName, p.ratePer1000, p.amount, p.carrierGalPer1000, Math.round(p.dilutionPerGal * 1000) / 1000])).toEqual([
      ["Sample Pre-Emergent", "Backpack 1gal/1000ft", 0.7, 4.2, 1, 0.7],
      ["Sample Spot Herbicide", "Backpack 1gal/1000ft", 1.5, 0.75, 1, 1.5],
    ]);
    const csv = (await call("GET", `/chemical-records/export.csv?from=${today}&to=${today}`, "owner")).body as string;
    expect(csv).toContain("Application method");
    expect(csv).toContain("Backpack 1gal/1000ft");
  });

  it("records dry products as not mixed", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    await call("POST", `/visits/${wo}/start`, "tech", {});
    await call("POST", `/visits/${wo}/complete`, "tech", { chemicals: { items: [{ productId: ID.fert, used: true, methodId: "dry", ratePer1000: 3, amount: 30 }] } });
    const r = await recordFor(wo);
    expect(r.tankMixGal).toBeNull();
    expect(r.products[0]).toMatchObject({ tradeName: "Sample Fertilizer", methodName: "Spreader (not mixed)", dilutionPerGal: null, amount: 30 });
  });

  it("refuses another company's product or a method that isn't a Spray Mix sheet", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    const theirs = await call("POST", `/visits/${wo}/complete`, "tech", { chemicals: { items: [{ productId: ID.other, used: true, methodId: "dry", ratePer1000: 1, amount: 1 }] } });
    expect(theirs.status).toBe(400);
    const noSheet = await call("POST", `/visits/${wo}/complete`, "tech", { chemicals: { items: [{ productId: ID.pre, used: true, methodId: "00000000-0000-4000-8000-000000000000", ratePer1000: 1, amount: 1 }] } });
    expect(noSheet.status).toBe(400);
    expect((await call("GET", `/visits/${wo}`, "owner")).body.status).not.toBe("completed");
  });

  it("without the step (web, older phones) it still records the service's products and their usual method", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    await call("POST", `/visits/${wo}/start`, "tech", {});
    await call("POST", `/visits/${wo}/complete`, "tech", {});
    const r = await recordFor(wo);
    expect(r.products.map((p: any) => [p.tradeName, p.methodName, p.carrierGalPer1000])).toEqual([
      ["Sample Pre-Emergent", "Spray – truck", 2],
      ["Sample Fertilizer", "Spreader – push", null],
    ]);
  });

  it("doesn't ask for chemicals on a work order without chemical services", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.mow))).body.id;
    const o = (await call("GET", `/visits/${wo}/chemicals`, "tech")).body;
    expect(o).toMatchObject({ chemical: false, items: [] });
  });
});
