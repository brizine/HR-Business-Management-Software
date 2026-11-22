/** Customers and properties: adding, bill-to and resident assignments, tags, cancelling, permissions and sample customers. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@crm.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "CRM Co", firstName: "Olive", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  // A second company, to prove nothing leaks between companies.
  const other = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Other Co", firstName: "Otto", lastName: "Other", email: email("other"), password: "password123" } });
  T.other = other.json().token;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("customers and properties", () => {
  it("only managers in Customers & billing can see customers; admins manage tags", async () => {
    expect((await call("GET", "/customers", "tech")).status).toBe(403);
    expect((await call("GET", "/customers", "office")).status).toBe(200);
    expect((await call("POST", "/crm/tags", "office", { name: "VIP" })).status).toBe(403);
    const vip = await call("POST", "/crm/tags", "owner", { name: "VIP", color: "purple" });
    expect(vip.body).toMatchObject({ name: "VIP", color: "purple" });
    ID.vip = vip.body.id;
    ID.dog = (await call("POST", "/crm/tags", "owner", { name: "Dog in yard", color: "orange" })).body.id;
    expect((await call("POST", "/crm/tags", "owner", { name: "vip" })).status).toBe(409);
  });

  it("adds a customer with their first property as bill-to; numbers count up from 1001", async () => {
    const c = await call("POST", "/customers", "office", {
      firstName: "Jane", lastName: "Example", email: "Jane@Example.com", phone: "405-555-0101", tagIds: [ID.vip],
      contacts: [{ name: "John Example", relation: "Spouse", email: "john@example.com", getsInvoices: true }],
      property: { street: "1201 Bluestem Dr", city: "Norman", zip: "73069", frontSqFt: 4200, backSqFt: 6800, tagIds: [ID.dog] },
    });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ number: 1001, name: "Jane Example", email: "jane@example.com", phone: "(405) 555-0101" });
    ID.jane = c.body.id;
    const detail = await call("GET", `/customers/${ID.jane}`, "office");
    expect(detail.body.contacts).toHaveLength(1);
    expect(detail.body.properties).toHaveLength(1);
    expect(detail.body.properties[0]).toMatchObject({ role: "bill_to", street: "1201 Bluestem Dr", lawnSqFt: 11000, endDate: null, tagIds: [ID.dog] });
    ID.bluestem = detail.body.properties[0].id;

    const second = await call("POST", "/customers", "office", { kind: "commercial", companyName: "Lee Rentals LLC", firstName: "Sam", lastName: "Lee", email: "sam@example.com" });
    expect(second.body).toMatchObject({ number: 1002, name: "Lee Rentals LLC" });
    ID.lee = second.body.id;
    const tenant = await call("POST", "/customers", "office", { firstName: "Tara", lastName: "Tenant", phone: "4055550103", delivery: ["text"] });
    ID.tara = tenant.body.id;

    const bad = await call("POST", "/customers", "office", { lastName: "Nomail", delivery: ["email"] });
    expect(bad.status).toBe(400);
    expect((await call("POST", "/customers", "office", { lastName: "X", email: "x@example.com", tagIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
  });

  it("lists and searches customers by name, phone, address, number and tag", async () => {
    const all = await call("GET", "/customers", "office");
    expect(all.body.total).toBe(3);
    expect(all.body.rows.map((r: { name: string }) => r.name)).toEqual(["Jane Example", "Lee Rentals LLC", "Tara Tenant"]);
    expect(all.body.rows[0]).toMatchObject({ propertyCount: 1, address: "1201 Bluestem Dr, Norman" });
    const q = async (s: string) => (await call("GET", `/customers?${s}`, "office")).body.rows.map((r: { name: string }) => r.name);
    expect(await q("q=jane%20ex")).toEqual(["Jane Example"]);
    expect(await q("q=555-0103")).toEqual(["Tara Tenant"]);
    expect(await q("q=bluestem")).toEqual(["Jane Example"]);
    expect(await q("q=1002")).toEqual(["Lee Rentals LLC"]);
    expect(await q(`tags=${ID.vip}`)).toEqual(["Jane Example"]);
    expect(await q(`notTags=${ID.vip}`)).toEqual(["Lee Rentals LLC", "Tara Tenant"]);
    expect((await call("GET", "/customers", "other")).body.total).toBe(0);
    expect((await call("GET", `/customers/${ID.jane}`, "other")).status).toBe(404);
  });

  it("a property gets a new bill-to (the old one ends, history kept) and residents", async () => {
    const p = await call("POST", "/properties", "office", { name: "Rental A", street: "215 Elm St", city: "Norman", zip: "73069", lawnSqFt: 6500, billToCustomerId: ID.jane, residentIds: [ID.tara] });
    expect(p.status).toBe(200);
    ID.elm = p.body.id;
    const moved = await call("POST", `/properties/${ID.elm}/assign`, "office", { customerId: ID.lee, role: "bill_to", startDate: "2099-06-01" });
    expect(moved.body).toMatchObject({ role: "bill_to", startDate: "2099-06-01", endDate: null });
    const detail = await call("GET", `/properties/${ID.elm}`, "office");
    const roles = detail.body.assignments.map((a: { name: string; role: string; endDate: string | null }) => [a.name, a.role, a.endDate]);
    expect(roles).toEqual(expect.arrayContaining([["Lee Rentals LLC", "bill_to", null], ["Tara Tenant", "resident", null], ["Jane Example", "bill_to", "2099-05-31"]]));
    // Assigning the same person again in the same role changes nothing.
    await call("POST", `/properties/${ID.elm}/assign`, "office", { customerId: ID.tara, role: "resident" });
    expect((await call("GET", `/properties/${ID.elm}`, "office")).body.assignments).toHaveLength(3);

    const tara = detail.body.assignments.find((a: { name: string }) => a.name === "Tara Tenant");
    const ended = await call("POST", `/properties/${ID.elm}/assignments/${tara.assignmentId}/end`, "office", { endDate: "2099-12-31" });
    expect(ended.body.endDate).toBe("2099-12-31");
    expect((await call("POST", `/properties/${ID.elm}/assignments/${tara.assignmentId}/end`, "office", {})).status).toBe(400);

    const list = await call("GET", "/properties?q=elm", "office");
    expect(list.body.rows[0]).toMatchObject({ street: "215 Elm St", billTo: { id: ID.lee, name: "Lee Rentals LLC" } });
    expect((await call("GET", "/properties?q=lee%20rentals", "office")).body.total).toBe(1);
  });

  it("filters properties by Map Code prefix and by the bill-to customer's tags", async () => {
    const elm = await call("GET", `/properties/${ID.elm}`, "office");
    const { id, assignments, measurement, cancellations, companyId, createdAt, updatedAt, createdById, sample, status, mapCodeManual, ...rest } = elm.body;
    const saved = await call("PUT", `/properties/${ID.elm}`, "office", { ...stripNulls(rest), mapCode: "801" });
    expect(saved.body).toMatchObject({ mapCode: "801", mapCodeManual: true });
    expect((await call("GET", "/properties?mapCode=80", "office")).body.total).toBe(1);
    expect((await call("GET", "/properties?mapCode=none", "office")).body.rows.map((r: { street: string }) => r.street)).toEqual(["1201 Bluestem Dr"]);
    expect((await call("GET", `/properties?customerTags=${ID.vip}`, "office")).body.rows.map((r: { street: string }) => r.street)).toEqual(["1201 Bluestem Dr"]);
    expect((await call("GET", `/properties?tags=${ID.dog}`, "office")).body.total).toBe(1);
  });

  it("bulk tagging records who did it; tags can be merged", async () => {
    const r = await call("POST", "/crm/tags/apply", "office", { tagId: ID.vip, action: "add", customerIds: [ID.lee, ID.tara, ID.jane] });
    expect(r.body.changed).toBe(2);
    const hist = await call("GET", `/crm/tags/history?customerId=${ID.lee}`, "office");
    expect(hist.body[0]).toMatchObject({ tagId: ID.vip, action: "add", source: "bulk", byId: ID.office });
    const gold = (await call("POST", "/crm/tags", "owner", { name: "Gold" })).body.id;
    await call("POST", "/crm/tags/apply", "office", { tagId: gold, action: "add", customerIds: [ID.jane] });
    expect((await call("POST", `/crm/tags/${gold}/merge`, "owner", { intoId: ID.vip })).status).toBe(200);
    const jane = await call("GET", `/customers/${ID.jane}`, "office");
    expect(jane.body.tagIds).toEqual([ID.vip]);
    const tags = await call("GET", "/crm/tags", "office");
    expect(tags.body.find((t: { id: string }) => t.id === ID.vip)).toMatchObject({ customers: 3 });
  });

  it("cancelling needs a reason; the customer's billed properties are cancelled too; reactivating", async () => {
    const reasons = (await call("GET", "/crm/cancel-reasons", "office")).body;
    expect(reasons.map((r: { label: string }) => r.label)).toContain("Moved or sold the home");
    const moved = reasons.find((r: { label: string }) => r.label === "Moved or sold the home");
    const other = reasons.find((r: { label: string }) => r.label === "Other");
    expect((await call("POST", `/customers/${ID.jane}/cancel`, "office", {})).status).toBe(400);
    expect((await call("POST", `/customers/${ID.jane}/cancel`, "office", { reasonId: other.id })).status).toBe(400);
    const done = await call("POST", `/customers/${ID.jane}/cancel`, "office", { reasonId: moved.id, comment: "Sold in March" });
    expect(done.body).toMatchObject({ ok: true, propertiesCancelled: 1 });
    expect((await call("GET", `/properties/${ID.bluestem}`, "office")).body).toMatchObject({ status: "cancelled" });
    // Elm St's bill-to is Lee now, so it stays active.
    expect((await call("GET", `/properties/${ID.elm}`, "office")).body.status).toBe("active");
    expect((await call("GET", "/customers", "office")).body.rows.map((r: { name: string }) => r.name)).not.toContain("Jane Example");
    expect((await call("GET", "/customers?status=cancelled", "office")).body.rows.map((r: { name: string }) => r.name)).toEqual(["Jane Example"]);
    const detail = await call("GET", `/customers/${ID.jane}`, "office");
    expect(detail.body.cancellations[0]).toMatchObject({ reasonLabel: "Moved or sold the home", comment: "Sold in March", reactivatedAt: null });

    expect((await call("POST", `/customers/${ID.jane}/reactivate`, "office")).status).toBe(200);
    expect((await call("GET", `/customers/${ID.jane}`, "office")).body.cancellations[0].reactivatedAt).not.toBeNull();
    expect((await call("POST", `/properties/${ID.bluestem}/reactivate`, "office")).status).toBe(200);
  });

  it("customers with history can't be deleted, only cancelled; admins only", async () => {
    expect((await call("DELETE", `/customers/${ID.jane}`, "office")).status).toBe(403);
    expect((await call("DELETE", `/customers/${ID.jane}`, "owner")).status).toBe(409);
    const lead = await call("POST", "/customers", "office", { lastName: "Lead", email: "lead@example.com", status: "lead" });
    expect((await call("DELETE", `/customers/${lead.body.id}`, "owner")).status).toBe(200);
  });

  it("sample customers: ten accounts plus tenants, tagged Sample, removable in one go", async () => {
    expect((await call("POST", "/crm/sample-customers", "office")).status).toBe(403);
    const made = await call("POST", "/crm/sample-customers", "owner");
    expect(made.body.created).toBe(12);
    expect((await call("POST", "/crm/sample-customers", "owner")).status).toBe(409);
    expect((await call("GET", "/crm/sample-customers", "office")).body.count).toBe(12);
    const pm = (await call("GET", "/customers?q=prairie", "office")).body.rows[0];
    expect(pm).toMatchObject({ name: "Prairie Property Management", propertyCount: 3, sample: true });
    const rental = (await call("GET", "/properties?q=217%20elm", "office")).body.rows[0];
    const rentalDetail = await call("GET", `/properties/${rental.id}`, "office");
    expect(rentalDetail.body.assignments.map((a: { name: string; role: string }) => [a.name, a.role])).toEqual(expect.arrayContaining([["Lee Rentals LLC", "bill_to"], ["Ray Renter", "resident"]]));
    const removed = await call("DELETE", "/crm/sample-customers", "owner");
    expect(removed.body).toEqual({ customers: 12, properties: 14 });
    // Real customers are untouched.
    expect((await call("GET", "/customers?status=all", "office")).body.total).toBe(3);
  });
});

/** Drops nulls so a GET result can be sent back as an update. */
function stripNulls(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
