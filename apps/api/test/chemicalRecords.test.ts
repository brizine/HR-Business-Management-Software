/**
 * Chemical application records (ODAFF, OAC 35:30-17-21(a)): made when a work order applying tracked
 * products is completed, with every required item; corrections logged; never deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { flushWeather } from "../src/lib/weather";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@chemrecords.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}`, ...headers } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body, headers: res.headers };
}

const uploadLabel = (productId: string) => {
  const boundary = "----label";
  const pdf = Buffer.from("%PDF-1.4\n% sample label\n");
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="label.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), pdf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return call("POST", `/chemical-records/labels/${productId}`, "owner", payload, { "content-type": `multipart/form-data; boundary=${boundary}` });
};

const workOrder = () => ({
  title: "Round 1", customerId: ID.jane, propertyId: ID.janeProp, date: today, startTime: "08:00",
  lines: [{ serviceTypeId: ID.round, description: "Round 1", quantity: 1, unitPriceCents: 6500 }], assigneeIds: [ID.tech],
});
const finish = async () => {
  const wo = (await call("POST", "/visits", "office", workOrder())).body.id;
  await call("POST", `/visits/${wo}/start`, "tech", {});
  await call("POST", `/visits/${wo}/complete`, "tech", { lat: 35.22, lng: -97.44, accuracy: 8 });
  await flushWeather();
  return wo;
};
const recordFor = async (wo: string) => {
  const list = (await call("GET", "/chemical-records?status=all", "office")).body as any[];
  const r = list.find((x) => x.visitId === wo);
  return r ? (await call("GET", `/chemical-records/${r.id}`, "office")).body : null;
};

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Chem Records Co", firstName: "Cara", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Chem Records Co", addressLine1: "100 Main St", city: "Norman", state: "OK", zip: "73069", email: "office@chemrecords.test", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  // Chemical Tracking: admins always; the office manager is added to the access list.
  const officeId = (await call("GET", "/chemical-tracking/access", "owner")).body.people.find((p: { name: string }) => p.name === "office Person").id;
  await call("PUT", `/chemical-tracking/access/${officeId}`, "owner");
  await call("POST", "/crm/sample-customers", "owner", {});
  ID.jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "office")).body.properties[0].id;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;

  // Weather: the office's entry for the day (manual mode, no network).
  await call("PUT", "/weather/settings", "owner", { mode: "manual" });
  await call("PUT", `/weather/days/${today}`, "office", { windMph: 6, windDeg: 180, tempF: 72 });

  const herb = (await call("POST", "/products", "owner", {
    name: "Testweed WG Herbicide", productType: "herbicide", epaRegNo: "0000-1111", reiHours: 12, targets: "Broadleaf weeds",
    useUnit: "ounces dry", purchaseUnitName: "10 oz bottle", purchaseUnitSize: 10, requiredAdjuvant: "Sample Surfactant",
    rates: [{ name: "High", amountPer1000: 0.085, method: "truck_spray", carrierGalPer1000: 2 }],
  })).body;
  ID.herb = herb.id;
  const surf = (await call("POST", "/products", "owner", {
    name: "Sample Surfactant 90", productType: "adjuvant", useUnit: "ounces liquid", trackRecords: false,
    rates: [{ name: "Standard", amountPer1000: 0.25, method: "truck_spray", carrierGalPer1000: 2 }],
  })).body;
  ID.surf = surf.id;
  ID.round = (await call("POST", "/service-types", "owner", { name: "Round 1", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000", chemical: true })).body.id;
  await call("PUT", `/chemical-tracking/services/${ID.round}`, "owner", { applicationSite: "Turf – front and back lawn" });
  await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", { products: [{ productId: herb.id, productRateId: herb.rates[0].id }, { productId: surf.id, productRateId: surf.rates[0].id }] });
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("chemical application records", () => {
  it("lists what's missing until the license, certification and label are on file", async () => {
    const wo = await finish();
    const r = await recordFor(wo);
    expect(r.issues).toEqual([
      "4: tech Person has no certification on file",
      "19: Testweed WG Herbicide has no label on file",
    ]);
  });

  it("records every ODAFF item for a completed application", async () => {
    expect((await call("PUT", "/chemical-records/settings", "tech", { pesticideLicenseNo: "X" })).status).toBe(403);
    await call("PUT", "/chemical-records/settings", "owner", { pesticideLicenseNo: "OK-12345" });
    expect((await call("PUT", `/chemical-records/applicators/${ID.tech}`, "owner", { certNo: "C-998877", expiresOn: "2099-12-31", categories: "3A" })).status).toBe(200);
    expect((await uploadLabel(ID.herb)).status).toBe(200);

    const wo = await finish();
    const r = await recordFor(wo);
    const lawn = r.areaSqFt;
    const herb = r.products.find((p: any) => p.tradeName === "Testweed WG Herbicide");
    const surf = r.products.find((p: any) => p.tradeName === "Sample Surfactant 90");
    expect(r.issues).toEqual([]);
    expect(r.startedAt && r.stoppedAt && r.startedAt <= r.stoppedAt).toBe(true); // 1
    expect(herb.amount).toBeCloseTo((0.085 * lawn) / 1000, 6); // 2
    expect(r).toMatchObject({ companyName: "Chem Records Co", companyAddress: "100 Main St, Norman, OK 73069", companyLicenseNo: "OK-12345" }); // 3
    expect(r).toMatchObject({ applicatorName: "tech Person", applicatorCertNo: "C-998877", applicatorCertExpires: "2099-12-31" }); // 4
    expect(r.customerName).toBe("Jane Example"); // 5
    expect(r.customerAddress).toBeTruthy();
    expect(r.siteAddress).toBeTruthy(); // 6
    expect(r.appliedOn).toBe(today); // 7
    expect(herb).toMatchObject({ ratePer1000: 0.085, unit: "ounces dry", rateName: "High" }); // 8
    expect(herb.dilutionPerGal).toBeCloseTo(0.0425, 6); // 9: 0.085 oz per 2 gal
    expect(r.tankMixGal).toBeCloseTo((2 * lawn) / 1000, 6); // 10
    expect(herb.tradeName).toBe("Testweed WG Herbicide"); // 11
    expect(herb.epaRegNo).toBe("0000-1111"); // 12
    expect(surf).toBeTruthy(); // 13: the adjuvant the label requires is on it (kept though not tracked itself)
    expect(herb.targets).toBe("Broadleaf weeds"); // 15
    expect(r.site).toBe("Turf – front and back lawn"); // 16
    expect(lawn).toBeGreaterThan(0); // 17
    expect(herb.reiHours).toBe(12); // 18
    expect(herb.label).toMatchObject({ fileName: "label.pdf", contentType: "application/pdf" }); // 19
    expect(r.weather).toMatchObject({ source: "day", windMph: 6, windDeg: 180, tempF: 72 }); // 22: other information
    expect(r).toMatchObject({ lat: 35.22, lng: -97.44 });
    const file = await app.inject({ method: "GET", url: `/chemical-records/label-files/${herb.labelId}`, headers: { authorization: `Bearer ${T.office}` } });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain("sample label");
    ID.goodWo = wo;
    ID.good = r.id;
  });

  it("flags a missing required adjuvant, an expired certification and a PO Box", async () => {
    await call("PUT", `/chemical-tracking/services/${ID.round}/products`, "owner", { products: [{ productId: ID.herb, productRateId: (await call("GET", `/products/${ID.herb}`, "owner")).body.rates[0].id }] });
    await call("PUT", `/chemical-records/applicators/${ID.tech}`, "owner", { certNo: "C-998877", expiresOn: "2020-01-31" });
    const prop = Object.fromEntries(Object.entries((await call("GET", `/properties/${ID.janeProp}`, "office")).body).filter(([, v]) => v != null));
    expect((await call("PUT", `/properties/${ID.janeProp}`, "office", { ...prop, street: "PO Box 55" })).status).toBe(200);
    const r = await recordFor(await finish());
    expect(r.issues).toEqual([
      "4: tech Person's certification expired 2020-01-31",
      "6: The property address is a PO Box; it needs the street address",
      "13: Testweed WG Herbicide's label requires Sample Surfactant, which isn't on this application",
    ]);
    expect((await call("PUT", `/properties/${ID.janeProp}`, "office", prop)).status).toBe(200);
    await call("PUT", `/chemical-records/applicators/${ID.tech}`, "owner", { certNo: "C-998877", expiresOn: "2099-12-31" });
  });

  it("logs corrections with who and why, and re-checks the record", async () => {
    expect((await call("PATCH", `/chemical-records/${ID.good}`, "office", { site: "Turf – front lawn" })).status).toBe(400);
    const r = (await call("GET", `/chemical-records/${ID.good}`, "office")).body;
    const herb = r.products.find((p: any) => p.tradeName === "Testweed WG Herbicide");
    const ok = await call("PATCH", `/chemical-records/${ID.good}`, "office", { reason: "Back lawn was skipped (gate locked)", site: "Turf – front lawn", products: [{ id: herb.id, amount: 0.3, targets: "" }] });
    expect(ok.status).toBe(200);
    const after = (await call("GET", `/chemical-records/${ID.good}`, "office")).body;
    expect(after.site).toBe("Turf – front lawn");
    expect(after.changes.map((c: any) => [c.field, c.oldValue, c.newValue, c.reason, c.by])).toEqual([
      ["site", "Turf – front and back lawn", "Turf – front lawn", "Back lawn was skipped (gate locked)", "office Person"],
      ["Testweed WG Herbicide: amount (ounces dry)", String(herb.amount), "0.3", "Back lawn was skipped (gate locked)", "office Person"],
      ["Testweed WG Herbicide: target pest", "Broadleaf weeds", null, "Back lawn was skipped (gate locked)", "office Person"],
    ]);
    expect(after.issues).toEqual(["15: Testweed WG Herbicide has no target pest"]);
    await call("PATCH", `/chemical-records/${ID.good}`, "office", { reason: "Restore target", products: [{ id: herb.id, targets: "Broadleaf weeds" }] });
  });

  it("never deletes a record: reopening voids it, deleting the work order keeps it", async () => {
    await call("POST", `/visits/${ID.goodWo}/reopen`, "office", {});
    const voided = (await call("GET", `/chemical-records/${ID.good}`, "office")).body;
    expect(voided).toMatchObject({ voidReason: "Work order reopened" });
    expect(voided.voidedAt).toBeTruthy();
    expect((await call("PATCH", `/chemical-records/${ID.good}`, "office", { reason: "x x x", site: "y" })).status).toBe(400);
    expect((await call("GET", "/chemical-records?status=voided", "office")).body.map((x: any) => x.id)).toContain(ID.good);
    expect((await call("GET", "/chemical-records", "office")).body.map((x: any) => x.id)).not.toContain(ID.good);
    expect((await call("DELETE", `/visits/${ID.goodWo}`, "office")).status).toBe(200);
    expect((await call("GET", `/chemical-records/${ID.good}`, "office")).body).toMatchObject({ id: ID.good, visitId: null, customerName: "Jane Example" });
  });

  it("exports the log as CSV for an inspection; techs can't see the log", async () => {
    expect((await call("GET", "/chemical-records", "tech")).status).toBe(403);
    const csv = await call("GET", `/chemical-records/export.csv?from=${today}&to=${today}`, "office");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = String(csv.body).replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toMatch(/^Date,Start,Stop,Work order,Company,Company address,License #,Applicator,Cert #,Cert expires,Customer/);
    expect(lines.slice(1).some((l) => l.includes("Testweed WG Herbicide") && l.includes("0000-1111") && l.includes("OK-12345"))).toBe(true);
  });
});
