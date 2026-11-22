/** Customer credits: adding, using on invoices (by hand and automatically), taking off, voiding, and Bigcapital credit notes (pretend Bigcapital). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ACCOUNTING_SETTINGS } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushBillingSync } from "../src/lib/billingSync";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

/* ── A pretend Bigcapital (with credit notes) ── */
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let failCredits = false;
let nextId = 700;
const ACCOUNTS = [["1020", 1002], ["1030", 1034], ["4000", 1026], ["4200", 1048], ["4900", 1031], ["4950", 1028]].map(([code, id]) => ({ id, code, name: `Acct ${code}`, account_type: "income", active: true }));
const items: { id: number; name: string }[] = [];
const applied: { id: number; creditNoteId: number; invoiceId: number; amount: number }[] = [];
let server: Server;
let baseUrl = "";

function fake() {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\/api/, "").split("?")[0];
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, path, body });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== "Bearer bc_test_key") return send(401, { message: "Unauthorized" });
      const seg = path.split("/");
      if (req.method === "GET" && path.startsWith("/accounts")) return send(200, { accounts: ACCOUNTS });
      if (req.method === "GET" && path.startsWith("/items")) return send(200, { items });
      if (req.method === "POST" && path === "/items") { const id = nextId++; items.push({ id, name: body.name }); return send(200, { id }); }
      if (req.method === "POST" && path === "/customers") return send(201, { id: nextId++ });
      if (req.method === "PUT" && path.startsWith("/customers/")) return send(200, { id: Number(seg[2]) });
      if (path.startsWith("/sale-invoices")) return send(req.method === "POST" ? 201 : 200, { id: req.method === "POST" ? nextId++ : Number(seg[2]) });
      if (path.startsWith("/payments-received")) return send(req.method === "POST" ? 201 : 200, { id: req.method === "POST" ? nextId++ : Number(seg[2]) });
      if (path.startsWith("/credit-notes")) {
        if (failCredits) return send(500, { message: "Bigcapital is restarting" });
        if (req.method === "POST" && path === "/credit-notes") return send(201, { id: nextId++ });
        if (req.method === "POST" && seg[3] === "apply-invoices") {
          for (const e of body.entries) applied.push({ id: nextId++, creditNoteId: Number(seg[2]), invoiceId: e.invoiceId, amount: e.amount });
          return send(200, applied.filter((a) => a.creditNoteId === Number(seg[2])));
        }
        if (req.method === "GET" && seg[3] === "applied-invoices") return send(200, applied.filter((a) => a.creditNoteId === Number(seg[2])).map((a) => ({ id: a.id, invoice_id: a.invoiceId, amount: a.amount })));
        if (req.method === "DELETE" && seg[2] === "applied-invoices") {
          const i = applied.findIndex((a) => a.id === Number(seg[3]));
          if (i < 0) return send(404, { message: "not found" });
          applied.splice(i, 1);
          return send(200, {});
        }
        if (req.method === "DELETE") {
          if (applied.some((a) => a.creditNoteId === Number(seg[2]))) return send(400, { errors: [{ type: "CREDIT_NOTE_HAS_APPLIED_INVOICES" }] });
          return send(200, { id: Number(seg[2]) });
        }
      }
      send(404, { message: `Cannot ${req.method} ${path}` });
    });
  });
}

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@credits.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
const last = (method: string, prefix: string) => [...calls].reverse().find((c) => c.method === method && c.path.startsWith(prefix));
const inv = async (id: string) => (await call("GET", `/invoices/${id}`, "office")).body;
async function sentInvoice(customerId: string, cents: number, propertyId?: string, due = "2026-03-17") {
  const r = await call("POST", "/invoices", "office", { customerId, propertyId, issueDate: "2026-03-02", dueDate: due, lines: [{ description: "Lawn round", quantity: 1, unitPriceCents: cents, incomeAccountCode: "4000" }] });
  expect(r.status).toBe(200);
  expect((await call("POST", `/invoices/${r.body.id}/send`, "office", { via: ["paper"] })).status).toBe(200);
  return r.body.id as string;
}
const addCredit = (body: Record<string, unknown>, who = "office") => call("POST", "/credits", who, { reason: "service_issue", description: "Missed the back yard", ...body });

beforeAll(async () => {
  server = fake();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Credit Co", firstName: "Cy", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Credit Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@credits.test", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  ID.cust = (await call("POST", "/customers", "owner", { firstName: "Pam", lastName: "Manager", email: email("pam"), property: { street: "1 Oak St", city: "Norman", zip: "73069" } })).body.id;
  ID.propA = (await call("GET", `/customers/${ID.cust}`, "owner")).body.properties[0].id;
  ID.propB = (await call("POST", "/properties", "owner", { street: "2 Elm St", city: "Norman", zip: "73069", billToCustomerId: ID.cust })).body.id;
  ID.other = (await call("POST", "/customers", "owner", { firstName: "Oz", lastName: "Other", email: email("oz"), property: { street: "9 Ash St", city: "Norman", zip: "73069" } })).body.id;
  ID.otherProp = (await call("GET", `/customers/${ID.other}`, "owner")).body.properties[0].id;
});

afterAll(async () => {
  setEmailTransport(null);
  await flushBillingSync();
  await app.close();
  await flushNotifications();
  await pool.end();
  server.close();
});

describe("Customer credits", () => {
  it("a credit used on open invoices now goes on the oldest first", async () => {
    ID.i40 = await sentInvoice(ID.cust, 4000, ID.propA, "2026-03-10");
    ID.i60 = await sentInvoice(ID.cust, 6000, ID.propA, "2026-03-20");
    expect((await addCredit({ customerId: ID.cust, amountCents: 5000 }, "tech")).status).toBe(403);
    const r = await addCredit({ customerId: ID.cust, amountCents: 5000, note: "Crew skipped it" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ number: 1, leftCents: 0, appliedCents: 5000, note: "Crew skipped it", reason: "service_issue" });
    expect(r.body.applications.map((a: any) => a.amountCents)).toEqual([4000, 1000]);
    expect(await inv(ID.i40)).toMatchObject({ status: "paid", creditedCents: 4000, balanceCents: 0 });
    const i60 = await inv(ID.i60);
    expect(i60).toMatchObject({ status: "partial", creditedCents: 1000, balanceCents: 5000 });
    expect(i60.credits[0]).toMatchObject({ number: 1, amountCents: 1000, description: "Missed the back yard" });
    const sum = await call("GET", `/invoices/customer-summary/${ID.cust}`, "office");
    expect(sum.body).toMatchObject({ outstandingCents: 5000, creditCents: 0 });
    ID.c1 = r.body.id;
  });

  it("checks the customer, property and amounts", async () => {
    expect((await addCredit({ customerId: ID.cust, propertyId: ID.otherProp, amountCents: 100 })).body.error).toMatch(/isn't one of this customer's/);
    expect((await addCredit({ customerId: ID.cust, amountCents: 0 })).status).toBe(400);
    expect((await addCredit({ customerId: ID.cust, amountCents: 100, description: "" })).status).toBe(400);
    // A specific invoice of another customer: refused, and no credit is left behind.
    const before = (await call("GET", `/credits?customerId=${ID.cust}`, "office")).body.credits.length;
    const oz = await sentInvoice(ID.other, 1000, ID.otherProp);
    expect((await addCredit({ customerId: ID.cust, amountCents: 100, applyTo: oz })).body.error).toMatch(/different customer/);
    expect((await call("GET", `/credits?customerId=${ID.cust}`, "office")).body.credits.length).toBe(before);
    // More than is owed on that invoice.
    expect((await call("POST", `/invoices/${ID.i60}/payments`, "office", { amountCents: 5001, method: "cash" })).body.error).toMatch(/more than the \$50\.00 still owed/);
  });

  it("credit kept on the account goes on the next invoice when it's sent; a property's credit only on that property's", async () => {
    const acct = await addCredit({ customerId: ID.cust, amountCents: 2500, applyTo: "none", reason: "goodwill", description: "Thanks for your patience" });
    expect(acct.body).toMatchObject({ leftCents: 2500, applications: [] });
    const propCredit = await addCredit({ customerId: ID.cust, propertyId: ID.propB, amountCents: 1500, applyTo: "none", description: "Elm St: missed edging" });
    expect((await call("GET", `/credits?customerId=${ID.cust}`, "office")).body.availableCents).toBe(4000);
    // ID.i60 is still open, but "none" keeps it off; the next invoice sent (property A) takes the account credit only.
    const a = await sentInvoice(ID.cust, 3000, ID.propA);
    expect(await inv(a)).toMatchObject({ creditedCents: 2500, balanceCents: 500, status: "partial" });
    const b = await sentInvoice(ID.cust, 1000, ID.propB);
    expect(await inv(b)).toMatchObject({ creditedCents: 1000, balanceCents: 0, status: "paid" });
    const list = (await call("GET", `/credits?customerId=${ID.cust}`, "office")).body;
    expect(list.credits.find((c: any) => c.id === propCredit.body.id)).toMatchObject({ leftCents: 500, property: { address: "2 Elm St, Norman, OK 73069" } });
    expect(list.availableCents).toBe(500);
    // The invoice page offers what's left that fits it.
    expect((await inv(ID.i60)).availableCreditCents).toBe(0);
    ID.acctCredit = acct.body.id; ID.propCredit = propCredit.body.id; ID.a = a;
  });

  it("taking credit off, using it by hand, editing and voiding", async () => {
    const a = await inv(ID.a);
    const appId = a.credits[0].id;
    expect((await call("PUT", `/invoices/${ID.a}`, "office", { customerId: ID.cust, propertyId: ID.propA, issueDate: "2026-03-02", dueDate: "2026-03-17", lines: [{ description: "x", quantity: 1, unitPriceCents: 100 }] })).body.error).toMatch(/Take the credit off first/);
    expect((await call("POST", `/credits/applications/${appId}/remove`, "office")).status).toBe(200);
    expect(await inv(ID.a)).toMatchObject({ creditedCents: 0, balanceCents: 3000, status: "sent" });
    expect((await call("POST", `/credits/${ID.acctCredit}/apply`, "office", { invoiceId: ID.a, amountCents: 2600 })).body.error).toMatch(/Only \$25\.00 of that credit is left/);
    expect((await call("POST", `/credits/${ID.propCredit}/apply`, "office", { invoiceId: ID.a })).body.error).toMatch(/different property/);
    expect((await call("POST", `/credits/${ID.acctCredit}/apply`, "office", { invoiceId: ID.a, amountCents: 1000 })).status).toBe(200);
    expect(await inv(ID.a)).toMatchObject({ creditedCents: 1000, balanceCents: 2000 });
    // Voiding the invoice puts its credit back on the account.
    expect((await call("POST", `/invoices/${ID.a}/void`, "office", { reason: "Wrong property" })).status).toBe(200);
    const list = (await call("GET", `/credits?customerId=${ID.cust}`, "office")).body;
    expect(list.credits.find((c: any) => c.id === ID.acctCredit).leftCents).toBe(2500);
    // Voiding a credit takes it off its invoices; they owe it again.
    expect((await call("POST", `/credits/${ID.c1}/void`, "office", { reason: "Entered twice" })).status).toBe(200);
    expect(await inv(ID.i40)).toMatchObject({ status: "sent", creditedCents: 0, balanceCents: 4000 });
    expect((await call("POST", `/credits/${ID.c1}/apply`, "office", { invoiceId: ID.i40 })).body.error).toMatch(/voided/);
  });

  it("can be turned off for new invoices", async () => {
    const s = (await call("GET", "/invoices/settings", "owner")).body;
    expect(s.autoApplyCredits).toBe(true);
    expect((await call("PUT", "/invoices/settings", "owner", { ...s, autoApplyCredits: false })).status).toBe(200);
    const id = await sentInvoice(ID.cust, 2000, ID.propA);
    expect(await inv(id)).toMatchObject({ creditedCents: 0, availableCreditCents: 2500 });
    await call("PUT", "/invoices/settings", "owner", { ...s, autoApplyCredits: true });
  });
});

describe("Credits in Bigcapital", () => {
  beforeAll(async () => {
    const saved = await call("PUT", "/accounting/settings", "owner", { ...DEFAULT_ACCOUNTING_SETTINGS, enabled: true, baseUrl, apiKey: "bc_test_key" });
    expect(saved.status).toBe(200);
  });

  it("a credit becomes a credit note in 4900, applied to the same invoice; taking it off unapplies it; voiding removes it", async () => {
    const id = await sentInvoice(ID.cust, 8000, ID.propA);
    await flushBillingSync();
    const bcInvoice = Number((await inv(id)).bigcapitalInvoiceId);
    expect(bcInvoice).toBeGreaterThan(0);
    calls.length = 0;
    const c = await addCredit({ customerId: ID.cust, amountCents: 2000, applyTo: id, description: "Missed edging" });
    await flushBillingSync();
    const note = [...calls].reverse().find((x) => x.method === "POST" && x.path === "/credit-notes")!;
    expect(note.body).toMatchObject({ creditNoteNumber: `CR-${c.body.number}`, open: true, entries: [{ rate: 20, quantity: 1, sellAccountId: 1031, description: "Missed edging" }] });
    const apply = calls.find((x) => x.method === "POST" && /apply-invoices$/.test(x.path))!;
    expect(apply.body).toEqual({ entries: [{ invoiceId: bcInvoice, amount: 20 }] });
    const listed = (await call("GET", `/credits?customerId=${ID.cust}`, "office")).body.credits.find((x: any) => x.id === c.body.id);
    expect(listed.books).toMatchObject({ status: "posted" });
    expect(listed.bigcapitalCreditNoteId).toBeTruthy();
    // Off the invoice: unapplied in Bigcapital.
    await call("POST", `/credits/applications/${listed.applications[0].id}/remove`, "office");
    await flushBillingSync();
    expect(last("DELETE", "/credit-notes/applied-invoices/")).toBeTruthy();
    expect(applied.filter((a) => a.invoiceId === bcInvoice)).toEqual([]);
    // Back on, then void: unapplied, then the credit note is deleted.
    await call("POST", `/credits/${c.body.id}/apply`, "office", { invoiceId: id });
    await call("POST", `/credits/${c.body.id}/void`, "office", { reason: "Customer paid in full instead" });
    await flushBillingSync();
    const tail = calls.slice(-6).map((x) => `${x.method} ${x.path.replace(/\d+/g, "#")}`);
    expect(tail).toContain("DELETE /credit-notes/applied-invoices/#");
    expect(tail[tail.length - 1]).toBe("DELETE /credit-notes/#");
  });

  it("a credit that can't reach Bigcapital is recorded and sent on retry; voiding an invoice unapplies its credit first", async () => {
    const id = await sentInvoice(ID.cust, 5000, ID.propA);
    await flushBillingSync();
    failCredits = true;
    const c = await addCredit({ customerId: ID.cust, amountCents: 1000, applyTo: id });
    await flushBillingSync();
    let listed = (await call("GET", `/credits?customerId=${ID.cust}`, "office")).body.credits.find((x: any) => x.id === c.body.id);
    expect(listed.books).toMatchObject({ status: "failed" });
    failCredits = false;
    expect((await call("POST", `/credits/${c.body.id}/sync`, "office")).body.result).toBe("posted");
    listed = (await call("GET", `/credits?customerId=${ID.cust}`, "office")).body.credits.find((x: any) => x.id === c.body.id);
    expect(listed.books).toMatchObject({ status: "posted" });
    calls.length = 0;
    await call("POST", `/invoices/${id}/void`, "office", { reason: "Duplicate" });
    await flushBillingSync();
    const order = calls.filter((x) => x.method === "DELETE").map((x) => x.path.split("/")[1] + (x.path.includes("applied") ? "-applied" : ""));
    expect(order).toEqual(["credit-notes-applied", "sale-invoices"]);
  });
});
