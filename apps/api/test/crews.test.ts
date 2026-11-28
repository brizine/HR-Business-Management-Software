/** Crews and packages: who manages them, crews on work orders (and updating their open ones), packages as season programs on properties. */
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
  const round = (name: string, from: number, to: number, more: object = {}) => ({ name, serviceTypeId: ID.fert, startDate: plus(today, from), endDate: plus(today, to), minDays: 35, ...more });

  it("admins keep packages (season programs of rounds); managers see them; the crew can't", async () => {
    const pkg = { name: "Eco Lawn Service", description: "Weed control & fertilization", renewalDate: plus(today, 200), rounds: [round("Early Spring", -60, -30), round("Spring", -5, 30, { notes: "Blanket spray" }), round("Summer", 40, 80, { unitPriceCents: 5000 })] };
    expect((await call("POST", "/packages", "office", pkg)).status).toBe(403);
    const r = await call("POST", "/packages", "owner", pkg);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ startDate: plus(today, -60), endDate: plus(today, 80), renewalDate: plus(today, 200), propertyCount: 0 });
    expect(r.body.rounds.map((x: any) => [x.name, x.minDays, x.unitPriceCents])).toEqual([["Early Spring", 35, null], ["Spring", 35, null], ["Summer", 35, 5000]]);
    ID.pkg = r.body.id;
    for (const x of r.body.rounds) ID[x.name] = x.id;
    // A round needs a price-list service and a window.
    expect((await call("POST", "/packages", "owner", { name: "Bad", rounds: [{ name: "Mystery", startDate: today, endDate: today }] })).status).toBe(400);
    expect((await call("POST", "/packages", "owner", { name: "Bad", rounds: [{ ...round("Backwards", 10, 5) }] })).status).toBe(400);
    expect((await call("GET", "/packages", "office")).body.map((p: any) => p.name)).toEqual(["Eco Lawn Service"]);
    expect((await call("GET", "/packages", "hand")).status).toBe(403);
    // A copy has the same rounds under a new name; inactive ones only show with ?all=1.
    const copy = await call("POST", `/packages/${ID.pkg}/copy`, "owner");
    expect(copy.body).toMatchObject({ name: "Eco Lawn Service (copy)" });
    expect(copy.body.rounds).toHaveLength(3);
    await call("PUT", `/packages/${copy.body.id}`, "owner", { ...copy.body, active: false });
    expect((await call("GET", "/packages", "office")).body).toHaveLength(1);
    expect((await call("GET", "/packages?all=1", "office")).body).toHaveLength(2);
    expect((await call("DELETE", `/packages/${copy.body.id}`, "owner")).status).toBe(200);
  });

  it("on a property, each round becomes a waiting-list work order in its window", async () => {
    ID.crew = (await call("POST", "/crews", "office", { name: "Program crew", leadId: ID.lead, memberIds: [ID.hand] })).body.id;
    const add = (rounds: object[]) => call("POST", "/packages/enrollments", "office", { propertyId: ID.janeProp, packageId: ID.pkg, renewal: "call", crewId: ID.crew, rounds });
    // Early Spring's window is over: it's left out unless somebody asks for it. Summer isn't wanted.
    const r = await add([{ roundId: ID["Early Spring"], include: true, unitPriceCents: 4675 }, { roundId: ID.Spring, include: true, unitPriceCents: 4675, budgetedHours: 0.5 }, { roundId: ID.Summer, include: false }]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, status: "active", renewal: "call", packageName: "Eco Lawn Service", totalCents: 4675 });
    ID.enr = r.body.id;
    expect(r.body.rounds.map((x: any) => [x.name, x.included, !!x.visit])).toEqual([["Early Spring", true, false], ["Spring", true, true], ["Summer", false, false]]);
    const wo = (await call("GET", `/visits/${r.body.rounds[1].visit.id}`, "office")).body;
    expect(wo).toMatchObject({ title: "Spring", date: null, status: "open", releaseOn: plus(today, -5), dueBy: plus(today, 30), minDaysAfterLast: 35, notes: "Blanket spray", totalCents: 4675, budgetedHours: 0.5, crewId: ID.crew });
    expect(wo.assignees.map((a: any) => a.id).sort()).toEqual([ID.lead, ID.hand].sort());
    expect(wo.lines).toMatchObject([{ serviceTypeId: ID.fert, description: "Fertilizer & weed control", unitPriceCents: 4675 }]);
    expect((await call("GET", "/waitlist", "office")).body.rows.some((x: any) => x.id === wo.id)).toBe(true);
    // Once per property; an included round needs a rate.
    expect((await add([{ roundId: ID.Spring, include: true, unitPriceCents: 4675 }])).status).toBe(400);
    expect((await call("GET", `/packages/enrollments?propertyId=${ID.janeProp}`, "office")).body.items).toHaveLength(1);
    expect((await call("GET", `/packages/${ID.pkg}`, "office")).body.properties).toMatchObject([{ status: "active", customer: { id: ID.jane } }]);
    expect((await call("GET", `/packages/enrollments?propertyId=${ID.janeProp}`, "hand")).status).toBe(403);

    // A round's new window moves its work orders still on the waiting list.
    const pkg = (await call("GET", `/packages/${ID.pkg}`, "owner")).body;
    const moved = await call("PUT", `/packages/${ID.pkg}`, "owner", { ...pkg, rounds: pkg.rounds.map((x: any) => (x.name === "Spring" ? { ...x, endDate: plus(today, 45) } : x)) });
    expect(moved.body.movedWorkOrders).toBe(1);
    expect((await call("GET", `/visits/${wo.id}`, "office")).body.dueBy).toBe(plus(today, 45));

    // Pausing takes the waiting rounds off the list; resuming puts back the ones still in season.
    const paused = await call("POST", `/packages/enrollments/${ID.enr}/pause`, "office");
    expect(paused.body).toMatchObject({ status: "paused", removed: 1, stillScheduled: 0 });
    expect((await call("GET", `/visits/${wo.id}`, "office")).status).toBe(404);
    const resumed = await call("POST", `/packages/enrollments/${ID.enr}/resume`, "office");
    expect(resumed.body).toMatchObject({ status: "active", created: 1 });
    expect(resumed.body.rounds.map((x: any) => !!x.visit)).toEqual([false, true, false]);

    // A package with properties on it can't be deleted; a cancelled one doesn't count.
    expect((await call("DELETE", `/packages/${ID.pkg}`, "owner")).status).toBe(400);
    expect((await call("POST", `/packages/enrollments/${ID.enr}/cancel`, "office")).body).toMatchObject({ status: "cancelled", removed: 1 });
    expect((await call("POST", `/packages/enrollments/${ID.enr}/resume`, "office")).status).toBe(400);
    // A missed round can be caught up: it goes on the list with no window, due now.
    const again = await add([{ roundId: ID["Early Spring"], include: true, unitPriceCents: 4675, scheduleMissed: true }, { roundId: ID.Spring, include: false }, { roundId: ID.Summer, include: false }]);
    expect(again.body.created).toBe(1);
    expect((await call("GET", `/visits/${again.body.rounds[0].visit.id}`, "office")).body).toMatchObject({ releaseOn: null, dueBy: null, minDaysAfterLast: 35 });
    await call("POST", `/packages/enrollments/${again.body.id}/cancel`, "office");
    expect((await call("DELETE", `/packages/${ID.pkg}`, "owner")).status).toBe(200);
  });
});
