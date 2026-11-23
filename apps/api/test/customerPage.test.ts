/** The customer page: call notes (notify, follow-up to-do), files, stats and revenue projection, payments by month, timeline, and the customer's invoice defaults. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@cpage.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(method: string, url: string, who: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}`, ...headers } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body, headers: res.headers };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async () => {} });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Page Co", firstName: "Pat", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Page Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@cpage.test", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["sam", "manager"], ["crew", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  const c = await call("POST", "/customers", "office", {
    firstName: "Ann", lastName: "Apple", email: email("ann"), title: "Mrs.", county: "Cleveland", discountPercent: 10, termsDays: 30, invoiceNotes: "Gate code 1234",
    property: { street: "1 Oak St", city: "Norman", zip: "73069" },
  });
  ID.ann = c.body.id;
  ID.prop = (await call("GET", `/customers/${ID.ann}`, "office")).body.properties[0].id;
});

afterAll(async () => {
  setEmailTransport(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("customer page", () => {
  it("keeps the new fields; new invoices use the customer's days to pay and notes; work orders also get the discount", async () => {
    const c = (await call("GET", `/customers/${ID.ann}`, "office")).body;
    expect(c).toMatchObject({ title: "Mrs.", county: "Cleveland", discountPercent: 10, termsDays: 30, invoiceNotes: "Gate code 1234" });
    const inv = await call("POST", "/invoices", "office", { customerId: ID.ann, issueDate: today, lines: [{ description: "Service", quantity: 1, unitPriceCents: 10000 }] });
    expect(inv.body).toMatchObject({ dueDate: plus(today, 30), notes: "Gate code 1234" });
    ID.inv = inv.body.id;
    const wo = await call("POST", "/visits", "office", { title: "Round 1", customerId: ID.ann, propertyId: ID.prop, date: today, lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }] });
    await call("POST", `/visits/${wo.body.id}/complete`, "office", {});
    const made = await call("POST", `/visits/${wo.body.id}/invoice`, "office", {});
    const woInv = (await call("GET", `/invoices/${made.body.invoiceId}`, "office")).body;
    expect(woInv).toMatchObject({ discountKind: "percent", discountValue: 10, totalCents: 4500, dueDate: plus(today, 30) });
    expect(woInv.notes).toContain("Gate code 1234");
  });

  it("call notes: tell someone, link a follow-up to-do; only the writer or an admin removes one", async () => {
    expect((await call("GET", `/customers/${ID.ann}/notes`, "crew")).status).toBe(403);
    expect((await call("POST", `/customers/${ID.ann}/notes`, "office", { body: " " })).status).toBe(400);
    const todo = await call("POST", "/todos", "office", { title: "Call Ann back about aeration", date: plus(today, 2), customerId: ID.ann });
    const n = await call("POST", `/customers/${ID.ann}/notes`, "office", { kind: "call", body: "Wants aeration in the spring", notifyIds: [ID.sam], todoId: todo.body.id });
    expect(n.status).toBe(200);
    await flushNotifications();
    const inbox = (await call("GET", "/notifications", "sam")).body;
    const items = inbox.items ?? inbox;
    expect(items[0]).toMatchObject({ title: expect.stringMatching(/Call note on Ann Apple from office Person/) });
    const list = (await call("GET", `/customers/${ID.ann}/notes`, "office")).body;
    expect(list[0]).toMatchObject({ kind: "call", byName: "office Person", notified: ["sam Person"], todoTitle: "Call Ann back about aeration" });
    expect((await call("DELETE", `/customers/${ID.ann}/notes/${n.body.id}`, "sam")).status).toBe(403);
    const other = await call("POST", `/customers/${ID.ann}/notes`, "sam", { kind: "note", body: "Prefers texts" });
    expect((await call("DELETE", `/customers/${ID.ann}/notes/${other.body.id}`, "owner")).status).toBe(200);
  });

  it("photos and documents: add, list, open, caption, remove", async () => {
    const boundary = "----cpage";
    const pdf = Buffer.from("%PDF-1.4\n%test\n");
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="contract.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), pdf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await call("POST", `/customers/${ID.ann}/files`, "office", payload, { "content-type": `multipart/form-data; boundary=${boundary}` });
    expect(up.status).toBe(200);
    expect((await call("GET", `/customers/${ID.ann}/files`, "office")).body).toMatchObject([{ fileName: "contract.pdf", uploadedBy: "office Person" }]);
    expect((await call("GET", `/customers/${ID.ann}/files/${up.body.id}`, "office")).headers["content-type"]).toMatch(/pdf/);
    expect((await call("PATCH", `/customers/${ID.ann}/files/${up.body.id}`, "office", { caption: "Signed contract" })).body.caption).toBe("Signed contract");
    expect((await call("DELETE", `/customers/${ID.ann}/files/${up.body.id}`, "office")).status).toBe(200);
  });

  it("stats, revenue projection, payments by month, last and next service on the properties", async () => {
    await call("POST", `/invoices/${ID.inv}/send`, "office", { via: ["paper"] });
    await call("POST", `/invoices/${ID.inv}/payments`, "office", { amountCents: 4000, method: "check", reference: "501" });
    await call("POST", "/visits", "office", { title: "Round 2", customerId: ID.ann, propertyId: ID.prop, date: plus(today, 1), lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 6000 }] });
    const s = (await call("GET", `/customers/${ID.ann}/stats`, "office")).body;
    expect(s).toMatchObject({ collectedCents: 4000, visitsDone: 1, averageVisitCents: 5000, lastService: today, nextService: plus(today, 1) });
    expect(s.projection.yearCents).toBeGreaterThanOrEqual(6000);
    expect(s.projection.todayCents).toBe(0);
    const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
    const p = (await call("GET", `/customers/${ID.ann}/payments?year=${year}&month=${month}`, "office")).body;
    expect(p.years).toContain(year);
    expect(p.rows[0]).toMatchObject({ amountCents: 4000, method: "check", reference: "501" });
    expect((await call("GET", `/customers/${ID.ann}/payments?year=${year - 3}`, "office")).body.rows).toEqual([]);
    const prop = (await call("GET", `/customers/${ID.ann}`, "office")).body.properties[0];
    expect(prop).toMatchObject({ lastService: today, nextService: plus(today, 1) });
  });

  it("timeline: newest first, with notes, payments, work done and when they were added; filtered by kind", async () => {
    const t = (await call("GET", `/customers/${ID.ann}/timeline`, "office")).body;
    const titles = t.map((x: any) => x.title);
    expect(titles).toEqual(expect.arrayContaining(["Call note", "Payment $40.00", "WO-1001 done", "Added as a customer"]));
    expect(t.at(-1).title).toBe("Added as a customer");
    const notes = (await call("GET", `/customers/${ID.ann}/timeline?kinds=note`, "office")).body;
    expect(notes.every((x: any) => x.kind === "note")).toBe(true);
  });
});
