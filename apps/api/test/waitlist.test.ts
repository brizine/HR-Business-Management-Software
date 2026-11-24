/** The waiting list: windows, badges, the card rule, time estimates, workload, scheduling, back, bulk and saved views. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { customerPaymentMethods, customers, visits } from "../src/db/schema";
import { setPushTransport } from "../src/lib/notify";
import { setEmailTransport } from "../src/lib/channels";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@waitlist.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";
let companyId = "";
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
const list = async (q = "") => (await call("GET", `/waitlist${q}`, "owner")).body;
const row = async (id: string, q = "") => (await list(q)).rows.find((r: any) => r.id === id);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async () => {} });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Wait Co", firstName: "Wren", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Wait Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@waitlist.test", timezone: "America/Chicago" });
  ID.mgr = (await call("POST", "/employees", "owner", { firstName: "Mo", lastName: "Manager", email: email("mgr"), password: "password123", role: "manager" })).body.id;
  T.mgr = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("mgr"), password: "password123" } })).json().token;
  ID.tech = (await call("POST", "/employees", "owner", { firstName: "Tia", lastName: "Tech", email: email("tech"), password: "password123", role: "employee" })).body.id;
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;

  ID.fert = (await call("POST", "/service-types", "owner", { name: "Fertilizer", priceCents: 5000, setupMinutes: 5, minutesPer1000: 3 })).body.id;
  ID.crew = (await call("POST", "/crews", "owner", { name: "North", color: "#2563eb", memberIds: [ID.tech], dailyHours: 6 })).body.id;
  const customer = async (first: string, prop: Record<string, unknown>) => {
    const c = (await call("POST", "/customers", "owner", { firstName: first, lastName: "Lee", email: email(first.toLowerCase()), property: { city: "Norman", zip: "73069", ...prop } })).body.id as string;
    return { c, p: (await call("GET", `/customers/${c}`, "owner")).body.properties[0].id as string };
  };
  const a = await customer("Ann", { street: "1 Oak St", lawnSqFt: 10000, pets: "Two dogs" });
  const b = await customer("Bob", { street: "2 Elm St", lawnSqFt: 4000 });
  Object.assign(ID, { ann: a.c, annProp: a.p, bob: b.c, bobProp: b.p });
  companyId = (await db.select({ companyId: customers.companyId }).from(customers).where(eq(customers.id, b.c)))[0].companyId;
  const wo = async (title: string, c: { c: string; p: string }, extra: Record<string, unknown> = {}) =>
    (await call("POST", "/visits", "owner", { title, customerId: c.c, propertyId: c.p, scheduling: extra.date ? "single" : "waitlist", lines: [{ serviceTypeId: ID.fert, description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }], ...extra })).body.id as string;
  // Ann: done 10 days ago; the next round waits at least 21 days, due in 5 days.
  ID.done = await wo("Round 1", a, { date: plus(today, -10) });
  await call("POST", `/visits/${ID.done}/complete`, "owner", {});
  await db.update(visits).set({ startedAt: new Date(Date.now() - 45 * 60_000), completedAt: new Date() }).where(eq(visits.id, ID.done));
  ID.annNext = await wo("Round 2", a, { minDaysAfterLast: 21, dueBy: plus(today, 5), priority: "high", windowStart: "13:00" });
  ID.bobNext = await wo("Round 2", b);
  ID.later = await wo("Round 3", b, { releaseOn: plus(today, 30) });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("waiting list", () => {
  it("lists undated open work orders with their window, badges and time estimate", async () => {
    const l = await list();
    expect(l.today).toBe(today);
    expect(l.requireCard).toBe(false);
    expect(l.crews).toMatchObject([{ id: ID.crew, name: "North", dailyHours: 6 }]);
    const ids = l.rows.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ID.annNext, ID.bobNext]));
    // Released later: only with "upcoming".
    expect(ids).not.toContain(ID.later);
    expect(ids).not.toContain(ID.done);
    expect((await list("?upcoming=1")).rows.map((r: any) => r.id)).toContain(ID.later);

    const ann = l.rows.find((r: any) => r.id === ID.annNext);
    expect(ann).toMatchObject({
      lastServiceOn: plus(today, -10), eligible: plus(today, 11), dueBy: plus(today, 5), priority: "high", windowStart: "13:00",
      service: { name: "Fertilizer" }, customer: { name: "Ann Lee" }, property: { street: "1 Oak St", sqFt: 10000 }, totalCents: 5000, needsCard: false,
    });
    expect(ann.badges).toEqual(["closing", "early", "high", "dog"]);
    // One visit (45 min) and the size estimate (5 + 3 × 10 = 35): half and half.
    expect(ann).toMatchObject({ estMinutes: 40, estSource: "history" });
    // Bob: no history, so from size: 5 + 3 × 4 = 17.
    expect(await row(ID.bobNext)).toMatchObject({ estMinutes: 17, estSource: "size", badges: [], eligible: null });
  });

  it("is for managers", async () => {
    expect((await call("GET", "/waitlist", "tech")).status).toBe(403);
    expect((await call("GET", "/waitlist", "mgr")).status).toBe(200);
  });

  it("won't schedule before the eligible date without a reason, and records it", async () => {
    const date = plus(today, 2);
    const no = await call("POST", "/waitlist/schedule", "owner", { visitIds: [ID.annNext, ID.bobNext], date, crewId: ID.crew });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/eligible/);
    const ok = await call("POST", "/waitlist/schedule", "mgr", { visitIds: [ID.annNext, ID.bobNext], date, crewId: ID.crew, makePreferred: true, notify: true, earlyReason: "Customer asked for it before the party" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ scheduled: 2, early: 1, texted: 0 });
    const [v] = await db.select().from(visits).where(eq(visits.id, ID.annNext));
    expect(v).toMatchObject({ date, crewId: ID.crew, earlyReason: "Customer asked for it before the party", earlyById: ID.mgr, waitingSince: null });
    const [b] = await db.select().from(visits).where(eq(visits.id, ID.bobNext));
    expect(b.earlyReason).toBeNull();
    // The crew's people do it, and it's now the property's preferred crew.
    expect((await call("GET", `/visits/${ID.bobNext}`, "owner")).body.assignees.map((x: any) => x.id)).toContain(ID.tech);
    expect((await list()).rows.map((r: any) => r.id)).not.toContain(ID.annNext);
  });

  it("shows the booked hours per crew against their day", async () => {
    const w = (await call("GET", `/waitlist/workload?from=${today}&days=7`, "owner")).body;
    expect(w.dates).toHaveLength(7);
    const north = w.crews.find((c: any) => c.id === ID.crew);
    expect(north.dailyHours).toBe(6);
    // Ann (40 min) + Bob (17 min) on day 3, to the tenth of an hour.
    expect(north.days[2]).toEqual({ count: 2, hours: 1 });
    expect(north.days[0]).toEqual({ count: 0, hours: 0 });
  });

  it("goes back to the list with a reason (rain)", async () => {
    const r = await call("POST", "/waitlist/back", "owner", { visitIds: [ID.bobNext], reason: "rain", note: "Storms all afternoon" });
    expect(r.body).toEqual({ moved: 1 });
    const back = await row(ID.bobNext);
    expect(back).toMatchObject({ date: null, backReason: "Rain: Storms all afternoon", preferredCrewId: ID.crew });
    expect((await call("POST", "/waitlist/back", "owner", { visitIds: [ID.done], reason: "rain" })).status).toBe(400);
  });

  it("needs a card on file when the company says so, unless excused", async () => {
    expect((await call("PUT", "/waitlist/settings", "mgr", { requireCardOnFile: true })).status).toBe(403);
    expect((await call("PUT", "/waitlist/settings", "owner", { requireCardOnFile: true })).status).toBe(200);
    // Saving the other billing settings keeps it.
    const s = (await call("GET", "/invoices/settings", "owner")).body;
    await call("PUT", "/invoices/settings", "owner", { ...s, requireCardOnFile: undefined, lateFees: undefined, autoSend: undefined, estimateDeposit: undefined });
    expect((await call("GET", "/invoices/settings", "owner")).body.requireCardOnFile).toBe(true);

    expect(await row(ID.bobNext)).toMatchObject({ needsCard: true, badges: ["needs_card"] });
    const no = await call("POST", "/waitlist/schedule", "owner", { visitIds: [ID.bobNext], date: plus(today, 3) });
    expect(no.status).toBe(409);
    expect(no.body.error).toMatch(/Bob Lee/);

    // An expired card doesn't count; a good one does.
    const [y] = today.split("-").map(Number);
    await db.insert(customerPaymentMethods).values({ companyId, customerId: ID.bob, stripePaymentMethodId: "pm_old", type: "card", brand: "visa", last4: "4242", expMonth: 1, expYear: y - 1 });
    expect((await row(ID.bobNext)).needsCard).toBe(true);
    await db.insert(customerPaymentMethods).values({ companyId, customerId: ID.bob, stripePaymentMethodId: "pm_new", type: "card", brand: "visa", last4: "4444", expMonth: 12, expYear: y + 2 });
    expect((await row(ID.bobNext)).needsCard).toBe(false);
    await db.delete(customerPaymentMethods).where(eq(customerPaymentMethods.customerId, ID.bob));

    // Excused (with why), then back on.
    expect((await call("PUT", "/waitlist/card-exempt", "owner", { customerId: ID.bob, exempt: true })).status).toBe(400);
    await call("PUT", "/waitlist/card-exempt", "owner", { customerId: ID.bob, exempt: true, reason: "Pays by check, net 30" });
    expect((await row(ID.bobNext)).needsCard).toBe(false);
    await call("PUT", "/waitlist/card-exempt", "owner", { customerId: ID.bob, exempt: false });
    expect((await row(ID.bobNext)).needsCard).toBe(true);
    await call("PUT", "/waitlist/card-exempt", "owner", { propertyId: ID.bobProp, exempt: true, reason: "Commercial account" });
    expect((await row(ID.bobNext)).needsCard).toBe(false);
    await call("PUT", "/waitlist/settings", "owner", { requireCardOnFile: false });
  });

  it("keeps how the customer wants to hear before a visit (the property can differ)", async () => {
    await call("PUT", `/waitlist/customer/${ID.bob}`, "owner", { notifyBefore: "call" });
    expect((await row(ID.bobNext)).badges).toContain("call_ahead");
    await call("PUT", `/waitlist/property/${ID.bobProp}`, "owner", { notifyBefore: "text", preferredCrewId: null });
    expect(await row(ID.bobNext)).toMatchObject({ badges: ["text_ahead"], preferredCrewId: null, customer: { notifyBefore: "call" } });
    const r = await call("POST", "/waitlist/schedule", "owner", { visitIds: [ID.bobNext], date: plus(today, 4), notify: true });
    // Texting isn't connected: counted as not texted.
    expect(r.body).toMatchObject({ scheduled: 1, texted: 0, notTexted: 1, toCall: [] });
    await call("POST", "/waitlist/back", "owner", { visitIds: [ID.bobNext], reason: "customer" });
  });

  it("does things to many at once: priority, skip, delete", async () => {
    expect((await call("POST", "/waitlist/bulk", "owner", { visitIds: [ID.bobNext, ID.later], action: "priority", priority: "low" })).body).toEqual({ done: 2, kept: 0 });
    expect((await row(ID.later, "?upcoming=1")).priority).toBe("low");
    expect((await call("POST", "/waitlist/bulk", "owner", { visitIds: [ID.bobNext], action: "skip" })).status).toBe(400);
    expect((await call("POST", "/waitlist/bulk", "owner", { visitIds: [ID.bobNext], action: "skip", reason: "Moved away" })).body).toEqual({ done: 1, kept: 0 });
    expect(await row(ID.bobNext)).toBeUndefined();
    expect((await call("POST", "/waitlist/bulk", "mgr", { visitIds: [ID.later], action: "delete" })).status).toBe(403);
    expect((await call("POST", "/waitlist/bulk", "owner", { visitIds: [ID.later, ID.done], action: "delete" })).body).toEqual({ done: 1, kept: 1 });
    expect((await call("GET", `/visits/${ID.later}`, "owner")).status).toBe(404);
  });

  it("saves views for you or for everyone", async () => {
    const config = { filters: [{ key: "badge", value: "closing" }], columns: ["customer", "service", "due"], sort: { key: "due", dir: "asc" } };
    const mine = (await call("POST", "/waitlist/views", "mgr", { page: "waitlist", name: "Closing soon", config })).body;
    const shared = (await call("POST", "/waitlist/views", "mgr", { page: "waitlist", name: "Everyone", shared: true, config })).body;
    expect(mine).toMatchObject({ name: "Closing soon", shared: false, mine: true, config });
    expect((await call("GET", "/waitlist/views", "mgr")).body.map((v: any) => v.name)).toEqual(["Closing soon", "Everyone"]);
    // The owner sees the shared one, not the manager's own.
    expect((await call("GET", "/waitlist/views", "owner")).body.map((v: any) => v.name)).toEqual(["Everyone"]);
    expect((await call("DELETE", `/waitlist/views/${mine.id}`, "owner")).status).toBe(403);
    expect((await call("DELETE", `/waitlist/views/${shared.id}`, "mgr")).status).toBe(403);
    expect((await call("DELETE", `/waitlist/views/${shared.id}`, "owner")).status).toBe(200);
    expect((await call("DELETE", `/waitlist/views/${mine.id}`, "mgr")).status).toBe(200);
  });

  it("keeps waiting-since: set when made undated, and when the date is removed", async () => {
    const [b] = await db.select().from(visits).where(eq(visits.id, ID.annNext));
    expect(b.waitingSince).toBeNull();
    const v = (await call("GET", `/visits/${ID.annNext}`, "owner")).body;
    await call("PUT", `/visits/${ID.annNext}`, "owner", { ...v, date: null, lines: v.lines.map((l: any) => ({ serviceTypeId: l.serviceTypeId, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents })) });
    const [a] = await db.select().from(visits).where(eq(visits.id, ID.annNext));
    expect(a.date).toBeNull();
    expect(a.waitingSince).not.toBeNull();
  });
});
