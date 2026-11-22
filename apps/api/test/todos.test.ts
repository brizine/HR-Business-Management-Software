/** To-dos: who sees and changes them, customer links, repeating series, checking off, reminders and search. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { todoReminders } from "../src/lib/jobs";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@todos.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const inbox = async (who: string) => { await flushNotifications(); return (await call("GET", "/notifications", who)).body.items as any[]; };
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Todo Co", firstName: "Tia", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"], ["other", "employee"]] as const) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  await call("POST", "/crm/sample-customers", "owner");
  ID.jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "office")).body.properties[0].id;
  const pm = (await call("GET", "/customers?q=prairie", "office")).body.rows[0].id;
  ID.pmProp = (await call("GET", `/customers/${pm}`, "office")).body.properties[0].id;
  today = (await call("GET", "/todos", "owner")).body.today;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("to-dos", () => {
  it("a manager gives one to a tech, tied to a customer's property; the tech is told and sees it", async () => {
    const r = await call("POST", "/todos", "office", {
      title: "Fix the broken sprinkler head", customerId: ID.jane, propertyId: ID.janeProp, date: today, startTime: "08:00", endTime: "09:30",
      budgetedHours: 1.5, color: "#16a34a", assigneeIds: [ID.tech], notes: "Front bed by the driveway",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: "Fix the broken sprinkler head", customer: { name: "Jane Example" }, property: { id: ID.janeProp }, assignees: [{ id: ID.tech }], budgetedHours: 1.5, created: 1, createdBy: "office Person" });
    ID.fix = r.body.id;
    const note = (await inbox("tech")).find((n) => n.title === "New to-do: Fix the broken sprinkler head");
    expect(note).toMatchObject({ category: "todos", link: { screen: "todos", id: ID.fix } });
    expect(note.body).toContain("8:00 AM – 9:30 AM");
    expect(note.body).toContain("Bluestem");
    // The tech sees it (with the address, though they can't open customers) and it counts as due.
    const mine = (await call("GET", "/todos?mine=true", "tech")).body.items;
    expect(mine.map((t: any) => t.id)).toEqual([ID.fix]);
    expect(mine[0].property.address).toContain("Bluestem");
    expect((await call("GET", "/todos/count", "tech")).body.due).toBe(1);
    // Someone else on the crew doesn't.
    expect((await call("GET", `/todos/${ID.fix}`, "other")).status).toBe(404);
    expect((await call("GET", "/todos", "other")).body.items).toEqual([]);
    // The office sees everything.
    expect((await call("GET", "/todos", "owner")).body.items.map((t: any) => t.id)).toContain(ID.fix);
  });

  it("without manager access you make to-dos for yourself only, without customers", async () => {
    expect((await call("POST", "/todos", "tech", { title: "Order more flags", date: today, assigneeIds: [ID.other] })).status).toBe(403);
    expect((await call("POST", "/todos", "tech", { title: "Check Jane's gate", date: today, customerId: ID.jane })).body.error).toMatch(/Customers & billing/);
    const own = await call("POST", "/todos", "tech", { title: "Order more flags", date: plus(today, 2) });
    expect(own.body.assignees.map((a: any) => a.id)).toEqual([ID.tech]);
    ID.flags = own.body.id;
    // The top bar's list: what's yours through today (the flags are for later).
    expect((await call("GET", "/todos?mine=true&to=today", "tech")).body.items.map((t: any) => t.id)).toEqual([ID.fix]);
    // The tech can change their own, but not the one the office made (only check it off).
    expect((await call("PUT", `/todos/${ID.flags}`, "tech", { title: "Order more marking flags", date: plus(today, 2) })).body.title).toBe("Order more marking flags");
    expect((await call("PUT", `/todos/${ID.fix}`, "tech", { title: "x", date: today })).status).toBe(403);
    expect((await call("DELETE", `/todos/${ID.fix}`, "tech")).status).toBe(403);
  });

  it("checks the link and the form", async () => {
    const wrongProp = await call("POST", "/todos", "office", { title: "Aerate", date: today, customerId: ID.jane, propertyId: ID.pmProp });
    expect(wrongProp.status).toBe(400);
    expect(wrongProp.body.error).toMatch(/isn't one of this customer's/);
    expect((await call("POST", "/todos", "office", { title: "", date: today })).status).toBe(400);
    expect((await call("POST", "/todos", "office", { title: "Aerate", date: today, assigneeIds: ["00000000-0000-4000-8000-000000000000"] })).body.error).toMatch(/isn't on the team/);
  });

  it("checking off and undoing; done ones drop out of the open list", async () => {
    const done = await call("POST", `/todos/${ID.fix}/done`, "tech", { done: true });
    expect(done.body).toMatchObject({ doneBy: "tech Person" });
    expect(done.body.doneAt).toBeTruthy();
    expect((await call("GET", "/todos/count", "tech")).body.due).toBe(0);
    expect((await call("GET", "/todos?mine=true", "tech")).body.items.map((t: any) => t.id)).toEqual([ID.flags]);
    expect((await call("GET", "/todos?mine=true&status=done", "tech")).body.items.map((t: any) => t.id)).toEqual([ID.fix]);
    expect((await call("POST", `/todos/${ID.fix}/done`, "tech", { done: false })).body.doneAt).toBeNull();
    await call("POST", `/todos/${ID.fix}/done`, "tech", { done: true });
    // Customer and property pages list theirs.
    expect((await call("GET", `/todos?customerId=${ID.jane}&status=all`, "office")).body.items.map((t: any) => t.id)).toEqual([ID.fix]);
    expect((await call("GET", `/todos?propertyId=${ID.janeProp}&status=all`, "office")).body.items.map((t: any) => t.id)).toEqual([ID.fix]);
  });

  it("repeating to-dos: one per date; change or delete this and later ones", async () => {
    const r = await call("POST", "/todos", "office", { title: "Fuel up the trucks", date: today, repeat: "weekly", repeatUntil: plus(today, 28), assigneeIds: [ID.tech] });
    expect(r.body.created).toBe(5);
    expect((await inbox("tech")).filter((n) => n.title === "New to-do: Fuel up the trucks")).toHaveLength(1);
    const series = (await call("GET", "/todos?q=fuel%20up", "office")).body.items;
    expect(series.map((t: any) => t.date)).toEqual([0, 7, 14, 21, 28].map((n) => plus(today, n)));
    expect(new Set(series.map((t: any) => t.seriesId)).size).toBe(1);
    await call("POST", `/todos/${series[0].id}/done`, "tech");
    expect((await call("GET", `/todos/${series[1].id}`, "office")).body.seriesLeft).toBe(4);

    // From the 3rd on: give it to the other tech and move it a day later.
    const moved = await call("PUT", `/todos/${series[2].id}?applyTo=following`, "office", { title: "Fuel up the trucks", date: plus(today, 15), assigneeIds: [ID.other] });
    expect(moved.body.changed).toBe(3);
    const after = (await call("GET", "/todos?q=fuel%20up&status=all", "office")).body.items;
    expect(after.map((t: any) => `${t.date}:${t.assignees[0].id === ID.other ? "other" : "tech"}`).sort()).toEqual(
      [`${plus(today, 0)}:tech`, `${plus(today, 7)}:tech`, `${plus(today, 15)}:other`, `${plus(today, 22)}:other`, `${plus(today, 29)}:other`].sort(),
    );
    expect((await inbox("other")).find((n) => n.title === "New to-do: Fuel up the trucks")?.body).toContain("and 2 later");

    // Delete from the 2nd on: the done first one stays.
    expect((await call("DELETE", `/todos/${series[1].id}?scope=following`, "office")).body.deleted).toBe(4);
    expect((await call("GET", "/todos?q=fuel%20up&status=all", "office")).body.items.map((t: any) => t.id)).toEqual([series[0].id]);
  });

  it("reminds the people a to-do is for the morning it starts, once", async () => {
    const r = await call("POST", "/todos", "office", { title: "Walk the Elm St job", date: plus(today, 1), startTime: "13:00", location: "215 Elm St", assigneeIds: [ID.tech, ID.other] });
    const morning = new Date(`${plus(today, 1)}T14:30:00Z`); // 8:30 AM Central
    const early = new Date(`${plus(today, 1)}T11:00:00Z`); // 5 or 6 AM Central: too early
    await todoReminders(early);
    expect((await inbox("tech")).filter((n) => n.title === "To-do today: Walk the Elm St job")).toHaveLength(0);
    await todoReminders(morning);
    await todoReminders(new Date(morning.getTime() + 3_600_000));
    for (const who of ["tech", "other"]) {
      const got = (await inbox(who)).filter((n) => n.title === "To-do today: Walk the Elm St job");
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ body: "1:00 PM · 215 Elm St", link: { screen: "todos", id: r.body.id } });
    }
  });

  it("search finds the to-dos you can see", async () => {
    const hit = (who: string) => call("GET", "/search?q=sprinkler", who).then((r) => r.body.results.filter((h: any) => h.kind === "todo"));
    expect(await hit("owner")).toEqual([expect.objectContaining({ title: "Fix the broken sprinkler head", href: `/todos?open=${ID.fix}` })]);
    expect(await hit("tech")).toHaveLength(1);
    expect(await hit("other")).toEqual([]);
  });
});
