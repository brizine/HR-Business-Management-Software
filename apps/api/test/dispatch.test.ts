/**
 * Dispatch (the server behind both dispatch boards): the day's work orders and to-dos, building and
 * saving routes, who does what, moving days, the rain day, notes, map areas and settings.
 * Addresses are "found" by a pretend lookup, and road routing by a pretend routing server.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { locationPings, properties, timeEntries, visits } from "../src/db/schema";
import { setDispatchLocator } from "../src/lib/dispatch";
import { setEmailTransport } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

const suffix = Date.now();
let app: FastifyInstance;
const email = (x: string) => `${x}-${suffix}@dispatch.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
const board = async (from = today, to = from) => (await call("GET", `/dispatch?from=${from}&to=${to}`, "mgr")).body;
const event = async (key: string, day = today) => (await board(day)).events.find((e: any) => e.key === key);
const v = (name: string) => `v:${ID[name]}`;

// Where the pretend lookup puts things: the shop north of town, stops running south.
const SHOP = { lat: 35.26, lng: -97.465 };
const SPOTS: Record<string, { lat: number; lng: number }> = { a: { lat: 35.222, lng: -97.445 }, b: { lat: 35.224, lng: -97.446 }, c: { lat: 35.206, lng: -97.446 }, d: { lat: 35.24, lng: -97.48 } };

// A pretend routing server (OSRM's shape): every drive is 1,000 m and 100 s, along a two-point line.
let roadServer: Server;
let roadUrl = "";
const roadCalls: string[] = [];
/** The pretend server can't bring a truck in curbside while this is on. */
let refuseCurb = false;

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async () => {} });
  setDispatchLocator(async (address) => (/deskin/i.test(address) ? SHOP : /nowhere/i.test(address) ? null : { lat: 35.3, lng: -97.5 }));
  roadServer = createServer((req, res) => {
    roadCalls.push(req.url ?? "");
    const n = (req.url ?? "").split("/driving/")[1]?.split("?")[0].split(";").length ?? 0;
    res.setHeader("content-type", "application/json");
    if (refuseCurb && /approaches=[^&]*curb/.test(req.url ?? "")) { res.end(JSON.stringify({ code: "NoRoute" })); return; }
    if ((req.url ?? "").startsWith("/route/")) {
      res.end(JSON.stringify({ code: "Ok", routes: [{ geometry: { coordinates: [[-97.465, 35.26], [-97.445, 35.222]] }, legs: Array.from({ length: n - 1 }, () => ({ distance: 1000, duration: 100, steps: [{ name: "W Gray St", distance: 400, maneuver: { type: "turn", modifier: "left" } }, { name: "", distance: 0, maneuver: { type: "arrive" } }] })) }] }));
    } else {
      res.end(JSON.stringify({ code: "Ok", durations: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.abs(i - j) * 100)) }));
    }
  });
  await new Promise<void>((done) => roadServer.listen(0, "127.0.0.1", done));
  roadUrl = `http://127.0.0.1:${(roadServer.address() as { port: number }).port}`;

  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Dispatch Co", firstName: "Dee", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Dispatch Co", addressLine1: "1601 Deskin Dr", city: "Norman", state: "OK", zip: "73069", email: "office@dispatch.test", timezone: "America/Chicago" });
  for (const [who, first, role] of [["mgr", "Mo", "manager"], ["ann", "Ann", "employee"], ["bob", "Bob", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: first, lastName: who === "mgr" ? "Manager" : "Tech", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  ID.fert = (await call("POST", "/service-types", "owner", { name: "Fertilizer", priceCents: 5000, setupMinutes: 5, minutesPer1000: 3 })).body.id;
  ID.north = (await call("POST", "/crews", "owner", { name: "North", color: "#2563eb", memberIds: [ID.ann], dailyHours: 6 })).body.id;
  ID.south = (await call("POST", "/crews", "owner", { name: "South", color: "#16a34a", memberIds: [ID.bob], dailyHours: 8 })).body.id;
  const customer = async (first: string, street: string, spot: keyof typeof SPOTS | null) => {
    const c = (await call("POST", "/customers", "owner", { firstName: first, lastName: "Lee", email: email(first.toLowerCase()), phone: "405-555-01" + String(10 + Object.keys(ID).length).slice(-2), property: { street, city: "Norman", zip: "73069", lawnSqFt: 10000 } })).body.id as string;
    const p = (await call("GET", `/customers/${c}`, "owner")).body.properties[0].id as string;
    await db.update(properties).set(spot ? SPOTS[spot] : { lat: null, lng: null }).where(eq(properties.id, p));
    return { c, p };
  };
  const cust = { a: await customer("Ada", "201 W Gray St", "a"), b: await customer("Ben", "225 N Webster Ave", "b"), c: await customer("Cy", "1400 Asp Ave", "c"), d: await customer("Di", "3301 W Main St", "d"), e: await customer("Eve", "9 Lost Ln", null) };
  Object.assign(ID, { custA: cust.a.c, custB: cust.b.c });
  const wo = async (title: string, who: keyof typeof cust, extra: Record<string, unknown> = {}) =>
    (await call("POST", "/visits", "owner", { title, customerId: cust[who].c, propertyId: cust[who].p, scheduling: extra.date === null ? "waitlist" : "single", date: today, lines: [{ serviceTypeId: ID.fert, description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }], ...extra })).body.id as string;
  ID.a = await wo("Ada round", "a", { crewId: ID.north, assigneeIds: [ID.ann], budgetedHours: 1 });
  ID.b = await wo("Ben round", "b", { crewId: ID.north, assigneeIds: [ID.ann], budgetedHours: 0.5 });
  ID.c = await wo("Cy round", "c", { crewId: ID.north, assigneeIds: [ID.ann] });
  ID.d = await wo("Di round", "d");
  ID.e = await wo("Eve round", "e", { crewId: ID.north, assigneeIds: [ID.ann] });
  ID.todo = (await call("POST", "/todos", "owner", { title: "Pick up fertilizer", date: today, assigneeIds: [ID.bob], budgetedHours: 0.5, location: "Feed store" })).body.id;
});

afterAll(async () => {
  await flushNotifications();
  await app.close();
  await new Promise((done) => roadServer.close(done));
  await pool.end();
});

describe("the board's data", () => {
  it("lists the day's work orders and to-dos as events, with who, where and how long", async () => {
    const b = await board();
    expect(b.today).toBe(today);
    const keys = b.events.map((e: any) => e.key);
    for (const k of [v("a"), v("b"), v("c"), v("d"), v("e"), `t:${ID.todo}`]) expect(keys).toContain(k);
    const a = b.events.find((e: any) => e.key === v("a"));
    expect(a).toMatchObject({ kind: "visit", status: "open", title: "Ada round", crewId: ID.north, assigneeIds: [ID.ann], budgetedHours: 1, estMinutes: 60, totalCents: 5000, route: null, frequency: null });
    expect(a.location).toMatchObject({ lat: SPOTS.a.lat, lng: SPOTS.a.lng });
    expect(a.location.address).toContain("201 W Gray St");
    expect(a.customer.name).toBe("Ada Lee");
    // No hours typed in: estimated from the lawn (5 min + 3 per 1,000 sq ft).
    expect(b.events.find((e: any) => e.key === v("c"))).toMatchObject({ budgetedHours: null, estMinutes: 35, estSource: "size" });
    const todo = b.events.find((e: any) => e.kind === "todo");
    expect(todo).toMatchObject({ title: "Pick up fertilizer", assigneeIds: [ID.bob], estMinutes: 30, crewId: null });
    expect(todo.location).toMatchObject({ address: "Feed store", lat: null });
  });
  it("comes with the crews, the people and their capacity, and where routes start", async () => {
    const b = await board();
    expect(b.crews.map((c: any) => c.name)).toEqual(["North", "South"]);
    expect(b.crews[0]).toMatchObject({ dailyHours: 6, memberIds: [ID.ann] });
    expect(b.people.find((p: any) => p.id === ID.ann)).toMatchObject({ name: "Ann Tech", dailyHours: 8, excluded: false });
    expect(b.start).toMatchObject({ lat: SHOP.lat, lng: SHOP.lng });
    expect(b.start.address).toContain("1601 Deskin Dr");
    expect(b.settings.routing).toBe("estimate");
    expect(b.routes).toEqual([]);
  });
  it("covers a range of days, and is for Customers & billing managers", async () => {
    expect((await board(plus(today, 1), plus(today, 7))).events).toEqual([]);
    expect((await call("GET", `/dispatch?from=${today}&to=${plus(today, 90)}`, "mgr")).status).toBe(400);
    expect((await call("GET", "/dispatch", "ann")).status).toBe(403);
  });
});

describe("building a route", () => {
  it("measures each drive from the start, between stops and back", async () => {
    const p = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("c"), v("a"), v("b")] })).body;
    expect(p.keys).toEqual([v("c"), v("a"), v("b")]);
    expect(p.measured).toBe("estimate");
    expect(p.start).toMatchObject({ kind: "company", lat: SHOP.lat });
    expect(p.stops).toHaveLength(3);
    for (const s of p.stops) { expect(s.leg.meters).toBeGreaterThan(0); expect(s.leg.seconds).toBeGreaterThan(0); }
    expect(p.stops.map((s: any) => s.minutes)).toEqual([35, 60, 30]);
    expect(p.endLeg.meters).toBeGreaterThan(0);
    expect(p.totalDriveSeconds).toBe(p.stops.reduce((s: number, x: any) => s + x.leg.seconds, 0) + p.endLeg.seconds);
  });
  it("optimizes the order, keeping a pinned stop first and stops with no location last", async () => {
    const plain = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("c"), v("a"), v("e"), v("b")] })).body;
    const best = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("c"), v("a"), v("e"), v("b")], optimize: true })).body;
    expect(best.optimized).toBe(true);
    expect(best.keys[3]).toBe(v("e"));
    expect(best.stops[3]).toMatchObject({ located: false, leg: null });
    expect(best.totalDriveSeconds).toBeLessThanOrEqual(plain.totalDriveSeconds);
    // The two downtown stops end up together.
    expect(Math.abs(best.keys.indexOf(v("a")) - best.keys.indexOf(v("b")))).toBe(1);
    const pinned = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("c"), v("a"), v("b")], optimize: true, pinnedFirst: true })).body;
    expect(pinned.keys[0]).toBe(v("c"));
  });
  it("can start somewhere else, or nowhere (open-ended)", async () => {
    const open = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("a"), v("b")], start: { kind: "none" }, end: { kind: "none" } })).body;
    expect(open.start).toBeNull();
    expect(open.stops[0].leg).toBeNull();
    expect(open.endLeg).toBeNull();
    const custom = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("a")], start: { kind: "custom", label: "A yard", lat: 35.22, lng: -97.44 } })).body;
    expect(custom.start).toMatchObject({ kind: "custom", label: "A yard" });
    expect((await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("a")], start: { kind: "crew" } })).status).toBe(400);
    expect((await call("GET", `/dispatch/employee-point/${ID.ann}`, "mgr")).status).toBe(400); // no address on file
  });
  it("refuses a stop that isn't on that day, and more than 100 stops", async () => {
    const r = await call("POST", "/dispatch/routes/preview", "mgr", { date: plus(today, 3), keys: [v("a")] });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("isn't scheduled on");
    const many = Array.from({ length: 101 }, (_, i) => `v:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const big = await call("POST", "/dispatch/routes", "mgr", { date: today, keys: many });
    expect(big.status).toBe(400);
    expect(JSON.stringify(big.body)).toContain("limited to 100 stops");
  });
});

describe("saved routes", () => {
  it("saves the order, numbers the stops, and remembers the start time and ends", async () => {
    const saved = (await call("POST", "/dispatch/routes", "mgr", { date: today, keys: [v("a"), v("b"), v("c")], startTime: "07:30", pinnedFirst: true, end: { kind: "none" } })).body;
    expect(saved.stops).toBe(3);
    ID.route = saved.id;
    const b = await board();
    expect(b.routes).toHaveLength(1);
    expect(b.routes[0]).toMatchObject({ id: ID.route, date: today, crewId: ID.north, startTime: "07:30", pinnedFirst: true, measured: "estimate", endLeg: null });
    expect(b.routes[0].end.kind).toBe("none");
    expect(b.routes[0].stops.map((s: any) => [s.key, s.order])).toEqual([[v("a"), 1], [v("b"), 2], [v("c"), 3]]);
    expect(b.routes[0].stops[0].leg.seconds).toBeGreaterThan(0);
    expect(b.events.find((e: any) => e.key === v("b")).route).toEqual({ id: ID.route, order: 2, locked: false });
    expect(b.events.find((e: any) => e.key === v("d")).route).toBeNull();
  });
  it("edits the same route rather than making another", async () => {
    const again = (await call("POST", "/dispatch/routes", "mgr", { id: ID.route, date: today, keys: [v("c"), v("b"), v("a")], startTime: "08:00" })).body;
    expect(again.id).toBe(ID.route);
    const b = await board();
    expect(b.routes).toHaveLength(1);
    expect(b.routes[0].stops.map((s: any) => s.key)).toEqual([v("c"), v("b"), v("a")]);
    expect(b.routes[0].endLeg.seconds).toBeGreaterThan(0);
    expect((await call("POST", "/dispatch/routes", "mgr", { id: "00000000-0000-4000-8000-000000000000", date: today, keys: [v("a")] })).status).toBe(404);
  });
  it("splits stops off into their own route, and the ones left renumber from 1", async () => {
    const split = (await call("POST", "/dispatch/routes", "mgr", { date: today, keys: [v("b")] })).body;
    const b = await board();
    expect(b.routes).toHaveLength(2);
    expect(b.routes.find((r: any) => r.id === ID.route).stops.map((s: any) => [s.key, s.order])).toEqual([[v("c"), 1], [v("a"), 2]]);
    expect(b.routes.find((r: any) => r.id === split.id).stops.map((s: any) => s.key)).toEqual([v("b")]);
    // Put it back on the first route; the one-stop route is left empty and goes away.
    await call("POST", "/dispatch/routes", "mgr", { id: ID.route, date: today, keys: [v("c"), v("a"), v("b")] });
    expect((await board()).routes).toHaveLength(1);
  });
  it("takes stops off a route without touching anything else", async () => {
    expect((await call("POST", "/dispatch/unroute", "mgr", { keys: [v("a")] })).body.unrouted).toBe(1);
    const b = await board();
    expect(b.routes[0].stops.map((s: any) => [s.key, s.order])).toEqual([[v("c"), 1], [v("b"), 2]]);
    expect(b.events.find((e: any) => e.key === v("a"))).toMatchObject({ route: null, crewId: ID.north, date: today, status: "open" });
    await call("POST", "/dispatch/routes", "mgr", { id: ID.route, date: today, keys: [v("c"), v("a"), v("b")] });
  });
  it("can give every stop a crew as it saves (Assign all)", async () => {
    const saved = (await call("POST", "/dispatch/routes", "mgr", { date: today, keys: [v("d"), `t:${ID.todo}`], assign: { crewId: ID.south } })).body;
    ID.routeSouth = saved.id;
    const b = await board();
    expect(b.events.find((e: any) => e.key === v("d"))).toMatchObject({ crewId: ID.south, assigneeIds: [ID.bob] });
    expect(b.events.find((e: any) => e.kind === "todo")).toMatchObject({ crewId: ID.south, route: { id: saved.id, order: 2 } });
    expect(b.routes.find((r: any) => r.id === saved.id).crewId).toBe(ID.south);
  });
});

describe("who does it", () => {
  it("moving a stop to another crew takes it off its route; the rest close up", async () => {
    const r = (await call("POST", "/dispatch/assign", "mgr", { keys: [v("a")], crewId: ID.south })).body;
    expect(r).toMatchObject({ assigned: 1, unrouted: 1 });
    const b = await board();
    expect(b.events.find((e: any) => e.key === v("a"))).toMatchObject({ crewId: ID.south, assigneeIds: [ID.bob], route: null });
    expect(b.routes.find((x: any) => x.id === ID.route).stops.map((s: any) => [s.key, s.order])).toEqual([[v("c"), 1], [v("b"), 2]]);
  });
  it("assigning the crew it already has leaves it on its route", async () => {
    expect((await call("POST", "/dispatch/assign", "mgr", { keys: [v("c")], crewId: ID.north })).body.unrouted).toBe(0);
    expect((await event(v("c"))).route).toEqual({ id: ID.route, order: 1, locked: false });
  });
  it("people instead of a crew clears the crew; nobody at all unassigns", async () => {
    await call("POST", "/dispatch/assign", "mgr", { keys: [v("a")], employeeIds: [ID.ann, ID.bob] });
    expect(await event(v("a"))).toMatchObject({ crewId: null });
    expect((await event(v("a"))).assigneeIds.sort()).toEqual([ID.ann, ID.bob].sort());
    await call("POST", "/dispatch/assign", "mgr", { keys: [v("a")] });
    expect(await event(v("a"))).toMatchObject({ crewId: null, assigneeIds: [] });
    expect((await call("POST", "/dispatch/assign", "mgr", { keys: [v("a")], crewId: ID.north, employeeIds: [ID.ann] })).status).toBe(400);
    expect((await call("POST", "/dispatch/assign", "mgr", { keys: [v("a")], crewId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
  });
});

describe("which day", () => {
  it("rescheduling keeps who does it, and takes it off its route", async () => {
    const r = (await call("POST", "/dispatch/reschedule", "mgr", { keys: [v("b")], date: plus(today, 2) })).body;
    expect(r).toMatchObject({ rescheduled: 1, unrouted: 1, reopened: 0 });
    expect(await event(v("b"))).toBeUndefined();
    expect(await event(v("b"), plus(today, 2))).toMatchObject({ date: plus(today, 2), crewId: ID.north, assigneeIds: [ID.ann], route: null });
    expect((await board()).routes.find((x: any) => x.id === ID.route).stops.map((s: any) => s.key)).toEqual([v("c")]);
  });
  it("re-opens a skipped one, and won't move a completed one", async () => {
    await call("POST", `/visits/${ID.b}/skip`, "mgr", { reason: "Gate locked" });
    expect((await call("POST", "/dispatch/reschedule", "mgr", { keys: [v("b")], date: today })).body.reopened).toBe(1);
    expect(await event(v("b"))).toMatchObject({ status: "open", skipReason: null });
    await call("POST", `/visits/${ID.e}/complete`, "mgr", {});
    const r = await call("POST", "/dispatch/reschedule", "mgr", { keys: [v("e"), v("b")], date: plus(today, 1) });
    expect(r.status).toBe(400);
    expect((await event(v("b"))).date).toBe(today);
  });
  it("moves work orders to the waiting list: the day becomes the earliest date", async () => {
    expect((await call("POST", "/dispatch/waitlist", "mgr", { keys: [`t:${ID.todo}`] })).status).toBe(400);
    const r = (await call("POST", "/dispatch/waitlist", "mgr", { keys: [v("d")], dueBy: plus(today, 10) })).body;
    expect(r).toMatchObject({ moved: 1, unrouted: 1 });
    expect(await event(v("d"))).toBeUndefined();
    const [row] = await db.select().from(visits).where(eq(visits.id, ID.d));
    expect(row).toMatchObject({ date: null, releaseOn: today, dueBy: plus(today, 10), status: "open" });
    expect(row.waitingSince).toBeTruthy();
    expect((await board()).waiting).toBeGreaterThanOrEqual(1);
    // Back onto the day, from the waiting list.
    expect((await call("POST", "/waitlist/schedule", "mgr", { visitIds: [ID.d], date: today, crewId: ID.south })).status).toBe(200);
    expect(await event(v("d"))).toMatchObject({ date: today, crewId: ID.south, route: null });
  });
  it("copies and deletes", async () => {
    const dup = (await call("POST", "/dispatch/duplicate", "mgr", { keys: [v("a"), `t:${ID.todo}`] })).body;
    expect(dup.duplicated).toBe(2);
    const copy = await event(dup.keys[0]);
    expect(copy).toMatchObject({ title: "Ada round", status: "open", route: null, totalCents: 5000 });
    expect(copy.number).not.toBe((await event(v("a"))).number);
    expect(copy.services).toHaveLength(1);
    const gone = (await call("POST", "/dispatch/delete", "mgr", { keys: dup.keys })).body;
    expect(gone).toMatchObject({ deleted: 2, kept: 0 });
    expect(await event(dup.keys[0])).toBeUndefined();
    expect((await call("POST", "/dispatch/delete", "mgr", { keys: dup.keys })).status).toBe(404);
  });
});

describe("saving a route into future weeks", () => {
  it("copies the order to the same weekday for the visits that repeat", async () => {
    const day = plus(today, 14);
    const series = async (title: string, customerId: string) => {
      const c = (await call("GET", `/customers/${customerId}`, "owner")).body;
      await call("POST", "/visits", "owner", { title, customerId, propertyId: c.properties[0].id, scheduling: "repeat", date: day, repeatEvery: 1, repeatUnit: "week", repeatUntil: plus(day, 21), lines: [{ serviceTypeId: ID.fert, description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }] });
    };
    await series("Weekly Ada", ID.custA);
    await series("Weekly Ben", ID.custB);
    const first = (await board(day)).events;
    const ada = first.find((e: any) => e.title === "Weekly Ada").key, ben = first.find((e: any) => e.title === "Weekly Ben").key;
    expect(first.find((e: any) => e.key === ada).frequency).toBeTruthy();
    const check = (await call("POST", "/dispatch/routes/future", "mgr", { date: day, keys: [ben, ada], everyWeeks: 1 })).body;
    expect(check.days.map((d: any) => [d.date, d.stops, d.different])).toEqual([[plus(day, 7), 2, 0], [plus(day, 14), 2, 0], [plus(day, 21), 2, 0]]);
    const saved = (await call("POST", "/dispatch/routes", "mgr", { date: day, keys: [ben, ada], assign: { crewId: ID.north }, future: { everyWeeks: 2, assignments: "keep" } })).body;
    expect(saved.future).toEqual({ days: 1, stops: 2 });
    // Two weeks on: the same order, and the crew carried forward; one week on: untouched.
    const later = await board(plus(day, 14));
    expect(later.routes).toHaveLength(1);
    expect(later.routes[0].stops.map((s: any) => later.events.find((e: any) => e.key === s.key).title)).toEqual(["Weekly Ben", "Weekly Ada"]);
    expect(later.events.every((e: any) => e.crewId === ID.north)).toBe(true);
    const skipped = await board(plus(day, 7));
    expect(skipped.routes).toEqual([]);
    expect(skipped.events.every((e: any) => e.crewId === null)).toBe(true);
    expect((await call("POST", "/dispatch/routes", "mgr", { date: day, keys: [ben, ada], future: { everyWeeks: 0 } })).status).toBe(400);
  });
});

describe("the plan's board: a lane is a crew's day in order", () => {
  it("drops work orders into a crew's lane in order: they join the crew and its route", async () => {
    const r = (await call("POST", "/dispatch/lane", "mgr", { date: today, crewId: ID.south, keys: [v("d"), v("a")] })).body;
    expect(r.stops).toBe(2);
    expect(r.totalDriveSeconds).toBeGreaterThan(0);
    const b = await board();
    expect(b.events.find((e: any) => e.key === v("a"))).toMatchObject({ crewId: ID.south, assigneeIds: [ID.bob] });
    const south = b.routes.filter((x: any) => x.crewId === ID.south);
    expect(south).toHaveLength(1);
    expect(south[0].stops.map((s: any) => s.key)).toEqual([v("d"), v("a")]);
    // Reordering the lane changes the same route.
    await call("POST", "/dispatch/lane", "mgr", { date: today, crewId: ID.south, keys: [v("a"), v("d")] });
    const again = (await board()).routes.filter((x: any) => x.crewId === ID.south);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(south[0].id);
    expect(again[0].stops.map((s: any) => s.key)).toEqual([v("a"), v("d")]);
  });
  it("locks a stop in place: a reorder keeps the lock, and optimizing orders the rest around it", async () => {
    expect((await call("POST", "/dispatch/lock", "mgr", { key: v("d"), locked: true })).body).toEqual({ key: v("d"), locked: true });
    expect(await event(v("d"))).toMatchObject({ route: { order: 2, locked: true } });
    await call("POST", "/dispatch/lane", "mgr", { date: today, crewId: ID.south, keys: [v("d"), v("a")] });
    expect(await event(v("d"))).toMatchObject({ route: { order: 1, locked: true } });
    expect((await board()).routes.find((x: any) => x.crewId === ID.south).stops.map((s: any) => s.locked)).toEqual([true, false]);
    // Optimizing leaves locked stops where they are in the list.
    const keys = [v("a"), v("b"), v("c"), v("d")];
    const one = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys, optimize: true, locked: [v("c")] })).body;
    expect(one.keys[2]).toBe(v("c"));
    expect([...one.keys].sort()).toEqual([...keys].sort());
    const two = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys, optimize: true, locked: [v("a"), v("d")] })).body;
    expect([two.keys[0], two.keys[3]]).toEqual([v("a"), v("d")]);
    // One with no location can be locked too.
    const lost = (await call("POST", "/dispatch/routes/preview", "mgr", { date: today, keys: [v("e"), v("a"), v("b"), v("c")], optimize: true, locked: [v("e")] })).body;
    expect(lost.keys[0]).toBe(v("e"));
    // Only a stop on a route can be locked; managers only.
    const loose = (await board()).events.find((e: any) => !e.route);
    expect((await call("POST", "/dispatch/lock", "mgr", { key: loose.key, locked: true })).status).toBe(400);
    expect((await call("POST", "/dispatch/lock", "ann", { key: v("d"), locked: false })).status).toBe(403);
    expect((await call("POST", "/dispatch/lock", "mgr", { key: v("d"), locked: false })).body.locked).toBe(false);
    await call("POST", "/dispatch/lane", "mgr", { date: today, crewId: ID.south, keys: [v("a"), v("d")] });
  });
  it("moves a work order to another day's lane, or back to No crew yet", async () => {
    await call("POST", "/dispatch/lane", "mgr", { date: plus(today, 1), crewId: ID.north, keys: [v("d")] });
    expect(await event(v("d"), plus(today, 1))).toMatchObject({ crewId: ID.north, assigneeIds: [ID.ann], route: { order: 1 } });
    expect((await board()).routes.find((x: any) => x.crewId === ID.south).stops.map((s: any) => s.key)).toEqual([v("a")]);
    await call("POST", "/dispatch/lane", "mgr", { date: plus(today, 1), crewId: null, keys: [v("d")] });
    expect(await event(v("d"), plus(today, 1))).toMatchObject({ crewId: null, route: null });
    expect((await board(plus(today, 1))).routes).toEqual([]);
    expect((await call("POST", "/dispatch/lane", "mgr", { date: today, crewId: ID.south, keys: [`t:${ID.todo}`] })).status).toBe(400);
  });
  it("on a rain day, sends a crew's open work back to the waiting list, or the whole day to the next working day", async () => {
    await call("PUT", `/waitlist/customer/${ID.custA}`, "mgr", { notifyBefore: "text" });
    const next = (await call("GET", `/dispatch/next-working-day?after=${today}`, "mgr")).body.date;
    expect(next > today).toBe(true);
    expect([0, 6]).not.toContain(new Date(`${next}T12:00:00Z`).getUTCDay());
    const south = (await call("POST", "/dispatch/rain", "mgr", { date: today, crewId: ID.south, to: "waitlist", reason: "rain", notify: true })).body;
    // Ada's work order was South's only open one today; texting isn't connected, so she isn't texted.
    expect(south).toMatchObject({ moved: 1, to: null, texted: 0, notTexted: 1 });
    const [row] = await db.select().from(visits).where(eq(visits.id, ID.a));
    expect(row).toMatchObject({ date: null, backReason: "Rain", releaseOn: today });
    const all = (await call("POST", "/dispatch/rain", "mgr", { date: today, crewId: "all", to: "next", reason: "wind", note: "Gusts over 20" })).body;
    expect(all.to).toBe(next);
    expect(all.moved).toBeGreaterThanOrEqual(2);
    const b = await board();
    // What's left today is done (Eve's) or not a work order.
    expect(b.events.filter((e: any) => e.kind === "visit" && e.status === "open")).toEqual([]);
    expect(b.routes.flatMap((r: any) => r.stops).filter((s: any) => s.key.startsWith("v:"))).toEqual([]);
    expect((await event(v("c"), next)).crewId).toBe(ID.north);
    expect((await call("POST", "/dispatch/rain", "mgr", { date: today, crewId: "all", to: "next", reason: "rain" })).body.moved).toBe(0);
  });
});

describe("notes, trucks and map areas", () => {
  it("keeps dispatch notes on work orders and to-dos, oldest first, with who sent them", async () => {
    expect((await call("POST", "/dispatch/notes", "mgr", { key: v("e"), body: "  " })).status).toBe(400);
    await call("POST", "/dispatch/notes", "mgr", { key: v("e"), body: "Gate code changed" });
    const r = (await call("POST", "/dispatch/notes", "owner", { key: v("e"), body: "Customer wants a call first" })).body;
    expect(r.dispatchNotes.map((n: any) => [n.body, n.by])).toEqual([["Gate code changed", "Mo Manager"], ["Customer wants a call first", "Dee Owner"]]);
    expect((await event(v("e"))).dispatchNotes).toHaveLength(2);
    const t = (await call("POST", "/dispatch/notes", "mgr", { key: `t:${ID.todo}`, body: "Ask for the pallet price" })).body;
    expect(t.dispatchNotes).toHaveLength(1);
  });
  it("shows where people were last seen in the past six hours", async () => {
    const [entry] = await db.insert(timeEntries).values({ companyId: (await db.select({ c: visits.companyId }).from(visits).where(eq(visits.id, ID.e)))[0].c, employeeId: ID.ann, clockIn: new Date(Date.now() - 3600_000) }).returning();
    await db.insert(locationPings).values([
      { companyId: entry.companyId, employeeId: ID.ann, timeEntryId: entry.id, lat: 35.21, lng: -97.44, recordedAt: new Date(Date.now() - 20 * 60_000) },
      { companyId: entry.companyId, employeeId: ID.ann, timeEntryId: entry.id, lat: 35.22, lng: -97.45, recordedAt: new Date(Date.now() - 5 * 60_000) },
      { companyId: entry.companyId, employeeId: ID.bob, timeEntryId: entry.id, lat: 35.2, lng: -97.4, recordedAt: new Date(Date.now() - 8 * 3600_000) },
    ]);
    const t = (await call("GET", "/dispatch/trucks", "mgr")).body.trucks;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ employeeId: ID.ann, name: "Ann Tech", lat: 35.22, lng: -97.45 });
    await db.delete(locationPings).where(inArray(locationPings.employeeId, [ID.ann, ID.bob]));
  });
  it("saves areas drawn on the map, for everyone, in the order they're arranged", async () => {
    const tri = [[35.2, -97.4], [35.25, -97.4], [35.25, -97.45]];
    expect((await call("POST", "/dispatch/areas", "mgr", { name: "Two corners", points: tri.slice(0, 2) })).status).toBe(400);
    const east = (await call("POST", "/dispatch/areas", "mgr", { name: "East side", color: "#16a34a", points: tri })).body;
    const west = (await call("POST", "/dispatch/areas", "mgr", { name: "West side", points: tri })).body;
    expect(east).toMatchObject({ name: "East side", color: "#16a34a" });
    expect(((await call("GET", "/dispatch/areas", "mgr")).body.areas).map((a: any) => a.name)).toEqual(["East side", "West side"]);
    await call("PUT", "/dispatch/areas", "mgr", { ids: [west.id, east.id] });
    await call("PUT", `/dispatch/areas/${east.id}`, "mgr", { name: "East Norman" });
    expect(((await call("GET", "/dispatch/areas", "mgr")).body.areas).map((a: any) => a.name)).toEqual(["West side", "East Norman"]);
    expect((await call("DELETE", `/dispatch/areas/${west.id}`, "mgr")).status).toBe(200);
    expect((await call("DELETE", `/dispatch/areas/${west.id}`, "mgr")).status).toBe(404);
  });
  it("finds an address for the map", async () => {
    expect((await call("GET", "/dispatch/locate?q=500%20Somewhere%20St", "mgr")).body).toMatchObject({ lat: 35.3, lng: -97.5 });
    expect((await call("GET", "/dispatch/locate?q=Nowhere%20at%20all", "mgr")).status).toBe(404);
  });
});

describe("settings", () => {
  it("lets admins set capacity and where routes start", async () => {
    expect((await call("PUT", "/dispatch/capacity", "mgr", { employees: [{ id: ID.ann, dailyHours: 6 }] })).status).toBe(403);
    const r = (await call("PUT", "/dispatch/capacity", "owner", { employees: [{ id: ID.ann, dailyHours: 6, weeklyHours: 30 }, { id: ID.bob, dailyHours: 8, excluded: true }] })).body;
    expect(r.people.find((p: any) => p.id === ID.ann)).toMatchObject({ dailyHours: 6, weeklyHours: 30 });
    expect(r.people.find((p: any) => p.id === ID.bob)).toMatchObject({ excluded: true });
    expect((await call("PUT", "/dispatch/settings", "owner", { routing: "estimate", startAddress: "Nowhere Rd" })).status).toBe(400);
    const s = (await call("PUT", "/dispatch/settings", "owner", { routing: "estimate", startAddress: "500 Yard St, Norman" })).body;
    expect(s.startAddress).toBe("500 Yard St, Norman");
    const b = await board();
    expect(b.start).toMatchObject({ lat: 35.3, lng: -97.5 });
    expect(b.end).toMatchObject({ lat: SHOP.lat });
    await call("PUT", "/dispatch/settings", "owner", { routing: "estimate", startAddress: "" });
    expect((await board()).start).toMatchObject({ lat: SHOP.lat });
  });
  it("measures by real roads once a routing server is switched on, and falls back to estimates if it's down", async () => {
    await call("PUT", "/dispatch/settings", "owner", { routing: "road", roadUrl });
    // The server's address is for admins: managers see that roads are on, not where it is, and it's not in the company everyone gets.
    expect((await call("GET", "/dispatch", "owner")).body.settings).toMatchObject({ routing: "road", roadUrl });
    expect((await call("GET", "/dispatch", "mgr")).body.settings).toMatchObject({ routing: "road", roadUrl: null });
    expect((await call("GET", "/auth/me", "ann")).body.company.dispatchSettings).toBeUndefined();
    const day = plus(today, 14);
    const keys = (await board(day)).events.map((e: any) => e.key);
    const p = (await call("POST", "/dispatch/routes/preview", "mgr", { date: day, keys, optimize: true, steps: true })).body;
    expect(p.measured).toBe("road");
    expect(p.stops.map((s: any) => s.leg)).toEqual([{ meters: 1000, seconds: 100 }, { meters: 1000, seconds: 100 }]);
    expect(p.totalDriveSeconds).toBe(300);
    expect(p.geometry).toEqual([[35.26, -97.465], [35.222, -97.445]]);
    expect(p.stops[0].steps[0]).toEqual({ text: "Turn left onto W Gray St", meters: 400 });
    expect(roadCalls.some((u) => u.startsWith("/table/"))).toBe(true);
    // Only coordinates are sent.
    expect(roadCalls.join(" ")).not.toMatch(/Ada|Gray%20St|Lee/);
    const saved = (await board(day)).routes[0];
    const d = (await call("GET", `/dispatch/routes/${saved.id}/directions`, "mgr")).body;
    expect(d.stops).toHaveLength(2);
    expect(d.endSteps[0].text).toContain("W Gray St");
    await call("PUT", "/dispatch/settings", "owner", { routing: "road", roadUrl: "http://127.0.0.1:9" });
    const down = (await call("POST", "/dispatch/routes/preview", "mgr", { date: day, keys })).body;
    expect(down.measured).toBe("estimate");
    expect(down.stops[0].leg.seconds).toBeGreaterThan(0);
    await call("PUT", "/dispatch/settings", "owner", { routing: "estimate" });
  });
  it("curbside arrival: brings the truck in on each stop's side of the street, and the route remembers the choice", async () => {
    await call("PUT", "/dispatch/settings", "owner", { routing: "road", roadUrl });
    const day = plus(today, 14);
    const keys = (await board(day)).events.map((e: any) => e.key);
    // Each stop from its own side; the shop at either end from any side. The best order is worked out the same way.
    const side = `approaches=${["unrestricted", ...keys.map(() => "curb"), "unrestricted"].join(";")}`;
    roadCalls.length = 0;
    const p = (await call("POST", "/dispatch/routes/preview", "mgr", { date: day, keys, curbside: true, optimize: true })).body;
    expect(p).toMatchObject({ measured: "road", curbside: true, curbsideMeasured: true });
    expect(roadCalls.find((u) => u.startsWith("/route/"))).toContain(side);
    expect(roadCalls.find((u) => u.startsWith("/table/"))).toContain(side);
    // Not asked for: the server is asked the ordinary way.
    roadCalls.length = 0;
    expect((await call("POST", "/dispatch/routes/preview", "mgr", { date: day, keys })).body).toMatchObject({ measured: "road", curbside: false, curbsideMeasured: false });
    expect(roadCalls.join(" ")).not.toContain("approaches");
    // Where the server can't do it, the route is still measured by road, and says it isn't curbside.
    refuseCurb = true;
    expect((await call("POST", "/dispatch/routes/preview", "mgr", { date: day, keys, curbside: true, optimize: true })).body).toMatchObject({ measured: "road", curbside: true, curbsideMeasured: false });
    refuseCurb = false;

    // Saved on the route. Saving it again without saying keeps the choice, and it's measured curbside from then on.
    const saved = (await board(day)).routes[0];
    expect(saved.curbside).toBe(false);
    const routeKeys = saved.stops.map((x: any) => x.key);
    await call("POST", "/dispatch/routes", "mgr", { id: saved.id, date: day, keys: routeKeys, curbside: true });
    expect((await board(day)).routes[0]).toMatchObject({ id: saved.id, curbside: true });
    roadCalls.length = 0;
    await call("POST", "/dispatch/routes", "mgr", { id: saved.id, date: day, keys: [...routeKeys].reverse() });
    expect((await board(day)).routes[0].curbside).toBe(true);
    expect(roadCalls.some((u) => u.startsWith("/route/") && u.includes("curb"))).toBe(true);
    roadCalls.length = 0;
    await call("GET", `/dispatch/routes/${saved.id}/directions`, "mgr");
    expect(roadCalls[0]).toContain("curb");
    // Switched off on the route again.
    await call("POST", "/dispatch/routes", "mgr", { id: saved.id, date: day, keys: routeKeys, curbside: false });
    expect((await board(day)).routes[0].curbside).toBe(false);

    // The company's choice for new routes: an admin's to set; saving other settings leaves it alone.
    expect((await call("PUT", "/dispatch/settings", "mgr", { routing: "road", curbside: true })).status).toBe(403);
    expect((await call("PUT", "/dispatch/settings", "owner", { routing: "road", roadUrl, curbside: true })).body.curbside).toBe(true);
    expect((await call("GET", "/dispatch", "mgr")).body.settings.curbside).toBe(true);
    expect((await call("POST", "/dispatch/routes/preview", "mgr", { date: day, keys })).body).toMatchObject({ curbside: true, curbsideMeasured: true });
    expect((await call("PUT", "/dispatch/settings", "owner", { routing: "estimate" })).body.curbside).toBe(true);
    // On estimates there are no streets to pick a side of: the choice is kept for when roads are on, and nothing claims to be curbside.
    expect((await call("POST", "/dispatch/routes/preview", "mgr", { date: day, keys, curbside: true })).body).toMatchObject({ measured: "estimate", curbside: true, curbsideMeasured: false });
    expect((await call("PUT", "/dispatch/settings", "owner", { routing: "estimate", curbside: false })).body.curbside).toBe(false);
  });
});

describe("the Dispatch board from the plan: the scheduled work as a list, edited like the waiting list", () => {
  const day = () => plus(today, 40);
  const P: Record<string, { c: string; p: string }> = {};
  const W: Record<string, string> = {};
  const list = async (d = day()) => (await call("GET", `/dispatch/list?from=${d}&to=${d}`, "mgr")).body;
  const row = async (id: string, d = day()) => (await list(d)).rows.find((r: any) => r.id === id);
  const edit = (body: Record<string, unknown>) => call("POST", "/dispatch/edit", "mgr", body);

  beforeAll(async () => {
    const mk = async (first: string, street: string, spot: { lat: number; lng: number }, n: number) => {
      const c = (await call("POST", "/customers", "owner", { firstName: first, lastName: "Board", email: email(`board-${first.toLowerCase()}`), phone: `405-555-02${n}0`, property: { street, city: "Norman", zip: "73069", lawnSqFt: 10000 } })).body.id as string;
      const p = (await call("GET", `/customers/${c}`, "owner")).body.properties[0].id as string;
      await db.update(properties).set(spot).where(eq(properties.id, p));
      return { c, p };
    };
    P.k = await mk("Kay", "10 Elm St", SPOTS.a, 1); P.l = await mk("Lou", "20 Oak St", SPOTS.b, 2); P.m = await mk("Mia", "30 Ash St", SPOTS.c, 3); P.n = await mk("Ned", "40 Fir St", SPOTS.d, 4);
    const wo = async (title: string, who: string, extra: Record<string, unknown> = {}) =>
      (await call("POST", "/visits", "owner", { title, customerId: P[who].c, propertyId: P[who].p, scheduling: extra.date === null ? "waitlist" : "single", date: day(), lines: [{ serviceTypeId: ID.fert, description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }], ...extra })).body.id as string;
    W.k = await wo("Kay round", "k", { crewId: ID.north, assigneeIds: [ID.ann] });
    W.l = await wo("Lou round", "l", { crewId: ID.north, assigneeIds: [ID.ann] });
    W.m = await wo("Mia round", "m", { date: null });
    W.n = await wo("Ned round", "n", { date: null });
  });

  it("lists the day's work orders in the waiting list's shape, with the crew, the place in the route and the status", async () => {
    const b = await list();
    expect(b.rows.map((r: any) => r.id).sort()).toEqual([W.k, W.l].sort());
    expect(b.rows.find((r: any) => r.id === W.k)).toMatchObject({
      status: "open", date: day(), crewId: ID.north, assigneeIds: [ID.ann], route: null, estMinutes: 35, estSource: "size", totalCents: 5000,
      property: { street: "10 Elm St", sqFt: 10000 }, service: { name: "Fertilizer" }, customer: { name: "Kay Board" },
    });
    expect(b.crews.find((c: any) => c.id === ID.north)).toMatchObject({ name: "North", dailyHours: 6, memberIds: [ID.ann] });
    expect(b.start).toMatchObject({ lat: SHOP.lat });
    expect(b.routes).toEqual([]);
    expect(b.today).toBe(today);
    expect((await call("GET", `/dispatch/list?from=${day()}`, "ann")).status).toBe(403);
  });

  it("Edit work orders puts waiting ones on the day, optimized into the crew's route, and says first what that adds", async () => {
    const pre = (await call("POST", "/dispatch/edit/preview", "mgr", { visitIds: [W.m, W.n], date: day(), crewId: ID.north, routeOrder: "optimize" })).body;
    expect(pre).toMatchObject({ crew: "North", capacityHours: 6, addsMinutes: 70, stops: 4, beforeMinutes: 70 });
    expect(pre.addsDriveSeconds).toBeGreaterThan(0);
    expect(pre.afterMinutes).toBe(140 + Math.round(pre.driveSeconds / 60));
    const r = (await edit({ visitIds: [W.m, W.n], to: "board", date: day(), crewId: ID.north, routeOrder: "optimize", windowStart: "13:00" })).body;
    expect(r).toMatchObject({ to: "board", scheduled: 2, moved: 2, texted: 0 });
    const b = await list();
    expect(b.rows).toHaveLength(4);
    expect(b.rows.map((x: any) => x.route?.order).sort()).toEqual([1, 2, 3, 4]);
    expect(b.routes).toHaveLength(1);
    expect(b.routes[0]).toMatchObject({ crewId: ID.north, date: day() });
    expect(b.routes[0].totalDriveSeconds).toBe(pre.driveSeconds);
    expect(await row(W.m)).toMatchObject({ crewId: ID.north, assigneeIds: [ID.ann], windowStart: "13:00", date: day(), backReason: null });
    // A window after 1 pm on a route that starts at 8: nobody is late for an open-ended window.
    expect(pre.late).toEqual([]);
  });

  it("re-optimizing a crew's day leaves its locked stops where they are, whatever order they're sent in", async () => {
    const before = (await list()).routes[0].stops.map((x: any) => x.key);
    await call("POST", "/dispatch/lock", "mgr", { key: before[0], locked: true });
    await call("POST", "/dispatch/lock", "mgr", { key: before[2], locked: true });
    const ids = [...before].reverse().map((k: string) => k.slice(2));
    expect((await edit({ visitIds: ids, to: "board", date: day(), routeOrder: "optimize" })).body).toMatchObject({ scheduled: 4, moved: 0 });
    const after = (await list()).routes[0].stops;
    expect([after[0].key, after[2].key]).toEqual([before[0], before[2]]);
    expect(after.map((x: any) => x.locked)).toEqual([true, false, true, false]);
    // "Add to the end" puts the picked ones behind the rest, in the order they had.
    await edit({ visitIds: [before[2].slice(2), before[0].slice(2)], to: "board", date: day(), routeOrder: "end" });
    const moved = (await list()).routes[0].stops.map((x: any) => x.key);
    expect(moved.slice(2)).toEqual([before[0], before[2]]);
    for (const k of [before[0], before[2]]) await call("POST", "/dispatch/lock", "mgr", { key: k, locked: false });
  });
  it("Route stops: a crew's day in the order given, with curbside arrival kept on its route through later changes", async () => {
    const before = (await list()).routes[0];
    expect(before.curbside).toBe(false);
    const order = [...before.stops.map((x: any) => x.key)].reverse();
    // The order is exactly what was sent (manual routing), and the choice is saved with it.
    const r = (await call("POST", "/dispatch/lane", "mgr", { date: day(), crewId: before.crewId, keys: order, curbside: true })).body;
    expect(r).toMatchObject({ stops: order.length, curbside: true });
    const after = (await list()).routes[0];
    expect(after).toMatchObject({ id: before.id, curbside: true });
    expect(after.stops.map((x: any) => x.key)).toEqual(order);
    // Dragging a row, optimizing the crew's day or re-measuring it later doesn't lose the choice.
    await call("POST", "/dispatch/lane", "mgr", { date: day(), crewId: before.crewId, keys: before.stops.map((x: any) => x.key) });
    expect((await list()).routes[0].curbside).toBe(true);
    await edit({ visitIds: order.map((k: string) => k.slice(2)), to: "board", date: day(), routeOrder: "optimize" });
    expect((await list()).routes[0].curbside).toBe(true);
    // And off again.
    await call("POST", "/dispatch/lane", "mgr", { date: day(), crewId: before.crewId, keys: (await list()).routes[0].stops.map((x: any) => x.key), curbside: false });
    expect((await list()).routes[0].curbside).toBe(false);
    // The board is told the company's choice for new routes, to start the tick box from.
    expect((await list()).curbside).toBe(false);
  });

  it("moves work orders to another crew at the end of its route, keeps the order, or keeps the crew and changes the day", async () => {
    expect((await edit({ visitIds: [W.k], to: "board", date: day(), crewId: ID.south, routeOrder: "end" })).body).toMatchObject({ scheduled: 1, moved: 1 });
    expect(await row(W.k)).toMatchObject({ crewId: ID.south, assigneeIds: [ID.bob], route: { order: 1 } });
    let b = await list();
    // North's route closed up behind it.
    expect(b.rows.filter((x: any) => x.crewId === ID.north).map((x: any) => x.route.order).sort()).toEqual([1, 2, 3]);
    await edit({ visitIds: [W.l], to: "board", date: day(), crewId: ID.south, routeOrder: "end" });
    expect((await row(W.l)).route).toMatchObject({ order: 2 });
    // "Keep the current order": it joins the crew with no place in the route yet.
    await edit({ visitIds: [W.m], to: "board", date: day(), crewId: ID.south, routeOrder: "keep" });
    expect(await row(W.m)).toMatchObject({ crewId: ID.south, route: null });
    b = await list();
    expect(b.routes.find((x: any) => x.crewId === ID.south).stops.map((s: any) => s.key)).toEqual([`v:${W.k}`, `v:${W.l}`]);
    // With no crew named, each keeps its crew; a new day starts that crew's route there.
    const next = plus(day(), 1);
    expect((await edit({ visitIds: [W.n], to: "board", date: next, routeOrder: "end" })).body.moved).toBe(1);
    expect(await row(W.n, next)).toMatchObject({ crewId: ID.north, date: next, route: { order: 1 } });
    expect((await list()).routes.some((x: any) => x.crewId === ID.north)).toBe(false);
    // The week's workload counts the drive with the time on site.
    const w = (await call("GET", `/waitlist/workload?from=${day()}&days=2`, "mgr")).body;
    const south = w.crews.find((c: any) => c.id === ID.south).days[0];
    expect(south).toMatchObject({ count: 3, hours: 1.8 });
    expect(south.drive).toBeGreaterThan(0);
    expect(w.crews.find((c: any) => c.id === ID.north).days[1]).toMatchObject({ count: 1 });
  });

  it("sends them back to the waiting list with why, and won't move ones already done", async () => {
    expect((await edit({ visitIds: [W.m], to: "waitlist" })).status).toBe(400);
    expect((await edit({ visitIds: [W.m], to: "board" })).status).toBe(400);
    expect((await edit({ visitIds: [W.m], to: "waitlist", reason: "wind", note: "Gusts over 20" })).body).toMatchObject({ to: "waitlist", moved: 1 });
    const [m] = await db.select().from(visits).where(eq(visits.id, W.m));
    expect(m).toMatchObject({ date: null, backReason: "Wind: Gusts over 20", releaseOn: day() });
    expect(await row(W.m)).toBeUndefined();
    expect((await edit({ visitIds: [W.m], to: "waitlist", reason: "rain" })).status).toBe(400);
    await db.update(visits).set({ status: "completed", completedAt: new Date() }).where(eq(visits.id, W.k));
    expect((await row(W.k)).status).toBe("completed");
    expect((await edit({ visitIds: [W.k], to: "board", date: plus(day(), 2) })).status).toBe(400);
    expect((await edit({ visitIds: [W.k], to: "waitlist", reason: "rain" })).status).toBe(400);
    expect((await edit({ visitIds: [W.l], to: "board", date: day(), crewId: ID.north }, )).status).toBe(200);
    expect((await call("POST", "/dispatch/edit", "ann", { visitIds: [W.l], to: "waitlist", reason: "rain" })).status).toBe(403);
  });

  it("saves the board's own views (filters, columns and sort), apart from the waiting list's", async () => {
    const saved = (await call("POST", "/waitlist/views", "mgr", { page: "dispatch", name: "Not done yet", shared: false, config: { filters: [{ key: "status", value: "open" }], columns: ["property", "service", "status"], sort: { key: "route", dir: "asc" } } })).body;
    expect(saved).toMatchObject({ name: "Not done yet", mine: true });
    expect((await call("GET", "/waitlist/views?page=dispatch", "mgr")).body.map((x: any) => x.name)).toContain("Not done yet");
    expect((await call("GET", "/waitlist/views?page=waitlist", "mgr")).body.map((x: any) => x.name)).not.toContain("Not done yet");
  });
});
