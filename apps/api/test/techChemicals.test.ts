/**
 * The tech's chemicals step: products prefilled from the service with how they're usually applied
 * (a Chemical Tracking application method) and the product's rate for that method, products marked
 * not used, spot treatments added, and the area / site; all of it on the chemical record. Nothing
 * reads the Spray Mix Calculator, where any tech can change a rate.
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

  // The starting application methods, added the first time Chemical Tracking is opened.
  const methods = (await call("GET", "/chemical-tracking/methods", "owner")).body as { id: string; name: string; galPer1000: number | null }[];
  expect(methods.map((m) => [m.name, m.galPer1000])).toEqual([
    ["Truck 2gal/1000ft", 2], ["Truck 1.5gal/1000ft", 1.5], ["Backpack 1gal/1000ft", 1], ["ZSpray (Green Tips)", 0.2548], ["Spreader (not mixed)", null],
  ]);
  ID.truck = methods[0].id; ID.pack = methods[2].id; ID.dry = methods[4].id;
  expect((await call("GET", "/chemical-tracking/methods", "tech")).status).toBe(403);

  // Each product has a rate for each way it's applied.
  const pre = (await call("POST", "/products", "owner", { name: "Sample Pre-Emergent", productType: "herbicide", epaRegNo: "0000-1", useUnit: "ounces liquid",
    rates: [{ name: "Truck", amountPer1000: 0.6, applicationMethodId: ID.truck }, { name: "Backpack", amountPer1000: 0.7, applicationMethodId: ID.pack }] })).body;
  expect(pre.rates.map((r: any) => [r.name, r.carrierGalPer1000, r.applicationMethodId])).toEqual([["Truck", 2, ID.truck], ["Backpack", 1, ID.pack]]);
  const fert = (await call("POST", "/products", "owner", { name: "Sample Fertilizer", productType: "fertilizer", useUnit: "pounds dry", trackRecords: true, rates: [{ name: "Spring", amountPer1000: 3, applicationMethodId: ID.dry }] })).body;
  const spot = (await call("POST", "/products", "owner", { name: "Sample Spot Herbicide", productType: "herbicide", epaRegNo: "0000-2", useUnit: "ounces liquid", rates: [{ name: "Spot", amountPer1000: 1.5, applicationMethodId: ID.pack }] })).body;
  ID.pre = pre.id; ID.fert = fert.id; ID.spot = spot.id;
  ID.other = (await call("POST", "/products", "other", { name: "Theirs", useUnit: "ounces liquid" })).body.id;
  ID.otherMethod = (await call("GET", "/chemical-tracking/methods", "other")).body[0].id;
  expect((await call("POST", "/products", "owner", { name: "Bad", useUnit: "ounces liquid", rates: [{ name: "X", amountPer1000: 1, applicationMethodId: ID.otherMethod }] })).status).toBe(400);

  // A Spray Mix sheet with a different rate changes nothing here.
  const sheet = (await call("POST", "/spray-mixes", "owner", { name: "Truck 2gal/1000ft", gallonsPerAcre: 87.12, defaultTankGallons: 75 })).body.id;
  await call("POST", `/spray-mixes/${sheet}/products`, "owner", { name: "Sample Pre-Emergent", ratePerAcre: 99, unit: "ounces liquid" });

  ID.round = (await call("POST", "/service-types", "owner", { name: "Round 1", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000", chemical: true })).body.id;
  await call("PUT", `/chemical-tracking/services/${ID.round}`, "owner", { applicationSite: "Turf – front and back lawn" });
  await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", { products: [{ productId: pre.id, productRateId: pre.rates[0].id }, { productId: fert.id, productRateId: fert.rates[0].id }] });
  ID.mow = (await call("POST", "/service-types", "owner", { name: "Mowing", pricing: "flat", priceCents: 4000, incomeAccountCode: "4000" })).body.id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("the tech's chemicals step", () => {
  it("prefills the service's products with their usual method and the rate for it", async () => {
    ID.wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    const o = (await call("GET", `/visits/${ID.wo}/chemicals`, "tech")).body;
    expect(o.chemical).toBe(true);
    expect(o.site).toBe("Turf – front and back lawn");
    expect(o.methods.map((m: any) => m.name)).toEqual(["Truck 2gal/1000ft", "Truck 1.5gal/1000ft", "Backpack 1gal/1000ft", "ZSpray (Green Tips)", "Spreader (not mixed)"]);
    const lawn = o.areaSqFt;
    expect(o.items.map((i: any) => [i.productName, i.methodId, Math.round(i.ratePer1000 * 1000) / 1000])).toEqual([
      ["Sample Pre-Emergent", ID.truck, 0.6], // not the Spray Mix sheet's 99 oz/acre
      ["Sample Fertilizer", ID.dry, 3],
    ]);
    expect(o.items[0].amount).toBeCloseTo((0.6 * lawn) / 1000, 6);
    const pre = o.products.find((p: any) => p.id === ID.pre);
    expect(pre.byMethod[ID.pack]).toBe(0.7);
    expect(pre.byMethod[ID.dry]).toBe(0.6); // no rate for that method: its first rate
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
          { productId: ID.fert, used: false, methodId: ID.dry, ratePer1000: 3, amount: 18 },
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
    await call("POST", `/visits/${wo}/complete`, "tech", { chemicals: { items: [{ productId: ID.fert, used: true, methodId: ID.dry, ratePer1000: 3, amount: 30 }] } });
    const r = await recordFor(wo);
    expect(r.tankMixGal).toBeNull();
    expect(r.products[0]).toMatchObject({ tradeName: "Sample Fertilizer", methodName: "Spreader (not mixed)", dilutionPerGal: null, amount: 30 });
  });

  it("refuses another company's product or method", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    const theirs = await call("POST", `/visits/${wo}/complete`, "tech", { chemicals: { items: [{ productId: ID.other, used: true, methodId: ID.dry, ratePer1000: 1, amount: 1 }] } });
    expect(theirs.status).toBe(400);
    const notOurs = await call("POST", `/visits/${wo}/complete`, "tech", { chemicals: { items: [{ productId: ID.pre, used: true, methodId: ID.otherMethod, ratePer1000: 1, amount: 1 }] } });
    expect(notOurs.status).toBe(400);
    expect((await call("GET", `/visits/${wo}`, "owner")).body.status).not.toBe("completed");
  });

  it("without the step (web, older phones) it still records the service's products and their usual method", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    await call("POST", `/visits/${wo}/start`, "tech", {});
    await call("POST", `/visits/${wo}/complete`, "tech", {});
    const r = await recordFor(wo);
    expect(r.products.map((p: any) => [p.tradeName, p.methodName, p.carrierGalPer1000])).toEqual([
      ["Sample Pre-Emergent", "Truck 2gal/1000ft", 2],
      ["Sample Fertilizer", "Spreader (not mixed)", null],
    ]);
  });

  it("changing a method's spray volume updates its rates; records already made keep theirs", async () => {
    const methods = (await call("GET", "/chemical-tracking/methods", "owner")).body as any[];
    const pack = methods.find((m) => m.id === ID.pack);
    expect(pack.timesUsed).toBeGreaterThan(0);
    expect((await call("DELETE", `/chemical-tracking/methods/${ID.pack}`, "owner")).status).toBe(409);
    expect((await call("PUT", `/chemical-tracking/methods/${ID.pack}`, "owner", { name: "Backpack 1.25gal/1000ft", galPer1000: 1.25, active: true })).status).toBe(200);
    const spot = (await call("GET", `/products/${ID.spot}`, "owner")).body;
    expect(spot.rates[0].carrierGalPer1000).toBe(1.25);
    const r = await recordFor(ID.wo);
    expect(r.products[0]).toMatchObject({ methodName: "Backpack 1gal/1000ft", carrierGalPer1000: 1 });
    // An unused method can be removed; turning one off hides it from techs.
    const zspray = methods.find((m) => m.name === "ZSpray (Green Tips)");
    expect((await call("PUT", `/chemical-tracking/methods/${zspray.id}`, "owner", { name: zspray.name, galPer1000: zspray.galPer1000, active: false })).status).toBe(200);
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.round))).body.id;
    expect((await call("GET", `/visits/${wo}/chemicals`, "tech")).body.methods.map((m: any) => m.name)).not.toContain("ZSpray (Green Tips)");
    expect((await call("DELETE", `/chemical-tracking/methods/${zspray.id}`, "owner")).status).toBe(200);
  });

  it("doesn't ask for chemicals on a work order without chemical services", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.mow))).body.id;
    const o = (await call("GET", `/visits/${wo}/chemicals`, "tech")).body;
    expect(o).toMatchObject({ chemical: false, items: [] });
  });
});
