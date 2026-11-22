/** Work orders (customer jobs): who sees and schedules them, the crew's steps, series, waitlist, invoicing, calendar, reminders, search. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { workOrderReminders } from "../src/lib/jobs";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@visits.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}
const inbox = async (who: string) => { await flushNotifications(); return (await call("GET", "/notifications", who)).body.items as any[]; };
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const order = (over: Record<string, unknown> = {}) => ({
  title: "Round 3: fertilizer & weed control", customerId: ID.jane, propertyId: ID.janeProp, date: today, startTime: "08:00",
  lines: [{ serviceTypeId: ID.fert, description: "Fertilizer & weed control", quantity: 1, budgetedHours: 0.5, unitPriceCents: 6500 },
    { description: "Edge beds", quantity: 2, budgetedHours: 0.25, unitPriceCents: 1500 }],
  assigneeIds: [ID.tech], notes: "Gate code on file; dog in back", ...over,
});

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Visits Co", firstName: "Val", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Visits Co", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"], ["other", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  await call("POST", "/crm/sample-customers", "owner");
  ID.jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "office")).body.properties[0].id;
  const pm = (await call("GET", "/customers?q=prairie", "office")).body.rows[0].id;
  ID.pmProp = (await call("GET", `/customers/${pm}`, "office")).body.properties[0].id;
  ID.fert = (await call("POST", "/service-types", "owner", { name: "Fertilizer & weed control", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000" })).body.id;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("work orders", () => {
  it("the office schedules one with line items and crew; the tech is told and sees it without prices", async () => {
    const r = await call("POST", "/visits", "office", order());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ number: 1001, status: "open", totalCents: 9500, budgetedHours: 0.75, created: 1, customer: { name: "Jane Example" }, assignees: [{ id: ID.tech }], statusLabel: "Open", invoiced: false });
    expect(r.body.lines.map((l: any) => l.amountCents)).toEqual([6500, 3000]);
    ID.wo = r.body.id;
    const note = (await inbox("tech")).find((n) => n.title === "New work order: Round 3: fertilizer & weed control");
    expect(note).toMatchObject({ category: "workorders", link: { screen: "workorder", id: ID.wo } });
    expect(note.body).toContain("WO-1001");
    expect(note.body).toContain("8:00 AM");
    const mine = await call("GET", `/visits/${ID.wo}`, "tech");
    expect(mine.body).toMatchObject({ totalCents: null, isCrew: true, canManage: false, property: { address: expect.stringContaining("Bluestem") } });
    expect(mine.body.lines.map((l: any) => [l.description, l.unitPriceCents])).toEqual([["Fertilizer & weed control", null], ["Edge beds", null]]);
    expect((await call("GET", `/visits/${ID.wo}`, "other")).status).toBe(404);
    expect((await call("GET", "/visits", "other")).body.items).toEqual([]);
  });

  it("only Customers & billing managers schedule, and the property must be the customer's", async () => {
    expect((await call("POST", "/visits", "tech", order())).status).toBe(403);
    const wrong = await call("POST", "/visits", "office", order({ propertyId: ID.pmProp }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/isn't one of this customer's/);
    expect((await call("POST", "/visits", "office", order({ date: "" }))).body.issues[0].message).toMatch(/waitlist/);
  });

  it("the crew arrives, finishes with notes; others skip; undo works", async () => {
    expect((await call("POST", `/visits/${ID.wo}/start`, "other")).status).toBe(404);
    expect((await call("POST", `/visits/${ID.wo}/start`, "tech")).body).toMatchObject({ status: "on_site", statusLabel: "On site" });
    const done = await call("POST", `/visits/${ID.wo}/complete`, "tech", { notes: "Applied round 3. Back gate was open." });
    expect(done.body).toMatchObject({ status: "completed", completionNotes: "Applied round 3. Back gate was open.", finishedBy: "tech Person" });
    expect(done.body.trackedMinutes).toBe(0);
    const second = (await call("POST", "/visits", "office", order({ title: "Aeration", date: plus(today, 1) }))).body;
    expect((await call("POST", `/visits/${second.id}/skip`, "tech", {})).status).toBe(400);
    expect((await call("POST", `/visits/${second.id}/skip`, "tech", { reason: "Rain" })).body).toMatchObject({ status: "skipped", skipReason: "Rain" });
    expect((await call("POST", `/visits/${second.id}/reopen`, "tech")).body).toMatchObject({ status: "open", skipReason: null });
    ID.second = second.id;
  });

  it("invoicing: a draft invoice from one, or several in one go; not twice", async () => {
    const r = await call("POST", `/visits/${ID.wo}/invoice`, "office");
    expect(r.status).toBe(200);
    const inv = (await call("GET", `/invoices/${r.body.invoiceId}`, "office")).body;
    expect(inv).toMatchObject({ status: "draft", totalCents: 9500, customerId: ID.jane, propertyId: ID.janeProp, notes: "Work order WO-1001" });
    expect(inv.lines.map((l: any) => [l.description, l.quantity, l.unitPriceCents])).toEqual([["Fertilizer & weed control", 1, 6500], ["Edge beds", 2, 1500]]);
    expect((await call("GET", `/visits/${ID.wo}`, "office")).body).toMatchObject({ invoiced: true, invoice: { id: r.body.invoiceId, status: "draft" } });
    expect((await call("POST", `/visits/${ID.wo}/invoice`, "office")).body.error).toMatch(/already on an invoice/);
    expect((await call("POST", `/visits/${ID.wo}/reopen`, "office")).body.error).toMatch(/void the invoice first/);
    expect((await call("POST", `/visits/${ID.wo}/invoice`, "tech")).status).toBe(403);
    // Deleting the draft makes it ready to invoice again.
    await call("DELETE", `/invoices/${r.body.invoiceId}`, "office");
    expect((await call("GET", "/visits?invoiceable=true", "office")).body.items.map((v: any) => v.id)).toEqual([ID.wo]);
    // Two finished work orders at the same property: one invoice, lines dated.
    await call("POST", `/visits/${ID.second}/complete`, "office", {});
    const many = await call("POST", "/visits/invoice", "office", { ids: [ID.wo, ID.second] });
    expect(many.body).toMatchObject({ summary: "1 draft invoice for $190.00", totalCents: 19000 });
    const both = (await call("GET", `/invoices/${many.body.invoices[0].id}`, "office")).body;
    expect(both.notes).toBe("Work orders WO-1001, WO-1002");
    expect(both.lines).toHaveLength(4);
    expect(both.lines[0].description).toMatch(/^\w{3}, \w{3} \d+: Fertilizer & weed control$/);
  });

  it("repeating with an off-season; change or delete this and later ones", async () => {
    const r = await call("POST", "/visits", "office", order({ title: "Monthly bed check", date: plus(today, 2), scheduling: "repeat", repeatUnit: "week", repeatEvery: 2, repeatUntil: plus(today, 2 + 14 * 4) }));
    expect(r.body.created).toBe(5);
    expect(r.body.repeatLabel).toBe("Every 2 weeks");
    const series = (await call("GET", "/visits?q=monthly%20bed", "office")).body.items;
    expect(series.map((v: any) => v.date)).toEqual([0, 14, 28, 42, 56].map((n) => plus(today, 2 + n)));
    expect(series.map((v: any) => v.number)).toEqual([1003, 1004, 1005, 1006, 1007]);
    const moved = await call("PUT", `/visits/${series[2].id}?applyTo=following`, "office", order({ title: "Monthly bed check", date: plus(today, 31), assigneeIds: [ID.other] }));
    expect(moved.body.changed).toBe(3);
    const after = (await call("GET", "/visits?q=monthly%20bed", "office")).body.items;
    expect(after.map((v: any) => v.date)).toEqual([plus(today, 2), plus(today, 16), plus(today, 31), plus(today, 45), plus(today, 59)]);
    expect(after.slice(2).every((v: any) => v.assignees[0].id === ID.other)).toBe(true);
    expect((await call("DELETE", `/visits/${series[1].id}?scope=following`, "office")).body.deleted).toBe(4);
    expect((await call("GET", "/visits?q=monthly%20bed", "office")).body.items).toHaveLength(1);
    // A whole series inside the off-season is refused.
    const winter = await call("POST", "/visits", "office", order({ title: "Winter", date: "2027-12-05", scheduling: "repeat", repeatUntil: "2027-12-26", offMonths: [12] }));
    expect(winter.body.error).toMatch(/off-season/);
  });

  it("the waitlist: no date until it's dragged onto the calendar", async () => {
    const w = await call("POST", "/visits", "office", order({ title: "Dethatch when dry", date: "", scheduling: "waitlist" }));
    expect(w.body.date).toBeNull();
    const panel = (await call("GET", "/events/unscheduled", "office")).body;
    expect(panel.map((e: any) => `${e.type}:${e.title}`)).toEqual(["visit:Dethatch when dry"]);
    expect(panel[0]).toMatchObject({ amountCents: 9500, canMove: true });
    expect((await call("POST", "/events/move", "tech", { type: "visit", id: w.body.id, date: today })).status).toBe(403);
    expect((await call("POST", "/events/move", "office", { type: "visit", id: w.body.id, date: plus(today, 3) })).status).toBe(200);
    expect((await call("GET", `/visits/${w.body.id}`, "office")).body.date).toBe(plus(today, 3));
    ID.dethatch = w.body.id;
  });

  it("shows on the calendar with revenue for the office and not for the crew", async () => {
    const range = `/events?from=${today}&to=${plus(today, 6)}`;
    const office = (await call("GET", range, "office")).body.events.filter((e: any) => e.type === "visit");
    const dethatch = office.find((e: any) => e.id === ID.dethatch);
    expect(dethatch).toMatchObject({ amountCents: 9500, invoiced: false, onSite: false, serviceIds: [ID.fert], canMove: true, statusLabel: expect.stringMatching(/^WO-\d+ · Open$/) });
    expect(office.find((e: any) => e.id === ID.wo)).toMatchObject({ status: "done", invoiced: true });
    const tech = (await call("GET", range, "tech")).body.events.filter((e: any) => e.type === "visit");
    expect(tech.find((e: any) => e.id === ID.dethatch)).toMatchObject({ amountCents: null, canMove: false, canComplete: true });
  });

  it("reminds the crew the morning of, and search finds WO numbers", async () => {
    const day = plus(today, 3);
    await workOrderReminders(new Date(`${day}T14:30:00Z`));
    await workOrderReminders(new Date(`${day}T15:30:00Z`));
    const got = (await inbox("tech")).filter((n) => n.title === "Work order today: Dethatch when dry");
    expect(got).toHaveLength(1);
    expect(got[0].body).toMatch(/^WO-\d+ · 8:00 AM · .*Bluestem/);
    const num = (await call("GET", `/visits/${ID.dethatch}`, "office")).body.number;
    for (const q of [`WO-${num}`, `wo%20${num}`]) {
      expect((await call("GET", `/search?q=${q}`, "office")).body.results.find((h: any) => h.kind === "visit"), q).toMatchObject({ title: `WO-${num} Dethatch when dry`, href: `/visits/${ID.dethatch}` });
    }
    expect((await call("GET", "/search?q=dethatch", "other")).body.results.filter((h: any) => h.kind === "visit")).toEqual([]);
  });
});
