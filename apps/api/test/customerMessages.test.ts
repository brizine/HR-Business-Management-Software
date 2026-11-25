/** Emails to many customers: who gets it and who's skipped, fill-in fields, sending in the background, stopping, unsubscribing, phone numbers. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { drainCustomerMessages, setMessageGap, setMessageQueueScope } from "../src/lib/customerMessages";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@cmsg.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
let failFor: string | null = null;

async function call(method: string, url: string, who: string | null, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { if (failFor && m.to === failFor) throw new Error("Mailbox full"); sent.push(m); } });
  setMessageGap(0);
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Lawn Pros", firstName: "Lee", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  // Other test files use the same email queue: this one sends only its own company's emails.
  setMessageQueueScope((await pool.query("select company_id from employees where email = $1", [email("owner")])).rows.map((r) => r.company_id));
  await call("PUT", "/company", "owner", { name: "Lawn Pros", phone: "(405) 555-0100", email: "office@cmsg.test", addressLine1: "1 Main St", city: "Norman", state: "OK", zip: "73069", timezone: "America/Chicago" });
  ID.office = (await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" })).body.id;
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  ID.crew = (await call("POST", "/employees", "owner", { firstName: "Cal", lastName: "Crew", email: email("crew"), password: "password123", role: "employee" })).body.id;
  T.crew = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("crew"), password: "password123" } })).json().token;
  const mk = async (body: Record<string, unknown>) => (await call("POST", "/customers", "office", body)).body.id as string;
  ID.ann = await mk({ firstName: "Ann", lastName: "Apple", email: "ann@example.com", phone: "405-555-0101" });
  ID.bob = await mk({ firstName: "Bob", lastName: "Berry", email: "bob@example.com", phone: "(405) 555-0202" });
  ID.hoa = await mk({ kind: "hoa", companyName: "Cedar Park HOA", email: "ANN@example.com", phone: "4055550101" });
  ID.dan = await mk({ firstName: "Dan", lastName: "Dee", delivery: ["paper"], billingStreet: "4 Pine St" });
  ID.eve = await mk({ firstName: "Eve", lastName: "Evans", email: "eve@example.com", status: "lead" });
  // Ann owes $120.
  const inv = await call("POST", "/invoices", "office", { customerId: ID.ann, lines: [{ description: "Service", quantity: 1, unitPriceCents: 12000, incomeAccountCode: "4000" }] });
  await call("POST", `/invoices/${inv.body.id}/send`, "office", { via: ["paper"] });
  sent.length = 0;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

const everyone = { match: { status: "all", filters: [] } };

describe("customer emails", () => {
  it("only managers in Customers & billing", async () => {
    expect((await call("POST", "/customer-messages/preview", "crew", everyone)).status).toBe(403);
  });

  it("preview: counts, skips (no email, duplicate address) and the first customer's email filled in", async () => {
    const r = await call("POST", "/customer-messages/preview", "office", { ...everyone, subject: "Hi {first_name}", body: "You owe {balance}. Call {company_phone}. {oops}" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 5, sending: 3, emailReady: true });
    expect(Object.fromEntries(r.body.skipped.map((s: any) => [s.reason, s.n]))).toEqual({ no_email: 1, duplicate: 1 });
    expect(r.body.sample.name).toBe("Ann Apple");
    expect(r.body.sample.subject).toBe("Hi Ann");
    expect(r.body.sample.text).toContain("You owe $120.00. Call (405) 555-0100. {oops}");
    expect(r.body.sample.text).toContain("Lawn Pros · 1 Main St, Norman, OK 73069 · (405) 555-0100");
  });

  it("test email goes to the person sending, filled in for the first customer", async () => {
    const r = await call("POST", "/customer-messages/test", "office", { ids: [ID.bob], subject: "Hello {name}", body: "Next visit: {next_service}" });
    expect(r.body).toEqual({ to: email("office") });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: email("office"), subject: "[Test] Hello Bob Berry", fromName: "Lawn Pros" });
    expect(sent[0].text).toContain("Next visit: not scheduled yet");
    sent.length = 0;
  });

  it("sends in the background, one email each, with an unsubscribe link and header; a failure is recorded", async () => {
    expect((await call("POST", "/customer-messages", "office", { ...everyone, subject: "", body: "x" })).status).toBe(400);
    failFor = "bob@example.com";
    const r = await call("POST", "/customer-messages", "office", { ...everyone, subject: "Spring is here, {first_name}", body: "Hello {first_name},\n\nWe start soon.", audience: "All" });
    expect(r.status).toBe(200);
    ID.msg = r.body.id;
    await drainCustomerMessages();
    failFor = null;
    expect(sent.map((m) => m.to).sort()).toEqual(["ann@example.com", "eve@example.com"]);
    const ann = sent.find((m) => m.to === "ann@example.com")!;
    expect(ann.subject).toBe("Spring is here, Ann");
    expect(ann.html).toContain("<p>Hello Ann,</p>");
    expect(ann.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    ID.unsub = decodeURIComponent(ann.text.match(/unsubscribe\?customer=(\S+)/)![1]);
    const m = await call("GET", `/customer-messages/${ID.msg}`, "office");
    expect(m.body).toMatchObject({ status: "sent", audience: "All", byName: "Olive Office" });
    expect(m.body.counts).toMatchObject({ total: 5, sent: 2, failed: 1, skipped: 2 });
    expect(m.body.recipients[0]).toMatchObject({ name: "Bob Berry", status: "failed", error: "Mailbox full" });
    const list = await call("GET", "/customer-messages", "office");
    expect(list.body.rows[0]).toMatchObject({ id: ID.msg, counts: { sent: 2 } });
    const mine = await call("GET", `/customer-messages/customer/${ID.ann}`, "office");
    expect(mine.body.messages[0]).toMatchObject({ subject: "Spring is here, {first_name}", status: "sent" });
  });

  it("unsubscribe link: no sign-in, then they're skipped; the office can put them back", async () => {
    expect((await call("POST", "/public/unsubscribe/customer?token=nope.nope", null)).status).toBe(400);
    const r = await call("POST", `/public/unsubscribe/customer?token=${encodeURIComponent(ID.unsub)}`, null);
    expect(r.body).toMatchObject({ ok: true, company: "Lawn Pros", email: "ann@example.com" });
    const p = await call("POST", "/customer-messages/preview", "office", everyone);
    // Ann is out; the HOA (same address, but its own customer) now gets it instead of being a duplicate.
    expect(Object.fromEntries(p.body.skipped.map((s: any) => [s.reason, s.n]))).toEqual({ no_email: 1, unsubscribed: 1 });
    const f = await call("GET", `/customers?status=all&filters=${encodeURIComponent(JSON.stringify([{ f: "emailOptOut", op: "yes" }]))}`, "office");
    expect(f.body.rows.map((c: any) => c.name)).toEqual(["Ann Apple"]);
    expect((await call("GET", `/customer-messages/customer/${ID.ann}`, "office")).body.emailOptOutAt).toBeTruthy();
    await call("POST", `/customer-messages/customer/${ID.ann}/resubscribe`, "office");
    expect((await call("GET", `/customer-messages/customer/${ID.ann}`, "office")).body.emailOptOutAt).toBeNull();
  });

  it("stop: customers not reached yet are skipped", async () => {
    sent.length = 0;
    const r = await call("POST", "/customer-messages", "office", { ids: [ID.ann, ID.bob, ID.eve], subject: "Rain delay", body: "Sorry {first_name}" });
    expect((await call("POST", `/customer-messages/${r.body.id}/stop`, "office")).status).toBe(200);
    await drainCustomerMessages();
    const m = await call("GET", `/customer-messages/${r.body.id}`, "office");
    expect(m.body.status).toBe("stopped");
    expect(m.body.counts.sent + m.body.counts.skipped).toBe(3);
    expect((await call("POST", `/customer-messages/${r.body.id}/stop`, "office")).status).toBe(400);
  });

  it("phone numbers for texting: one per number, counting the customers with none", async () => {
    const r = await call("POST", "/customer-messages/phones", "office", everyone);
    expect(r.body.phones).toEqual([{ name: "Ann Apple", phone: "(405) 555-0101" }, { name: "Bob Berry", phone: "(405) 555-0202" }]);
    expect(r.body).toMatchObject({ missing: 2, sample: 0 });
  });
});
