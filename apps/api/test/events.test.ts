/** The Calendar page's data: every type in one shape, who sees what, unscheduled repair orders and drag-to-move. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { holidays, ptoPolicies, ptoRequests, shifts } from "../src/db/schema";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@events.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";
let companyId = "";
let BRAKE = "";
let WIPERS = "";
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const range = (who: string, from = plus(today, -3), to = plus(today, 10)) => call("GET", `/events?from=${from}&to=${to}`, who);
const keys = (r: { body: { events: { type: string; title: string }[] } }) => r.body.events.map((e) => `${e.type}:${e.title}`).sort();

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Events Co", firstName: "Eve", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Events Co", timezone: "America/Chicago" });
  companyId = (await call("GET", "/auth/me", "owner")).body.company.id;
  for (const [who, role] of [["tech", "employee"], ["other", "employee"]] as const) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  ID.asset = (await call("POST", "/assets", "owner", { name: "Truck 2", type: "truck" })).body.id;

  ID.todo = (await call("POST", "/todos", "owner", { title: "Walk the Elm St job", date: today, startTime: "09:00", endTime: "10:00", budgetedHours: 1, assigneeIds: [ID.tech], color: "#16a34a" })).body.id;
  ID.span = (await call("POST", "/todos", "owner", { title: "Spring cleanup", date: plus(today, 1), endDate: plus(today, 3), assigneeIds: [ID.other] })).body.id;
  const brake = (await call("POST", "/work-orders", "owner", { assetId: ID.asset, title: "Brake pads", dueDate: plus(today, 2), assignedToId: ID.tech })).body;
  const wipers = (await call("POST", "/work-orders", "owner", { assetId: ID.asset, title: "Wiper blades" })).body;
  ID.repair = brake.id; ID.loose = wipers.id;
  BRAKE = `#${brake.number} Brake pads`; WIPERS = `#${wipers.number} Wiper blades`;
  const [policy] = await db.insert(ptoPolicies).values({ companyId, name: "Vacation" }).returning();
  await db.insert(ptoRequests).values([
    { companyId, employeeId: ID.tech, policyId: policy.id, startDate: plus(today, 4), endDate: plus(today, 5), hours: 16, status: "approved" },
    { companyId, employeeId: ID.other, policyId: policy.id, startDate: plus(today, 6), endDate: plus(today, 6), hours: 8, status: "pending" },
  ]);
  await db.insert(holidays).values({ companyId, name: "Founders Day", rule: { kind: "once", date: plus(today, 7) }, hours: 8, observe: "none" });
  // A published shift for the tech at 7:00–15:30 Chicago time on the day after tomorrow, and a draft.
  const day = plus(today, 2);
  const chicago = (h: number, m = 0) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-06:00`);
  await db.insert(shifts).values([
    { companyId, employeeId: ID.tech, startsAt: chicago(7), endsAt: chicago(15, 30), position: "Crew lead", status: "published" },
    { companyId, employeeId: ID.other, startsAt: chicago(8), endsAt: chicago(12), status: "draft" },
  ]);
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("calendar events", () => {
  it("the owner sees every type in one shape", async () => {
    const r = await range("owner");
    expect(r.status).toBe(200);
    expect(r.body.today).toBe(today);
    expect(keys(r)).toEqual([
      "holiday:Founders Day", `repair:${BRAKE}`, "shift:other Person", "shift:tech Person · Crew lead",
      "timeoff:tech Person off", "todo:Spring cleanup", "todo:Walk the Elm St job",
    ].sort());
    const ev = (t: string) => r.body.events.find((e: any) => e.title === t);
    expect(ev("Walk the Elm St job")).toMatchObject({ type: "todo", date: today, startTime: "09:00", endTime: "10:00", color: "#16a34a", hours: 1, people: [{ id: ID.tech, name: "tech Person" }], canMove: true, canComplete: true, href: `/todos?open=${ID.todo}` });
    expect(ev("Spring cleanup")).toMatchObject({ date: plus(today, 1), endDate: plus(today, 3) });
    expect(ev(BRAKE)).toMatchObject({ type: "repair", date: plus(today, 2), location: "Truck 2", statusLabel: "Open", people: [{ name: "tech Person" }], canMove: true });
    expect(ev("tech Person off")).toMatchObject({ type: "timeoff", date: plus(today, 4), endDate: plus(today, 5), hours: 16, statusLabel: "Approved" });
    expect(ev("tech Person · Crew lead")).toMatchObject({ type: "shift", date: plus(today, 2), startTime: "07:00", endTime: "15:30", hours: 8.5, statusLabel: "Published" });
    expect(ev("other Person")).toMatchObject({ statusLabel: "Draft" });
    expect(ev("Founders Day")).toMatchObject({ type: "holiday", date: plus(today, 7) });
  });

  it("a tech sees their own to-dos and time off, every repair order, published shifts and holidays", async () => {
    const r = await range("tech");
    expect(keys(r)).toEqual([
      "holiday:Founders Day", `repair:${BRAKE}`, "shift:tech Person · Crew lead", "timeoff:Time off (Vacation)", "todo:Walk the Elm St job",
    ].sort());
    const repair = r.body.events.find((e: any) => e.type === "repair");
    // Assigned to them: they can check it off, but only fleet managers reschedule.
    expect(repair).toMatchObject({ canMove: false, canComplete: true });
    expect(r.body.events.find((e: any) => e.type === "todo")).toMatchObject({ canMove: false, canComplete: true });
    // Someone else's view: no to-dos or time off of the tech's.
    expect(keys(await range("other"))).toEqual(["holiday:Founders Day", `repair:${BRAKE}`, "shift:tech Person · Crew lead", "todo:Spring cleanup"].sort());
  });

  it("only shows what's in the range, and checks the range", async () => {
    expect(keys(await range("owner", plus(today, 4), plus(today, 4)))).toEqual(["timeoff:tech Person off"]);
    // A multi-day to-do that started before the range still shows.
    expect(keys(await range("owner", plus(today, 3), plus(today, 3)))).toEqual(["todo:Spring cleanup"]);
    expect((await range("owner", plus(today, 5), today)).status).toBe(400);
    expect((await range("owner", today, plus(today, 200))).status).toBe(400);
  });

  it("lists open repair orders with no due date for the Unscheduled panel", async () => {
    const r = await call("GET", "/events/unscheduled", "owner");
    expect(r.body.map((e: any) => e.title)).toEqual([WIPERS]);
    expect(r.body[0]).toMatchObject({ type: "repair", date: "", canMove: true });
  });

  it("drag and drop: to-dos keep their length; repair orders need a fleet manager", async () => {
    expect((await call("POST", "/events/move", "owner", { type: "todo", id: ID.span, date: plus(today, 8) })).status).toBe(200);
    const span = (await call("GET", `/todos/${ID.span}`, "owner")).body;
    expect([span.date, span.endDate]).toEqual([plus(today, 8), plus(today, 10)]);
    // The tech didn't make the owner's to-do, and isn't a fleet manager.
    expect((await call("POST", "/events/move", "tech", { type: "todo", id: ID.todo, date: plus(today, 1) })).status).toBe(403);
    expect((await call("POST", "/events/move", "tech", { type: "repair", id: ID.repair, date: plus(today, 1) })).status).toBe(403);
    // Someone who can't see the to-do gets "not found".
    expect((await call("POST", "/events/move", "other", { type: "todo", id: ID.todo, date: plus(today, 1) })).status).toBe(404);
    // Scheduling the unscheduled repair order.
    expect((await call("POST", "/events/move", "owner", { type: "repair", id: ID.loose, date: today })).status).toBe(200);
    expect((await call("GET", "/events/unscheduled", "owner")).body).toEqual([]);
    expect(keys(await range("owner", today, today))).toEqual([`repair:${WIPERS}`, "todo:Walk the Elm St job"]);
  });
});
