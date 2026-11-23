/** My Day: account standing, job stats for a range, and the lists. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { flushBillingSync } from "../src/lib/billingSync";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@myday.test`;
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

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Day Co", firstName: "Dee", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Day Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@myday.test", timezone: "America/Chicago" });
  ID.tech = (await call("POST", "/employees", "owner", { firstName: "Tim", lastName: "Tech", email: email("tech"), password: "password123", role: "employee" })).body.id;
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  ID.cust = (await call("POST", "/customers", "owner", { firstName: "Mia", lastName: "May", email: email("mia"), property: { street: "9 Elm St", city: "Norman", zip: "73069" } })).body.id;
  const prop = (await call("GET", `/customers/${ID.cust}`, "owner")).body.properties[0].id;
  const inv = async (cents: number, due: string) => {
    const r = await call("POST", "/invoices", "owner", { customerId: ID.cust, issueDate: plus(due, -15), dueDate: due, lines: [{ description: "Service", quantity: 1, unitPriceCents: cents }] });
    await call("POST", `/invoices/${r.body.id}/send`, "owner", { via: ["paper"] });
    return r.body.id as string;
  };
  ID.late = await inv(10000, plus(today, -5));
  ID.open = await inv(4000, plus(today, 10));
  ID.paid = await inv(2500, plus(today, 10));
  await call("POST", `/invoices/${ID.paid}/payments`, "owner", { amountCents: 2500, method: "check" });
  await call("POST", "/credits", "owner", { customerId: ID.cust, amountCents: 1500, reason: "goodwill", description: "Missed a spot" });
  const visit = async (title: string, date: string) => (await call("POST", "/visits", "owner", { title, customerId: ID.cust, propertyId: prop, date })).body.id as string;
  ID.v1 = await visit("Round 1", today);
  ID.v2 = await visit("Round 2", today);
  await visit("Round 3", plus(today, 3));
  await call("POST", `/visits/${ID.v2}/complete`, "owner", {});
  await call("POST", "/todos", "owner", { title: "Call Mia back", date: today, customerId: ID.cust });
  await call("POST", "/estimates", "owner", { customerId: ID.cust, title: "Aeration", lines: [{ description: "Aeration", quantity: 1, unitPriceCents: 9000 }] });
});

afterAll(async () => {
  await flushBillingSync();
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("My Day", () => {
  it("office managers only", async () => {
    expect((await call("GET", "/my-day", "tech")).status).toBe(403);
  });

  it("today: standing, jobs and the lists", async () => {
    const d = (await call("GET", "/my-day", "owner")).body;
    expect(d).toMatchObject({ today, from: today, to: today });
    // $140 billed less the $15 credit: whatever of it was used on an invoice lowers what's owed; the rest is still credit.
    expect(d.standing.pastDueCents + d.standing.outstandingCents - d.standing.creditCents).toBe(10000 + 4000 - 1500);
    expect(d.standing.pastDueCents).toBeGreaterThan(0);
    expect(d.standing.paidCents).toBe(2500);
    expect(d.jobs).toMatchObject({ total: 2, notStarted: 1, completed: 1, inProgress: 0 });
    expect(d.visits.rows.map((v: any) => v.title).sort()).toEqual(["Round 1", "Round 2"]);
    expect(d.todos.rows[0]).toMatchObject({ title: "Call Mia back", customer: { name: "Mia May" } });
    expect(d.payments[0]).toMatchObject({ amountCents: 2500, method: "check", customer: { name: "Mia May" } });
    expect(d.invoices.some((i: any) => i.id === ID.late && i.overdue)).toBe(true);
    expect(d.estimates[0]).toMatchObject({ title: "Aeration", status: "draft" });
  });

  it("a date range for job stats and money in", async () => {
    const week = (await call("GET", `/my-day?from=${today}&to=${plus(today, 6)}`, "owner")).body;
    expect(week.jobs.total).toBe(3);
    expect((await call("GET", `/my-day?from=${plus(today, 1)}&to=${plus(today, 2)}`, "owner")).body.standing.paidCents).toBe(0);
    expect((await call("GET", "/my-day?from=not-a-date", "owner")).status).toBe(400);
  });
});
