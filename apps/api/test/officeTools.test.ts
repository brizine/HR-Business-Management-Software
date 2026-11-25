/**
 * Chemical Tracking office tools: the load sheet (by tech or truck), after-application notices
 * (email, text, printed or none, per property; off until turned on), and what needs attention.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { setTextingProvider } from "../src/lib/texting";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { flushWeather } from "../src/lib/weather";
import { flushNotices } from "../src/lib/chemicalNotices";

const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@office-tools.test`;
const all: EmailMessage[] = [];
/** Only the notices (sign-up and invite emails go to the same transport). */
const notices = () => all.filter((m) => /lawn was treated/.test(m.subject));
const texts: { to: string; body: string }[] = [];
setTextingProvider({ ready: true, async check() { return { accountName: "test" }; }, async send(_c, to, body) { texts.push({ to, body }); return { id: `t${texts.length}` }; } });

let app: FastifyInstance;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}
const workOrder = (propertyId: string, customerId: string, assignee: string, crewId?: string) => ({
  title: "Round", customerId, propertyId, date: today, startTime: "08:00", ...(crewId ? { crewId } : {}),
  lines: [{ serviceTypeId: ID.round, description: "Round 1", quantity: 1, unitPriceCents: 6500 }], assigneeIds: [assignee],
});
const complete = async (wo: string, who = "leo") => {
  await call("POST", `/visits/${wo}/start`, who, {});
  expect((await call("POST", `/visits/${wo}/complete`, who, {})).status).toBe(200);
  await flushWeather(); await flushNotices();
  return (await call("GET", `/chemical-records?visitId=${wo}`, "owner")).body[0];
};

beforeAll(async () => {
  setEmailTransport({ send: async (m) => { all.push(m); } });
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Office Tools Co", firstName: "Ola", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Office Tools Co", addressLine1: "100 Main St", city: "Norman", state: "OK", zip: "73069", email: "office@office-tools.test", phone: "(405) 555-0100", timezone: "America/Chicago" });
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  await call("PUT", "/weather/settings", "owner", { mode: "off" });
  await call("PUT", "/texting/settings", "owner", { apiKey: "key-123456", fromNumber: "405-555-0188" });
  for (const [who, first] of [["leo", "Leo"], ["ana", "Ana"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: first, lastName: "Tech", email: email(who), password: "password123", role: "employee" })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  ID.mgr = (await call("POST", "/employees", "owner", { firstName: "Max", lastName: "Manager", email: email("mgr"), password: "password123", role: "manager" })).body.id;
  T.mgr = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("mgr"), password: "password123" } })).json().token;

  // Trucks: Truck 1 goes with the crew; Truck 2 is assigned to Ana.
  ID.truck1 = (await call("POST", "/assets", "owner", { name: "Truck 1", type: "Truck" })).body.id;
  ID.truck2 = (await call("POST", "/assets", "owner", { name: "Truck 2", type: "Truck", assignedEmployeeId: ID.ana })).body.id;
  ID.crew = (await call("POST", "/crews", "owner", { name: "Spray A", memberIds: [ID.leo], assetId: ID.truck1 })).body.id;

  const methods = (await call("GET", "/chemical-tracking/methods", "owner")).body as { id: string; name: string }[];
  const m = (n: string) => methods.find((x) => x.name === n)!.id;
  const pre = (await call("POST", "/products", "owner", { name: "Sample Pre-Emergent", productType: "herbicide", epaRegNo: "0000-1", useUnit: "ounces liquid", reiHours: 12,
    customerNote: "Water in within 3 days.", rates: [{ name: "Truck", amountPer1000: 0.5, applicationMethodId: m("Truck 2gal/1000ft") }] })).body;
  const fert = (await call("POST", "/products", "owner", { name: "Sample Fertilizer", productType: "fertilizer", useUnit: "pounds dry", rates: [{ name: "Spring", amountPer1000: 3, applicationMethodId: m("Spreader (not mixed)") }] })).body;
  ID.round = (await call("POST", "/service-types", "owner", { name: "Round 1", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000", chemical: true })).body.id;
  await call("PUT", `/chemical-tracking/services/${ID.round}`, "owner", { applicationSite: "Turf" });
  await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", { products: [{ productId: pre.id, productRateId: pre.rates[0].id }, { productId: fert.id, productRateId: fert.rates[0].id }] });

  // Three customers, each with a property: 10,000, 6,000 and one with no lawn size.
  const cust = async (key: string, first: string, sqFt: number | null, extra: Record<string, unknown> = {}) => {
    ID[key] = (await call("POST", "/customers", "owner", { firstName: first, lastName: "Example", email: email(key), phone: "(405) 555-01" + String(10 + Object.keys(ID).length).slice(-2), ...extra })).body.id;
    ID[`${key}Prop`] = (await call("POST", "/properties", "owner", { street: `${first} St 1`, city: "Norman", zip: "73069", ...(sqFt ? { lawnSqFt: sqFt } : {}), billToCustomerId: ID[key] })).body.id;
  };
  await cust("amy", "Amy", 10000); await cust("bob", "Bob", 6000); await cust("cal", "Cal", null);
  ID.woAmy = (await call("POST", "/visits", "owner", workOrder(ID.amyProp, ID.amy, ID.leo, ID.crew))).body.id;
  ID.woBob = (await call("POST", "/visits", "owner", workOrder(ID.bobProp, ID.bob, ID.leo, ID.crew))).body.id;
  ID.woCal = (await call("POST", "/visits", "owner", workOrder(ID.calProp, ID.cal, ID.ana))).body.id;
});

afterAll(async () => {
  // Disconnect texting again: other test files poll every connected company for replies.
  await call("DELETE", "/texting/settings", "owner");
  setEmailTransport(null); setTextingProvider(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("load sheet", () => {
  it("totals what each tech needs: concentrate per product and spray per method", async () => {
    expect((await call("GET", "/chemical-tracking/load-sheet", "mgr")).status).toBe(403);
    const s = (await call("GET", `/chemical-tracking/load-sheet?date=${today}&by=tech`, "owner")).body;
    expect(s.groups.map((g: any) => [g.label, g.stops.length, g.missingSize])).toEqual([["Ana Tech", 1, 1], ["Leo Tech", 2, 0]]);
    const leo = s.groups[1];
    expect(leo.totals.map((t: any) => [t.product, t.method, +t.amount.toFixed(3), t.stops])).toEqual([
      ["Sample Fertilizer", "Spreader (not mixed)", 48, 2], // 3 lb × 16
      ["Sample Pre-Emergent", "Truck 2gal/1000ft", 8, 2], // 0.5 oz × 16
    ]);
    expect(leo.spray).toEqual([{ method: "Truck 2gal/1000ft", gal: 32 }]); // 2 gal × 16
  });

  it("puts the whole day in one list", async () => {
    const s = (await call("GET", `/chemical-tracking/load-sheet?date=${today}&by=day`, "owner")).body;
    expect(s.groups.map((g: any) => [g.label, g.stops.length, g.missingSize])).toEqual([["All work orders", 3, 1]]);
    expect(s.groups[0].totals.map((t: any) => [t.product, +t.amount.toFixed(3)])).toEqual([["Sample Fertilizer", 48], ["Sample Pre-Emergent", 8]]);
  });

  it("groups by truck: the crew's truck, else the truck assigned to the tech", async () => {
    const s = (await call("GET", `/chemical-tracking/load-sheet?date=${today}&by=truck`, "owner")).body;
    expect(s.groups.map((g: any) => [g.label, g.stops.map((x: any) => x.customer)])).toEqual([
      ["Truck 1", ["Amy Example", "Bob Example"]], ["Truck 2", ["Cal Example"]],
    ]);
  });
});

describe("customer notices", () => {
  it("sends nothing until notices are turned on", async () => {
    const r = await complete(ID.woAmy);
    expect(r).toBeTruthy();
    expect(notices()).toHaveLength(0);
    expect((await call("GET", "/chemical-tracking/notices", "owner")).body).toEqual([]);
  });

  it("emails by default, with the products, their notes and the re-entry time", async () => {
    const s = (await call("GET", "/chemical-tracking/notice-settings", "owner")).body;
    expect(s).toMatchObject({ on: false, emailReady: true, textingReady: true });
    expect((await call("PUT", "/chemical-tracking/notice-settings", "owner", { ...s, on: true })).status).toBe(200);
    // The office (Customers & billing) picks each property's way; Bob wants a text.
    expect((await call("PUT", `/properties/${ID.bobProp}/chemical-notice`, "mgr", { chemicalNotice: "text" })).status).toBe(200);
    expect((await call("PUT", `/properties/${ID.calProp}/chemical-notice`, "mgr", { chemicalNotice: "printed" })).status).toBe(200);
    expect((await call("PUT", `/properties/${ID.calProp}/chemical-notice`, "mgr", { chemicalNotice: "pigeon" })).status).toBe(400);

    const amy = (await call("GET", `/chemical-records?visitId=${ID.woAmy}`, "owner")).body[0];
    const sent = await call("POST", `/chemical-tracking/records/${amy.id}/notice`, "owner", { channel: "email" });
    expect(sent.body).toMatchObject({ channel: "email", status: "sent", to: email("amy") });
    expect(notices()).toHaveLength(1);
    expect(notices()[0].subject).toMatch(/^Your lawn was treated on /);
    expect(notices()[0].text).toContain("Hi Amy,");
    expect(notices()[0].text).toContain("Applied: Sample Pre-Emergent and Sample Fertilizer");
    expect(notices()[0].text).toContain("Sample Pre-Emergent: Water in within 3 days.");
    expect(notices()[0].text).toContain("for 12 hours");
    expect(notices()[0].text).not.toMatch(/\{[a-z_]+\}/);
  });

  it("texts or queues to print, the way each property chose, when a work order is completed", async () => {
    await complete(ID.woBob);
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toMatch(/^Office Tools Co: we treated your lawn at Bob St 1/);
    await complete(ID.woCal, "ana");
    const toPrint = (await call("GET", "/chemical-tracking/notices?status=to_print", "owner")).body;
    expect(toPrint.map((n: any) => [n.customerName, n.channel, n.status])).toEqual([["Cal Example", "printed", "to_print"]]);
    expect(toPrint[0].body).toContain("Hi Cal,");
    expect((await call("POST", "/chemical-tracking/notices/printed", "owner", { ids: [toPrint[0].id] })).body).toEqual({ updated: 1 });
    expect((await call("GET", "/chemical-tracking/notices?status=to_print", "owner")).body).toEqual([]);
    // The log has one row per notice sent, whichever way it went.
    const all = (await call("GET", "/chemical-tracking/notices", "owner")).body;
    expect(all.map((n: any) => n.channel).sort()).toEqual(["email", "printed", "text"]);
  });

  it("skips properties set to none, and says why when it can't send", async () => {
    await call("PUT", `/properties/${ID.amyProp}/chemical-notice`, "owner", { chemicalNotice: "none" });
    await call("POST", `/visits/${ID.woAmy}/reopen`, "owner", {});
    await complete(ID.woAmy);
    expect(notices()).toHaveLength(1);
    // Text to a customer with no number: skipped, with the reason.
    const noPhone = (await call("POST", "/customers", "owner", { firstName: "Nia", lastName: "Nophone", email: email("nia") })).body.id;
    const prop = (await call("POST", "/properties", "owner", { street: "Nia St 1", lawnSqFt: 5000, billToCustomerId: noPhone })).body.id;
    await call("PUT", `/properties/${prop}/chemical-notice`, "owner", { chemicalNotice: "text" });
    const wo = (await call("POST", "/visits", "owner", workOrder(prop, noPhone, ID.leo))).body.id;
    await complete(wo);
    const problems = (await call("GET", "/chemical-tracking/notices?status=problems", "owner")).body;
    expect(problems.map((n: any) => [n.customerName, n.status, n.detail])).toEqual([["Nia Nophone", "skipped", "Nia Nophone has no mobile number on file"]]);
  });
});

describe("mixes", () => {
  it("are kept in Chemical Tracking, within each label's maximum", async () => {
    const methods = (await call("GET", "/chemical-tracking/methods", "owner")).body as { id: string; name: string }[];
    const truck = methods.find((m) => m.name === "Truck 2gal/1000ft")!.id;
    const products = (await call("GET", "/products", "owner")).body as { id: string; name: string }[];
    ID.pre = products.find((p) => p.name === "Sample Pre-Emergent")!.id;
    ID.surf = (await call("POST", "/products", "owner", { name: "Sample Surfactant", productType: "adjuvant", useUnit: "ounces liquid", labelMaxPer1000: 0.5, rates: [] })).body.id;
    const mix = { name: "Pre-em + surfactant", applicationMethodId: truck, notes: "Surfactant last", items: [{ productId: ID.pre, ratePer1000: 0.55 }, { productId: ID.surf, ratePer1000: 0.25 }] };
    expect((await call("POST", "/chemical-tracking/mixes", "mgr", mix)).status).toBe(403);
    expect((await call("POST", "/chemical-tracking/mixes", "owner", { ...mix, items: [{ productId: ID.surf, ratePer1000: 0.9 }] })).status).toBe(400); // over the label
    expect((await call("POST", "/chemical-tracking/mixes", "owner", { ...mix, items: [mix.items[0], mix.items[0]] })).status).toBe(400);
    const made = await call("POST", "/chemical-tracking/mixes", "owner", mix);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ name: "Pre-em + surfactant", methodName: "Truck 2gal/1000ft" });
    expect(made.body.items.map((i: any) => [i.productName, i.ratePer1000])).toEqual([["Sample Pre-Emergent", 0.55], ["Sample Surfactant", 0.25]]);
    ID.mix = made.body.id; ID.truck = truck;
  });

  it("are offered to the tech, and the record keeps each product with the mix's name", async () => {
    const wo = (await call("POST", "/visits", "owner", workOrder(ID.amyProp, ID.amy, ID.leo))).body.id;
    const o = (await call("GET", `/visits/${wo}/chemicals`, "leo")).body;
    expect(o.mixes).toEqual([{ id: ID.mix, name: "Pre-em + surfactant", notes: "Surfactant last", methodId: ID.truck, items: [{ productId: ID.pre, ratePer1000: 0.55 }, { productId: ID.surf, ratePer1000: 0.25 }] }]);
    await call("POST", `/visits/${wo}/start`, "leo", {});
    const done = await call("POST", `/visits/${wo}/complete`, "leo", { chemicals: { items: [
      { productId: ID.pre, used: true, methodId: ID.truck, ratePer1000: 0.55, amount: 5.5, mixName: "Pre-em + surfactant" },
      { productId: ID.surf, used: true, methodId: ID.truck, ratePer1000: 0.25, amount: 2.5, mixName: "Pre-em + surfactant" },
    ] } });
    expect(done.status).toBe(200);
    const [r] = (await call("GET", `/chemical-records?visitId=${wo}`, "owner")).body;
    const rec = (await call("GET", `/chemical-records/${r.id}`, "owner")).body;
    expect(rec.products.map((p: any) => [p.tradeName, p.mixName, p.methodName, p.amount])).toEqual([
      ["Sample Pre-Emergent", "Pre-em + surfactant", "Truck 2gal/1000ft", 5.5],
      ["Sample Surfactant", "Pre-em + surfactant", "Truck 2gal/1000ft", 2.5],
    ]);
    const csv = (await call("GET", `/chemical-records/export.csv?from=${today}&to=${today}`, "owner")).body as string;
    expect(csv.split("\n")[0]).toContain(",Mix,Application method,");
    // Turned off: no longer offered; removed: records keep it.
    await call("PUT", `/chemical-tracking/mixes/${ID.mix}`, "owner", { name: "Pre-em + surfactant", applicationMethodId: ID.truck, active: false, items: [{ productId: ID.pre, ratePer1000: 0.55 }] });
    expect((await call("GET", `/visits/${ID.woAmy}/chemicals`, "leo")).body.mixes).toEqual([]);
    expect((await call("DELETE", `/chemical-tracking/mixes/${ID.mix}`, "owner")).status).toBe(200);
    expect((await call("GET", `/chemical-records/${r.id}`, "owner")).body.products[0].mixName).toBe("Pre-em + surfactant");
  });
});

describe("what needs attention", () => {
  it("counts records missing something, notices to print and certifications running out", async () => {
    const in30 = new Date(Date.parse(`${today}T12:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    await call("PUT", `/chemical-records/applicators/${ID.leo}`, "owner", { certNo: "C-1", expiresOn: in30, categories: "3A" });
    await call("PUT", `/chemical-records/applicators/${ID.ana}`, "owner", { certNo: "C-2", expiresOn: "2030-01-01", categories: "3A" });
    const cal = (await call("GET", `/chemical-records?visitId=${ID.woCal}`, "owner")).body[0];
    await call("POST", `/chemical-tracking/records/${cal.id}/notice`, "owner", { channel: "printed" });
    const a = (await call("GET", "/chemical-tracking/attention", "owner")).body;
    expect(a.records.count).toBeGreaterThan(0); // no license # on the company, no weather
    expect(a.certs).toEqual([{ id: ID.leo, name: "Leo Tech", certNo: "C-1", expiresOn: in30, expired: false }]);
    expect(a.notices).toEqual({ toPrint: 1, failed: 0 });
    expect((await call("GET", "/chemical-tracking/attention", "mgr")).status).toBe(403);
  });
});
