/** Custom fields: who keeps them, values on each kind of record, defaults, and transferable values. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { customFields, customers, employees, properties } from "../src/db/schema";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@fields.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const F: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}
const field = async (body: Record<string, unknown>) => {
  const r = await call("POST", "/custom-fields", "owner", body);
  expect(r.status).toBe(200);
  return r.body.id as string;
};

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Fields Co", firstName: "Fay", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"], ["other", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("custom fields", () => {
  it("owners and admins add them, like Homeworks' Add New Field; everyone can read them", async () => {
    expect((await call("POST", "/custom-fields", "office", { appliesTo: "property", name: "Front Yard Sq Ft", type: "integer" })).status).toBe(403);
    F.propFront = await field({ appliesTo: "property", name: "Front Yard Sq Ft", type: "integer", transferable: true });
    expect((await call("POST", "/custom-fields", "owner", { appliesTo: "property", name: "front yard sq ft", type: "text" })).body.error).toMatch(/already a field called/);
    F.woFront = await field({ appliesTo: "workorder", name: "Front Yard Sq Ft", type: "integer", transferable: true });
    F.woBack = await field({ appliesTo: "workorder", name: "Back Yard Sq Ft", type: "integer", transferable: true });
    F.woGallons = await field({ appliesTo: "workorder", name: "Gallons used", type: "decimal" });
    F.woPo = await field({ appliesTo: "workorder", name: "PO approved", type: "checkbox" });
    F.invPo = await field({ appliesTo: "invoice", name: "PO approved", type: "checkbox", transferable: true });
    F.todoNote = await field({ appliesTo: "todo", name: "Supplies", type: "text", defaultValue: "Check the shop first" });
    F.referral = await field({ appliesTo: "customer", name: "Referred by", type: "select", options: ["Facebook", "Neighbor", "Google"] });
    F.assetTag = await field({ appliesTo: "asset", name: "Tag number", type: "text" });
    expect((await call("POST", "/custom-fields", "owner", { appliesTo: "workorder", name: "Crew size", type: "integer", defaultValue: "two" })).body.issues?.[0]?.message ?? "").toMatch(/whole number/);
    const list = (await call("GET", "/custom-fields?appliesTo=workorder", "tech")).body;
    expect(list.map((f: any) => f.name)).toEqual(["Front Yard Sq Ft", "Back Yard Sq Ft", "Gallons used", "PO approved"]);
    // The 9 added here, plus Crewdesk's own 9 property fields.
    expect((await call("GET", "/custom-fields", "tech")).body).toHaveLength(18);
  });

  it("rename, change the default and transferable, reorder", async () => {
    expect((await call("PUT", `/custom-fields/${F.todoNote}`, "owner", { name: "Supplies needed" })).body.name).toBe("Supplies needed");
    expect((await call("PUT", `/custom-fields/${F.woFront}`, "owner", { defaultValue: "lots" })).status).toBe(400);
    expect((await call("PUT", `/custom-fields/${F.woPo}`, "owner", { transferable: true })).body.transferable).toBe(true);
    await call("PUT", "/custom-fields/order", "owner", { ids: [F.woGallons, F.woFront, F.woBack, F.woPo] });
    expect((await call("GET", "/custom-fields?appliesTo=workorder", "owner")).body.map((f: any) => f.name)).toEqual(["Gallons used", "Front Yard Sq Ft", "Back Yard Sq Ft", "PO approved"]);
  });

  it("customers and properties keep values, checked by type", async () => {
    const bad = await call("POST", "/customers", "office", { firstName: "Rita", lastName: "Field", email: "rita@example.com", custom: { [F.referral]: "TikTok" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Referred by: Pick one of: Facebook, Neighbor, Google");
    const c = await call("POST", "/customers", "office", { firstName: "Rita", lastName: "Field", email: "rita@example.com", custom: { [F.referral]: "neighbor" } });
    expect(c.body.custom).toEqual({ [F.referral]: "Neighbor" });
    ID.rita = c.body.id;
    const p = await call("POST", "/properties", "office", { street: "12 Pecan St", city: "Norman", zip: "73069", backSqFt: 1800, billToCustomerId: ID.rita, custom: { [F.propFront]: "4,200" } });
    expect(p.body.custom).toEqual({ [F.propFront]: 4200 });
    ID.prop = p.body.id;
    // Editing without sending custom values leaves them alone.
    const edit = await call("PUT", `/customers/${ID.rita}`, "office", { firstName: "Rita", lastName: "Fields", email: "rita@example.com" });
    expect(edit.body.custom).toEqual({ [F.referral]: "Neighbor" });
  });

  it("a work order takes transferable values from its property (custom fields and measured sizes)", async () => {
    const r = await call("POST", "/visits", "office", { title: "Spring round", customerId: ID.rita, propertyId: ID.prop, date: today, lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }], assigneeIds: [ID.tech] });
    expect(r.status).toBe(200);
    // Front from the property's custom field, back from its measured back lawn; Gallons used stays blank.
    expect(r.body.custom).toEqual({ [F.woFront]: 4200, [F.woBack]: 1800 });
    expect(r.body.property.custom).toEqual({ [F.propFront]: 4200 });
    ID.wo = r.body.id;
    // Entered values win over transfers.
    const typed = await call("POST", "/visits", "office", { title: "Spot spray", customerId: ID.rita, propertyId: ID.prop, date: today, lines: [{ description: "Spot spray", quantity: 1, unitPriceCents: 3000 }], custom: { [F.woFront]: "100" } });
    expect(typed.body.custom[F.woFront]).toBe(100);
  });

  it("the crew on a work order fills in its values; others can't", async () => {
    const saved = await call("PUT", `/custom-fields/values/workorder/${ID.wo}`, "tech", { values: { [F.woGallons]: "2.5", [F.woPo]: true } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ [F.woFront]: 4200, [F.woBack]: 1800, [F.woGallons]: 2.5, [F.woPo]: true });
    expect((await call("PUT", `/custom-fields/values/workorder/${ID.wo}`, "tech", { values: { [F.woGallons]: "lots" } })).body.error).toBe("Gallons used: Enter a number");
    expect((await call("PUT", `/custom-fields/values/workorder/${ID.wo}`, "other", { values: { [F.woGallons]: "1" } })).status).toBe(404);
    expect((await call("GET", `/custom-fields/values/workorder/${ID.wo}`, "tech")).body[F.woGallons]).toBe(2.5);
    expect((await call("GET", `/custom-fields/values/customer/${ID.rita}`, "tech")).status).toBe(403);
    // A blank clears one.
    expect((await call("PUT", `/custom-fields/values/workorder/${ID.wo}`, "office", { values: { [F.woGallons]: "" } })).body).not.toHaveProperty(F.woGallons);
  });

  it("an invoice made from the work order takes its transferable values", async () => {
    await call("POST", `/visits/${ID.wo}/complete`, "tech", {});
    const inv = await call("POST", `/visits/${ID.wo}/invoice`, "office");
    expect(inv.status).toBe(200);
    expect((await call("GET", `/invoices/${inv.body.invoiceId}`, "office")).body.custom).toEqual({ [F.invPo]: true });
  });

  it("to-dos start with defaults and keep them through a series; equipment too", async () => {
    const t = await call("POST", "/todos", "office", { title: "Restock the truck", date: today, rule: { freq: "daily", end: "count", count: 3 } });
    expect(t.body.custom).toEqual({ [F.todoNote]: "Check the shop first" });
    const all = (await call("GET", "/todos?q=restock", "office")).body.items;
    expect(all.map((x: any) => x.custom[F.todoNote])).toEqual(["Check the shop first", "Check the shop first", "Check the shop first"]);
    const changed = await call("PUT", `/todos/${all[1].id}?applyTo=following`, "office", { title: "Restock the truck", date: all[1].date, custom: { [F.todoNote]: "Order from the co-op" } });
    expect(changed.body.changed).toBe(2);
    expect((await call("GET", "/todos?q=restock", "office")).body.items.map((x: any) => x.custom[F.todoNote])).toEqual(["Check the shop first", "Order from the co-op", "Order from the co-op"]);
    const a = await call("POST", "/assets", "owner", { name: "Truck 9", type: "vehicle", custom: { [F.assetTag]: "OK-4471" } });
    expect(a.body.custom).toEqual({ [F.assetTag]: "OK-4471" });
    expect((await call("PUT", `/custom-fields/values/asset/${a.body.id}`, "tech", { values: { [F.assetTag]: "x" } })).status).toBe(403);
  });

  it("deleting fields (one or several) hides them", async () => {
    expect((await call("DELETE", `/custom-fields/${F.assetTag}`, "office")).status).toBe(403);
    expect((await call("DELETE", `/custom-fields/${F.assetTag}`, "owner")).body.deleted).toBe(1);
    expect((await call("POST", "/custom-fields/delete", "owner", { ids: [F.woGallons, F.woPo] })).body.deleted).toBe(2);
    expect((await call("GET", "/custom-fields?appliesTo=workorder", "owner")).body.map((f: any) => f.name)).toEqual(["Front Yard Sq Ft", "Back Yard Sq Ft"]);
    // Saving values afterwards drops the deleted fields' old values.
    const saved = await call("PUT", `/custom-fields/values/workorder/${ID.wo}`, "office", { values: { [F.woFront]: 4300 } });
    expect(saved.body).toEqual({ [F.woFront]: 4300, [F.woBack]: 1800 });
  });

  it("a property's own details are custom fields too: listed, renamed, saved to the property, never deleted", async () => {
    const list = (await call("GET", "/custom-fields?appliesTo=property", "office")).body;
    // Crewdesk's own first, then the one this company added.
    expect(list.map((f: any) => f.name)).toEqual(["Map Code", "Front Lawn ft", "Back Lawn ft", "Other ft", "Total ft", "Gate Code", "Pets", "Access Notes", "Notes", "Front Yard Sq Ft"]);
    const id = (key: string) => list.find((f: any) => f.builtin === key).id as string;
    expect(list.filter((f: any) => f.builtin).map((f: any) => f.type)).toEqual(["text", "decimal", "decimal", "decimal", "decimal", "text", "text", "text", "text"]);

    // The values: the property's own columns, by field.
    const before = (await call("GET", `/custom-fields/values/property/${ID.prop}`, "office")).body;
    expect(before).toEqual({ [id("backSqFt")]: 1800, [id("lawnSqFt")]: 1800, [F.propFront]: 4200 });
    // Saving through the fields writes the property itself.
    const saved = await call("PUT", `/custom-fields/values/property/${ID.prop}`, "office", { values: { [id("gateCode")]: "2468", [id("pets")]: "Dog in back", [id("frontSqFt")]: "3,000", [id("lawnSqFt")]: "", [id("mapCode")]: "801" } });
    expect(saved.status).toBe(200);
    // Total left blank: front + back.
    expect(saved.body).toEqual({ [id("gateCode")]: "2468", [id("pets")]: "Dog in back", [id("frontSqFt")]: 3000, [id("backSqFt")]: 1800, [id("lawnSqFt")]: 4800, [id("mapCode")]: "801", [F.propFront]: 4200 });
    const p = (await call("GET", `/properties/${ID.prop}`, "office")).body;
    expect(p).toMatchObject({ gateCode: "2468", pets: "Dog in back", frontSqFt: 3000, backSqFt: 1800, lawnSqFt: 4800, mapCode: "801", mapCodeManual: true, custom: { [F.propFront]: 4200 } });
    // The total can be overridden by hand, and an "other" area added; a blank clears a field.
    const over = await call("PUT", `/custom-fields/values/property/${ID.prop}`, "office", { values: { [id("lawnSqFt")]: 5200, [id("otherSqFt")]: 350, [id("pets")]: "" } });
    expect(over.body).toMatchObject({ [id("lawnSqFt")]: 5200, [id("otherSqFt")]: 350, [id("frontSqFt")]: 3000 });
    expect(over.body).not.toHaveProperty(id("pets"));
    expect((await call("GET", `/properties/${ID.prop}`, "office")).body).toMatchObject({ lawnSqFt: 5200, otherSqFt: 350, pets: null, gateCode: "2468" });
    // A number is still checked as a number.
    expect((await call("PUT", `/custom-fields/values/property/${ID.prop}`, "office", { values: { [id("backSqFt")]: "big" } })).body.error).toBe("Back Lawn ft: Enter a number");

    // Renamed like any field; the property keeps answering by its own name for the phone and the boards.
    expect((await call("PUT", `/custom-fields/${id("gateCode")}`, "owner", { name: "Gate / Door Code" })).body).toMatchObject({ name: "Gate / Door Code", builtin: "gateCode" });
    // Never deleted, alone or in a batch.
    const del = await call("DELETE", `/custom-fields/${id("gateCode")}`, "owner");
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/Crewdesk uses "Gate \/ Door Code" itself/);
    expect((await call("POST", "/custom-fields/delete", "owner", { ids: [id("pets"), id("notes")] })).body).toEqual({ deleted: 0, kept: 2 });
    expect((await call("GET", "/custom-fields?appliesTo=property", "office")).body).toHaveLength(10);

    // A work order field with the same name as a property field fills from it, Crewdesk's own included.
    F.woGate = await field({ appliesTo: "workorder", name: "Gate / Door Code", type: "text", transferable: true });
    F.woTotal = await field({ appliesTo: "workorder", name: "Total ft", type: "integer", transferable: true });
    const wo = await call("POST", "/visits", "office", { title: "Round 2", customerId: ID.rita, propertyId: ID.prop, date: today, lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }] });
    expect(wo.body.custom).toMatchObject({ [F.woGate]: "2468", [F.woTotal]: 5200 });

    // The property form still saves its own boxes, and values sent as custom values land in the same place.
    const full = await call("PUT", `/properties/${ID.prop}`, "office", { street: "12 Pecan St", city: "Norman", zip: "73069", frontSqFt: 3000, backSqFt: 1800, otherSqFt: 350, lawnSqFt: null, gateCode: "2468", tagIds: [], custom: { [id("pets")]: "Two cats", [F.propFront]: 4250 } });
    expect(full.body).toMatchObject({ lawnSqFt: 5150, pets: "Two cats", custom: { [F.propFront]: 4250 } });
    // A new property takes them the same way.
    const made = await call("POST", "/properties", "office", { street: "14 Pecan St", city: "Norman", zip: "73069", billToCustomerId: ID.rita, custom: { [id("gateCode")]: "1357", [id("frontSqFt")]: 2000, [id("backSqFt")]: 2500 } });
    expect(made.body).toMatchObject({ gateCode: "1357", frontSqFt: 2000, backSqFt: 2500, lawnSqFt: 4500, custom: {} });
  });

  it("a field the company already made under the same name becomes the built-in one, with what was typed in it", async () => {
    // A company from before this change: its own "Gate Code" and "Total ft" on properties, and a "Pets" that's a checkbox.
    const token = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Older Co", firstName: "Olga", lastName: "Owner", email: email("older"), password: "password123" } })).json().token;
    T.older = token;
    const [{ companyId }] = await db.select({ companyId: employees.companyId }).from(employees).where(eq(employees.email, email("older")));
    const own = await db.insert(customFields).values([
      { companyId, appliesTo: "property", name: "gate code", type: "text", sortOrder: 0 },
      { companyId, appliesTo: "property", name: "Total ft", type: "integer", sortOrder: 1 },
      { companyId, appliesTo: "property", name: "Pets", type: "checkbox", sortOrder: 2 },
    ]).returning();
    const [gate, total, pets] = own.map((f) => f.id);
    const [typedIn] = await db.insert(properties).values({ companyId, street: "1 Old Rd", custom: { [gate]: "9911", [total]: 7500, [pets]: true } }).returning();
    // Already has its own gate code and size: those win, and the field's old value is simply dropped.
    const [hasOwn] = await db.insert(properties).values({ companyId, street: "2 Old Rd", gateCode: "0000", lawnSqFt: 6000, custom: { [gate]: "1234", [total]: 6500 } }).returning();

    const list = (await call("GET", "/custom-fields?appliesTo=property", "older")).body;
    expect(list.find((f: any) => f.id === gate)).toMatchObject({ name: "gate code", builtin: "gateCode" });
    expect(list.find((f: any) => f.id === total)).toMatchObject({ name: "Total ft", builtin: "lawnSqFt", type: "integer" });
    // A checkbox can't hold what Crewdesk's Pets field holds, so theirs stays theirs and Crewdesk's gets a different name.
    expect(list.find((f: any) => f.id === pets)).toMatchObject({ name: "Pets", builtin: null });
    expect(list.find((f: any) => f.builtin === "pets").name).toBe("Pets (property)");
    expect(list.filter((f: any) => f.builtin)).toHaveLength(9);
    const [a] = await db.select().from(properties).where(eq(properties.id, typedIn.id));
    expect(a).toMatchObject({ gateCode: "9911", lawnSqFt: 7500, custom: { [pets]: true } });
    const [b] = await db.select().from(properties).where(eq(properties.id, hasOwn.id));
    expect(b).toMatchObject({ gateCode: "0000", lawnSqFt: 6000, custom: {} });
    // Asked again: nothing is added twice.
    expect((await call("GET", "/custom-fields?appliesTo=property", "older")).body).toHaveLength(list.length);
    await db.delete(customers).where(eq(customers.companyId, companyId));
  });
});
