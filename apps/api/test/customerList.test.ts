/** The Customers list: filter rules, worked-out columns, sorting, counts by status, paging, export and bulk actions. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@clist.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const list = async (params: Record<string, unknown> = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) p.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return (await call("GET", `/customers?${p}`, "office")).body;
};
const names = (r: any) => r.rows.map((c: any) => c.name);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "List Co", firstName: "Lee", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  ID.office = (await call("POST", "/employees", "owner", { firstName: "office", lastName: "Person", email: email("office"), password: "password123", role: "manager" })).body.id;
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  ID.vip = (await call("POST", "/crm/tags", "owner", { name: "VIP", color: "purple" })).body.id;
  ID.map = (await call("POST", "/crm/tags", "owner", { name: "MAP 100", color: "blue" })).body.id;
  ID.aer = (await call("POST", "/service-types", "owner", { name: "Core aeration", pricing: "flat", priceCents: 9500, incomeAccountCode: "4200" })).body.id;
  ID.grass = (await call("POST", "/custom-fields", "owner", { appliesTo: "customer", name: "Grass type", type: "select", options: ["Bermuda", "Fescue"] })).body.id;
  const mk = async (body: Record<string, unknown>) => (await call("POST", "/customers", "office", body)).body;
  const ann = await mk({ firstName: "Ann", lastName: "Apple", email: "ann@example.com", phone: "405-555-0101", tagIds: [ID.vip], source: "Referral", custom: { [ID.grass]: "Fescue" }, property: { street: "1 Oak St", city: "Norman", zip: "73069" } });
  const bob = await mk({ firstName: "Bob", lastName: "Berry", email: "bob@example.com", phone: "405-555-0202", tagIds: [ID.map], property: { street: "2 Elm St", city: "Moore", zip: "73160" } });
  const hoa = await mk({ kind: "hoa", companyName: "Cedar Park HOA", email: "board@cedar.example", taxExempt: true, property: { street: "300 Cedar Blvd", city: "Norman", zip: "73072" } });
  const lead = await mk({ firstName: "Lia", lastName: "Lead", email: "lia@example.com", status: "lead" });
  Object.assign(ID, { ann: ann.id, bob: bob.id, hoa: hoa.id, lead: lead.id });
  for (const k of ["ann", "bob", "hoa"]) ID[`${k}Prop`] = (await call("GET", `/customers/${ID[k]}`, "office")).body.properties[0].id;
  // Ann owes $120 (overdue); Bob owes $40, due later; the HOA paid in full.
  const inv = async (customerId: string, cents: number, issueDate: string, dueDate: string) => {
    const r = await call("POST", "/invoices", "office", { customerId, issueDate, dueDate, lines: [{ description: "Service", quantity: 1, unitPriceCents: cents, incomeAccountCode: "4000" }] });
    await call("POST", `/invoices/${r.body.id}/send`, "office", { via: ["paper"] });
    return r.body.id;
  };
  await inv(ID.ann, 12000, plus(today, -40), plus(today, -10));
  await inv(ID.bob, 4000, today, plus(today, 15));
  const paid = await inv(ID.hoa, 30000, plus(today, -5), plus(today, 10));
  await call("POST", `/invoices/${paid}/payments`, "office", { amountCents: 30000, method: "check", reference: "1001" });
  // Bob has $25 of credit he hasn't used.
  await call("POST", "/credits", "office", { customerId: ID.bob, amountCents: 2500, reason: "goodwill", description: "Sorry for the delay", applyTo: "none" });
  // Ann had aeration done last month; Bob is scheduled next week; the HOA has nothing.
  const wo = await call("POST", "/visits", "office", { title: "Aeration", customerId: ID.ann, propertyId: ID.annProp, date: plus(today, -30), lines: [{ serviceTypeId: ID.aer, description: "Core aeration", quantity: 1, unitPriceCents: 9500 }] });
  await call("POST", `/visits/${wo.body.id}/complete`, "office", {});
  await call("POST", "/visits", "office", { title: "Round 1", customerId: ID.bob, propertyId: ID.bobProp, date: plus(today, 7), lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }] });
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("customer list", () => {
  it("counts by status for the tabs, and shows the worked-out columns", async () => {
    const r = await list({ status: "all", sort: "name" });
    expect(r.counts).toEqual({ active: 3, lead: 1, cancelled: 0, current: 4, all: 4 });
    const ann = r.rows.find((c: any) => c.id === ID.ann);
    expect(ann).toMatchObject({ balanceCents: 12000, overdueCents: 12000, creditCents: 0, city: "Norman", zip: "73069", propertyCount: 1, lastService: plus(today, -30), nextService: null, source: "Referral" });
    expect(r.rows.find((c: any) => c.id === ID.bob)).toMatchObject({ balanceCents: 4000, overdueCents: 0, creditCents: 2500, nextService: plus(today, 7) });
    expect(r.rows.find((c: any) => c.id === ID.hoa)).toMatchObject({ balanceCents: 0, revenueCents: 30000, taxExempt: true });
    expect((await list({ status: "lead" })).rows.map((c: any) => c.id)).toEqual([ID.lead]);
  });

  it("filters by money, service and dates", async () => {
    expect(names(await list({ status: "all", filters: [{ f: "balance", op: "gt", v: 50 }] }))).toEqual(["Ann Apple"]);
    expect(names(await list({ status: "all", filters: [{ f: "balance", op: "between", v: 10, v2: 200 }], sort: "balance", dir: "desc" }))).toEqual(["Ann Apple", "Bob Berry"]);
    expect(names(await list({ status: "all", filters: [{ f: "overdue", op: "yes" }] }))).toEqual(["Ann Apple"]);
    expect(names(await list({ status: "all", filters: [{ f: "credit", op: "gt", v: 0 }] }))).toEqual(["Bob Berry"]);
    expect(names(await list({ filters: [{ f: "lastService", op: "never" }], sort: "name" }))).toEqual(["Bob Berry", "Cedar Park HOA", "Lia Lead"]);
    expect(names(await list({ filters: [{ f: "lastService", op: "after", v: plus(today, -45) }] }))).toEqual(["Ann Apple"]);
    expect(names(await list({ filters: [{ f: "nextService", op: "yes" }] }))).toEqual(["Bob Berry"]);
    expect(names(await list({ filters: [{ f: "service", op: "completed", v: [ID.aer] }] }))).toEqual(["Ann Apple"]);
    expect(names(await list({ filters: [{ f: "service", op: "completed", v: [ID.aer], from: plus(today, -10) }] }))).toEqual([]);
    expect(names(await list({ filters: [{ f: "service", op: "scheduled" }] }))).toEqual(["Bob Berry"]);
    expect(names(await list({ filters: [{ f: "revenue", op: "gt", v: 250 }] }))).toEqual(["Cedar Park HOA"]);
    expect(names(await list({ filters: [{ f: "since", op: "after", v: today }], sort: "name" }))).toHaveLength(4);
  });

  it("filters by contact, address, tags, type and custom fields; rules add up (all must match)", async () => {
    expect(names(await list({ filters: [{ f: "name", op: "starts", v: "ce" }] }))).toEqual(["Cedar Park HOA"]);
    expect(names(await list({ filters: [{ f: "phone", op: "contains", v: "0202" }] }))).toEqual(["Bob Berry"]);
    expect(names(await list({ filters: [{ f: "zip", op: "equals", v: "73160" }] }))).toEqual(["Bob Berry"]);
    expect(names(await list({ filters: [{ f: "city", op: "equals", v: "norman" }], sort: "name" }))).toEqual(["Ann Apple", "Cedar Park HOA"]);
    expect(names(await list({ filters: [{ f: "address", op: "contains", v: "cedar" }] }))).toEqual(["Cedar Park HOA"]);
    expect(names(await list({ filters: [{ f: "address", op: "blank" }] }))).toEqual(["Lia Lead"]);
    expect(names(await list({ filters: [{ f: "tags", op: "any", v: [ID.vip, ID.map] }], sort: "name" }))).toEqual(["Ann Apple", "Bob Berry"]);
    expect(names(await list({ filters: [{ f: "tags", op: "none", v: [ID.vip] }], sort: "name" }))).toEqual(["Bob Berry", "Cedar Park HOA", "Lia Lead"]);
    expect(names(await list({ filters: [{ f: "kind", op: "is", v: ["hoa"] }] }))).toEqual(["Cedar Park HOA"]);
    expect(names(await list({ filters: [{ f: "taxExempt", op: "yes" }] }))).toEqual(["Cedar Park HOA"]);
    expect(names(await list({ filters: [{ f: "source", op: "is", v: ["Referral"] }] }))).toEqual(["Ann Apple"]);
    expect(names(await list({ filters: [{ f: `cf:${ID.grass}`, op: "is", v: ["Fescue"] }] }))).toEqual(["Ann Apple"]);
    expect(names(await list({ filters: [{ f: "email", op: "contains", v: "example.com" }, { f: "balance", op: "gt", v: 0 }], sort: "name" }))).toEqual(["Ann Apple", "Bob Berry"]);
    // Counts follow the filters too.
    expect((await list({ filters: [{ f: "email", op: "contains", v: "lia" }] })).counts).toMatchObject({ active: 0, lead: 1 });
    // Junk filters are ignored, not errors.
    expect((await call("GET", `/customers?filters=${encodeURIComponent("[{\"f\":\"nope\",\"op\":\"x\"}]")}`, "office")).status).toBe(200);
    expect((await call("GET", "/customers?filters=not-json", "office")).status).toBe(200);
  });

  it("pages, sorts either way, and exports more at once", async () => {
    const page1 = await list({ status: "all", sort: "number", limit: "2", offset: "0" });
    const page2 = await list({ status: "all", sort: "number", limit: "2", offset: "2" });
    expect(page1.total).toBe(4);
    expect([...page1.rows, ...page2.rows].map((c: any) => c.number)).toEqual([1001, 1002, 1003, 1004]);
    expect((await list({ status: "all", sort: "number", dir: "desc", limit: "1" })).rows[0].number).toBe(1004);
    expect((await list({ status: "all", limit: "9999" })).rows.length).toBe(4);
    expect((await list({ status: "all", export: "1", limit: "5000" })).rows.length).toBe(4);
  });

  it("bulk: add and remove tags, mark active or lead; cancelled customers keep their status", async () => {
    expect((await call("POST", "/customers/bulk", "office", { ids: [ID.ann] })).status).toBe(400);
    const r = await call("POST", "/customers/bulk", "office", { ids: [ID.ann, ID.bob, ID.hoa], addTagIds: [ID.map], removeTagIds: [ID.vip] });
    expect(r.body).toMatchObject({ changed: 2 });
    expect(names(await list({ filters: [{ f: "tags", op: "all", v: [ID.map] }], sort: "name" }))).toEqual(["Ann Apple", "Bob Berry", "Cedar Park HOA"]);
    expect(names(await list({ filters: [{ f: "tags", op: "any", v: [ID.vip] }] }))).toEqual([]);
    expect((await call("POST", "/customers/bulk", "office", { ids: [ID.lead], status: "active" })).body.changed).toBe(1);
    expect((await list({ status: "all" })).counts).toMatchObject({ active: 4, lead: 0 });
    const moved = (await call("GET", "/crm/cancel-reasons", "office")).body.find((r: any) => r.label === "Moved or sold the home");
    expect((await call("POST", `/customers/${ID.hoa}/cancel`, "office", { reasonId: moved.id, comment: "Moved" })).status).toBe(200);
    const s = await call("POST", "/customers/bulk", "office", { ids: [ID.hoa, ID.bob], status: "lead" });
    expect(s.body).toMatchObject({ changed: 1, skipped: 1 });
    expect((await call("POST", "/customers/bulk", "office", { ids: [ID.ann], addTagIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
  });

  it("bulk: all that match the list (not just the ticked rows), worked out on the server", async () => {
    const vipTag = { addTagIds: [ID.vip] };
    expect((await call("POST", "/customers/bulk", "office", vipTag)).status).toBe(400);
    // Everyone in Norman who isn't cancelled (Ann; the HOA was cancelled above).
    const r = await call("POST", "/customers/bulk", "office", { match: { status: "current", filters: [{ f: "city", op: "contains", v: "Norman" }] }, ...vipTag });
    expect(r.body).toMatchObject({ changed: 1, missing: 0 });
    expect(names(await list({ status: "all", filters: [{ f: "tags", op: "any", v: [ID.vip] }] }))).toEqual(["Ann Apple"]);
    // A search narrows it too.
    const s = await call("POST", "/customers/bulk", "office", { match: { status: "all", q: "berry" }, removeTagIds: [ID.map] });
    expect(s.body.changed).toBe(1);
    expect(names(await list({ status: "all", filters: [{ f: "tags", op: "any", v: [ID.map] }], sort: "name" }))).toEqual(["Ann Apple", "Cedar Park HOA"]);
    expect((await call("POST", "/customers/bulk", "office", { match: { status: "bogus" }, ...vipTag })).status).toBe(400);
  });

  it("bulk cancel: needs a reason, cancels the bill-to properties too, skips the already cancelled", async () => {
    const reasons = (await call("GET", "/crm/cancel-reasons", "office")).body;
    const moved = reasons.find((r: any) => r.label === "Moved or sold the home");
    const needsComment = reasons.find((r: any) => r.commentRequired);
    expect((await call("POST", "/customers/bulk", "office", { ids: [ID.ann], cancel: {} })).status).toBe(400);
    if (needsComment) expect((await call("POST", "/customers/bulk", "office", { ids: [ID.ann], cancel: { reasonId: needsComment.id } })).status).toBe(400);
    expect((await call("POST", "/customers/bulk", "office", { ids: [ID.ann], cancel: { reasonId: moved.id }, addTagIds: [ID.vip] })).status).toBe(400);
    const r = await call("POST", "/customers/bulk", "office", { ids: [ID.ann, ID.hoa], cancel: { reasonId: moved.id, comment: "Moved away" } });
    expect(r.body).toMatchObject({ changed: 1, skipped: 1, propertiesCancelled: 1 });
    const ann = (await call("GET", `/customers/${ID.ann}`, "office")).body;
    expect(ann.status).toBe("cancelled");
    expect(ann.cancellations[0]).toMatchObject({ reasonLabel: "Moved or sold the home", comment: "Moved away" });
    expect((await call("GET", `/properties/${ID.annProp}`, "office")).body.status).toBe("cancelled");
    // By match: everyone left in Moore who isn't cancelled (Bob, a lead since the test above).
    const m = await call("POST", "/customers/bulk", "office", { match: { status: "current", filters: [{ f: "city", op: "equals", v: "Moore" }] }, cancel: { reasonId: moved.id } });
    expect(m.body).toMatchObject({ changed: 1 });
    expect((await list({ status: "all" })).counts).toMatchObject({ active: 1, cancelled: 3 });
  });
});
