/** Crews and packages: who manages them, crews on work orders (and updating their open ones), packages as saved line items. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@crews.test`;
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

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Crews Co", firstName: "Cy", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["office", "manager"], ["lead", "employee"], ["hand", "employee"], ["newbie", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  await call("POST", "/crm/sample-customers", "owner");
  ID.jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "office")).body.properties[0].id;
  await call("PUT", `/properties/${ID.janeProp}`, "office", { ...(await call("GET", `/properties/${ID.janeProp}`, "office")).body, lawnSqFt: 11000 });
  ID.truck = (await call("POST", "/assets", "owner", { name: "Spray Truck 1", type: "truck" })).body.id;
  ID.fert = (await call("POST", "/service-types", "owner", { name: "Fertilizer & weed control", pricing: "per_thousand", priceCents: 425, minimumCents: 4000 })).body.id;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("crews", () => {
  it("the office makes a crew with a lead, members and a truck; everyone can see crews", async () => {
    expect((await call("POST", "/crews", "lead", { name: "Spray crew" })).status).toBe(403);
    const r = await call("POST", "/crews", "office", { name: "Spray crew", color: "#16a34a", leadId: ID.lead, memberIds: [ID.hand], assetId: ID.truck });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "Spray crew", color: "#16a34a", assetName: "Spray Truck 1", memberIds: [ID.lead, ID.hand] });
    ID.crew = r.body.id;
    expect((await call("GET", "/crews", "hand")).body.map((c: any) => c.name)).toEqual(["Spray crew"]);
    expect((await call("POST", "/crews", "office", { name: "Ghost", memberIds: ["00000000-0000-4000-8000-000000000000"] })).body.error).toMatch(/isn't on the team/);
  });

  it("work orders go to a crew; changing the crew can update its open work orders", async () => {
    const order = (date: string) => ({ title: "Round 4", customerId: ID.jane, propertyId: ID.janeProp, date, crewId: ID.crew, assigneeIds: [ID.lead, ID.hand] });
    const past = (await call("POST", "/visits", "office", order(plus(today, -7)))).body;
    const next = (await call("POST", "/visits", "office", order(plus(today, 7)))).body;
    expect(next.crew).toMatchObject({ id: ID.crew, name: "Spray crew", color: "#16a34a" });
    expect((await call("GET", `/visits?crewId=${ID.crew}&status=active`, "office")).body.items.map((v: any) => v.id).sort()).toEqual([past.id, next.id].sort());
    expect((await call("POST", "/visits", "office", { ...order(today), crewId: "00000000-0000-4000-8000-000000000000" })).body.error).toMatch(/crew doesn't exist/);
    // The calendar knows the crew.
    const ev = (await call("GET", `/events?from=${today}&to=${plus(today, 8)}`, "office")).body.events.find((e: any) => e.id === next.id);
    expect(ev.crew).toMatchObject({ name: "Spray crew" });

    // The new hand replaces the old one; open work orders from today on follow (not past ones).
    const upd = await call("PUT", `/crews/${ID.crew}`, "office", { name: "Spray crew", color: "#16a34a", leadId: ID.lead, memberIds: [ID.newbie], assetId: ID.truck, updateOpenWorkOrders: true });
    expect(upd.body).toMatchObject({ memberIds: [ID.lead, ID.newbie], workOrdersUpdated: 1 });
    expect((await call("GET", `/visits/${next.id}`, "office")).body.assignees.map((a: any) => a.id).sort()).toEqual([ID.lead, ID.newbie].sort());
    expect((await call("GET", `/visits/${past.id}`, "office")).body.assignees.map((a: any) => a.id).sort()).toEqual([ID.lead, ID.hand].sort());
    expect((await call("GET", `/visits/${next.id}`, "newbie")).status).toBe(200);

    // Deleting the crew leaves the work orders and their people.
    expect((await call("DELETE", `/crews/${ID.crew}`, "office")).status).toBe(200);
    const after = (await call("GET", `/visits/${next.id}`, "office")).body;
    expect(after.crew).toBeNull();
    expect(after.assignees).toHaveLength(2);
  });
});

describe("packages", () => {
  it("admins keep packages; managers can use them; the crew can't see them", async () => {
    const pkg = { name: "Spring round", description: "Fertilizer, edging and a blow-off", lines: [
      { serviceTypeId: ID.fert, description: "Fertilizer & weed control", quantity: 1, budgetedHours: 0.5 },
      { description: "Edge beds", quantity: 1, budgetedHours: 0.25, unitPriceCents: 1500 },
    ] };
    expect((await call("POST", "/packages", "office", pkg)).status).toBe(403);
    const r = await call("POST", "/packages", "owner", pkg);
    expect(r.status).toBe(200);
    expect(r.body.lines.map((l: any) => [l.description, l.unitPriceCents])).toEqual([["Fertilizer & weed control", null], ["Edge beds", 1500]]);
    ID.pkg = r.body.id;
    expect((await call("POST", "/packages", "owner", { name: "Bad", lines: [{ description: "Mystery", quantity: 1 }] })).status).toBe(400);
    expect((await call("GET", "/packages", "office")).body.map((p: any) => p.name)).toEqual(["Spring round"]);
    expect((await call("GET", "/packages", "hand")).status).toBe(403);
    // Retired packages only show with ?all=1.
    await call("PUT", `/packages/${ID.pkg}`, "owner", { ...pkg, active: false });
    expect((await call("GET", "/packages", "office")).body).toEqual([]);
    expect((await call("GET", "/packages?all=1", "office")).body).toHaveLength(1);
    expect((await call("DELETE", `/packages/${ID.pkg}`, "owner")).status).toBe(200);
  });
});
