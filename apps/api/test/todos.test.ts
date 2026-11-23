/** To-dos: who sees and changes them, customer links, repeating series, checking off, reminders and search. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { todoReminders } from "../src/lib/jobs";
import { extendTodoSeries } from "../src/routes/todos";
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
    expect(await hit("owner")).toEqual([expect.objectContaining({ title: "Fix the broken sprinkler head", href: `/todos/${ID.fix}` })]);
    expect(await hit("tech")).toHaveLength(1);
    expect(await hit("other")).toEqual([]);
  });
});

const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const boundary = "----todo";
const upload = (who: string, todoId: string, caption?: string) => app.inject({
  method: "POST", url: `/todos/${todoId}/files`,
  payload: Buffer.concat([
    ...(caption ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`)] : []),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shop-door.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]),
  headers: { authorization: `Bearer ${T[who]}`, "content-type": `multipart/form-data; boundary=${boundary}` },
});

describe("to-dos like Homeworks'", () => {
  it("categories: everyone picks, managers keep the list", async () => {
    expect((await call("POST", "/todos/categories", "tech", { name: "Shop" })).status).toBe(403);
    const shop = await call("POST", "/todos/categories", "office", { name: "Shop" });
    expect(shop.body).toMatchObject({ name: "Shop", todoCount: 0 });
    ID.shop = shop.body.id;
    expect((await call("POST", "/todos/categories", "office", { name: "shop" })).body.error).toMatch(/already a category/);
    ID.office = (await call("POST", "/todos/categories", "office", { name: "Office" })).body.id;
    expect((await call("GET", "/todos/categories", "tech")).body.map((c: any) => c.name)).toEqual(["Office", "Shop"]);
    const t = await call("POST", "/todos", "tech", { title: "Sweep the shop", date: today, categoryId: ID.shop });
    expect(t.body.category).toEqual({ id: ID.shop, name: "Shop" });
    expect((await call("GET", `/todos?categoryId=${ID.shop}`, "office")).body.items.map((x: any) => x.title)).toEqual(["Sweep the shop"]);
    expect((await call("GET", "/todos/categories", "office")).body.find((c: any) => c.id === ID.shop).todoCount).toBe(1);
    // Removing a category keeps its to-dos.
    await call("DELETE", `/todos/categories/${ID.office}`, "office");
    expect((await call("POST", "/todos", "office", { title: "x", date: today, categoryId: ID.office })).body.error).toMatch(/category isn't set up/);
  });

  it("repeats like Homeworks': every 2 weeks on Mon and Wed, 4 times", async () => {
    const r = await call("POST", "/todos", "office", {
      title: "Calibrate the sprayers", date: "2027-03-01", assigneeIds: [ID.tech],
      rule: { freq: "weekly", every: 2, weekdays: [1, 3], end: "count", count: 4 },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 4, repeat: "weekly", repeatLabel: "Every 2 weeks on Mon, Wed, 4 times" });
    const all = (await call("GET", "/todos?q=calibrate", "office")).body.items;
    expect(all.map((t: any) => t.date)).toEqual(["2027-03-01", "2027-03-03", "2027-03-15", "2027-03-17"]);
    expect((await inbox("tech")).find((n) => n.title === "New to-do: Calibrate the sprayers")?.body).toContain("every 2 weeks on Mon, Wed, 4 times");
    // The last Friday of every month.
    const m = await call("POST", "/todos", "office", { title: "Month-end inventory", date: "2027-01-01", rule: { freq: "monthly", by: "nth", nth: -1, weekday: 5, end: "count", count: 3 } });
    expect((await call("GET", "/todos?q=month-end", "office")).body.items.map((t: any) => t.date)).toEqual(["2027-01-29", "2027-02-26", "2027-03-26"]);
    expect(m.body.repeatLabel).toBe("The last Friday of every month, 3 times");
  });

  it("off-seasons: saved once, then series pause in them", async () => {
    expect((await call("POST", "/off-seasons", "tech", { name: "Winter", start: "12-01", end: "02-28" })).status).toBe(403);
    expect((await call("POST", "/off-seasons", "office", { name: "Winter", start: "12-01", end: "02-30" })).status).toBe(400);
    const w = await call("POST", "/off-seasons", "office", { name: "Winter", start: "12-01", end: "02-28" });
    expect(w.body).toMatchObject({ name: "Winter", start: "12-01", end: "02-28" });
    expect((await call("GET", "/off-seasons", "tech")).body.map((s: any) => s.name)).toEqual(["Winter"]);
    const r = await call("POST", "/todos", "office", {
      title: "Check the irrigation backflow", date: "2027-11-22", rule: { freq: "weekly", end: "date", until: "2028-03-13", offSeasonId: w.body.id },
    });
    expect(r.body.repeatLabel).toBe("Every week on Mon until Mar 13, 2028 · not during Winter");
    expect((await call("GET", "/todos?q=backflow", "office")).body.items.map((t: any) => t.date)).toEqual(["2027-11-22", "2027-11-29", "2028-03-06", "2028-03-13"]);
    expect((await call("POST", "/todos", "office", { title: "x", date: "2027-12-06", rule: { freq: "weekly", end: "date", until: "2028-01-31", offSeasonId: w.body.id } })).body.error).toMatch(/don't make any to-dos/);
  });

  it("open-ended series are made a year ahead and topped up; deleting this and later stops them", async () => {
    const r = await call("POST", "/todos", "office", {
      title: "Lock the yard gate", date: today, categoryId: ID.shop, assigneeIds: [ID.other], rule: { freq: "daily", end: "never" },
    });
    expect(r.body.created).toBe(367);
    expect(r.body.repeatLabel).toBe("Every day, no end date");
    // 40 days on, the next 40 days are added, copying the latest one.
    expect(await extendTodoSeries(new Date(Date.parse(`${plus(today, 40)}T18:00:00Z`)))).toBeGreaterThanOrEqual(40);
    const later = (await call("GET", `/todos?q=yard%20gate&from=${plus(today, 400)}&limit=500`, "office")).body.items;
    expect(later[0]).toMatchObject({ date: plus(today, 400), category: { name: "Shop" }, assignees: [{ id: ID.other }], seriesId: r.body.seriesId });
    expect(later.at(-1).date).toBe(plus(today, 406));
    // Running it again the same day adds nothing.
    await extendTodoSeries(new Date(Date.parse(`${plus(today, 40)}T19:00:00Z`)));
    expect((await call("GET", `/todos?q=yard%20gate&from=${plus(today, 400)}&limit=500`, "office")).body.items).toHaveLength(7);
    // Stop it from day 10 on: nothing more is made.
    const day10 = (await call("GET", `/todos?q=yard%20gate&from=${plus(today, 10)}&to=${plus(today, 10)}`, "office")).body.items[0];
    expect((await call("GET", `/todos/${day10.id}`, "office")).body.seriesEnd).toBe("never");
    expect((await call("DELETE", `/todos/${day10.id}?scope=following`, "office")).body.deleted).toBe(397);
    await extendTodoSeries(new Date(Date.parse(`${plus(today, 80)}T18:00:00Z`)));
    expect((await call("GET", "/todos?q=yard%20gate&limit=500", "office")).body.items).toHaveLength(10);
  });

  it("a crew: picking it gives the to-do to its people; only managers can", async () => {
    const crew = await call("POST", "/crews", "office", { name: "Shop crew", color: "#0d9488", leadId: ID.tech, memberIds: [ID.other] });
    expect(crew.status).toBe(200);
    expect((await call("POST", "/todos", "tech", { title: "x", date: today, crewId: crew.body.id })).status).toBe(403);
    const t = await call("POST", "/todos", "office", { title: "Clean out the spray tanks", date: today, crewId: crew.body.id });
    expect(t.body.crew).toMatchObject({ id: crew.body.id, name: "Shop crew" });
    expect(t.body.assignees.map((a: any) => a.id).sort()).toEqual([ID.tech, ID.other].sort());
    expect((await call("GET", `/todos?crewId=${crew.body.id}`, "office")).body.items.map((x: any) => x.id)).toEqual([t.body.id]);
    ID.tanks = t.body.id;
  });

  it("notes for the dispatcher: the crew and office write them; whoever made it is told", async () => {
    const n = await call("POST", `/todos/${ID.tanks}/notes`, "tech", { body: "Tank 2 has a cracked lid, need a new one" });
    expect(n.body).toMatchObject({ author: "tech Person", body: "Tank 2 has a cracked lid, need a new one" });
    expect((await inbox("office")).find((x) => x.title === `Note on "Clean out the spray tanks" from tech Person`)).toMatchObject({ link: { screen: "todos", id: ID.tanks } });
    const o = await call("POST", `/todos/${ID.tanks}/notes`, "office", { body: "Ordered, it comes Thursday" });
    expect((await call("GET", `/todos/${ID.tanks}/notes`, "other")).body.map((x: any) => x.body)).toEqual(["Tank 2 has a cracked lid, need a new one", "Ordered, it comes Thursday"]);
    expect((await call("POST", `/todos/${ID.tanks}/notes`, "tech", { body: " " })).status).toBe(400);
    expect((await call("DELETE", `/todos/${ID.tanks}/notes/${o.body.id}`, "tech")).status).toBe(403);
    expect((await call("DELETE", `/todos/${ID.tanks}/notes/${n.body.id}`, "tech")).body.ok).toBe(true);
    expect((await call("GET", `/todos/${ID.tanks}`, "office")).body.noteCount).toBe(1);
  });

  it("work tracking: start, stop, and done stops the timer", async () => {
    const started = await call("POST", `/todos/${ID.tanks}/start`, "tech");
    expect(started.body.startedAt).toBeTruthy();
    // Pretend it started 30 minutes ago.
    await pool.query("update todos set started_at = now() - interval '30 minutes' where id = $1", [ID.tanks]);
    const cal = (await call("GET", `/events?from=${today}&to=${today}`, "office")).body.events.find((e: any) => e.id === ID.tanks);
    expect(cal).toMatchObject({ onSite: true, trackedMinutes: 30, href: `/todos/${ID.tanks}`, crew: { name: "Shop crew" } });
    const stopped = await call("POST", `/todos/${ID.tanks}/stop`, "other");
    expect(stopped.body).toMatchObject({ startedAt: null, trackedMinutes: 30 });
    await call("POST", `/todos/${ID.tanks}/start`, "tech");
    await pool.query("update todos set started_at = now() - interval '15 minutes' where id = $1", [ID.tanks]);
    const done = await call("POST", `/todos/${ID.tanks}/done`, "tech");
    expect(done.body).toMatchObject({ startedAt: null, trackedMinutes: 45, doneBy: "tech Person" });
    expect((await call("POST", `/todos/${ID.tanks}/start`, "tech")).body.error).toMatch(/done/);
    // Someone it isn't for can't.
    expect((await call("POST", `/todos/${ID.flags}/start`, "other")).status).toBe(404);
  });

  it("photos and documents on a to-do", async () => {
    const up = await upload("other", ID.tanks, "Cracked lid");
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ fileName: "shop-door.png", caption: "Cracked lid", contentType: "image/png" });
    const files = (await call("GET", `/todos/${ID.tanks}/files`, "tech")).body;
    expect(files.map((f: any) => f.uploadedBy)).toEqual(["other Person"]);
    const got = await app.inject({ method: "GET", url: `/todos/${ID.tanks}/files/${files[0].id}`, headers: { authorization: `Bearer ${T.tech}` } });
    expect(got.rawPayload.equals(png)).toBe(true);
    expect((await call("GET", `/todos/${ID.tanks}`, "office")).body.fileCount).toBe(1);
    expect((await call("DELETE", `/todos/${ID.tanks}/files/${files[0].id}`, "tech")).status).toBe(403);
    expect((await call("DELETE", `/todos/${ID.tanks}/files/${files[0].id}`, "office")).body.ok).toBe(true);
    // Someone it isn't for can't add one.
    expect((await upload("other", ID.flags)).statusCode).toBe(404);
  });

  it("weekly booked hours for the chart beside the date", async () => {
    const weeks = (await call("GET", `/todos/workload?from=${today}&weeks=5&ids=${ID.tech}`, "office")).body;
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toMatchObject({ start: today, end: plus(today, 6) });
    // The sprinkler fix (1.5 h) is the tech's this week.
    expect(weeks[0].hours).toBeGreaterThanOrEqual(1.5);
    expect((await call("GET", `/todos/workload?from=${today}&weeks=5&ids=${ID.other}`, "office")).body[0].hours).toBe(0);
  });
});
